// The Mac app's main process: the collector, running here as it runs in the
// standalone server, and one window that shows the dashboard.
//
// No port is opened. The dashboard and its API are served from the app's own
// scheme, `agent-lookout://app/`, which only this app's window can reach:
// `/api/*` by the collector's handler and every other path from the built
// dashboard, both through `protocol/appProtocol.ts`. The page runs sandboxed,
// with context isolation, no Node and no preload, and may go nowhere but its
// own pages. The packaged app will not start with a switch that would open the
// page to another program (`process/launchSwitches.ts`).
//
// It is a Mac app in the usual way: one copy runs at a time, and opening it
// again brings its window forward; closing the window leaves it running, so
// the collector keeps watching, shows its own notifications and keeps the
// count of sessions that need you on the Dock icon and in the menu bar, whose
// menu lists them and opens one's details; clicking its Dock icon opens the
// window again; Cmd+Q quits, and the collector stops.
//
// It asks the internet one thing: whether GitHub has a newer version of it, at
// start and then about once a day while the switch in Settings is on, or when
// the person chooses Check for Updates…. A newer one is downloaded and checked,
// and installed only when the person presses Install and Restart
// (`updates/updater.ts`). The page reaches that through `/api/app/*` on the
// app's own scheme, which only this host answers (`updates/updateRoute.ts`).
//
// What would otherwise be lost, an error here or a warning from the collector,
// goes to the app's log (`process/appLog.ts`). A startup that fails says so in
// a dialog and quits, rather than leaving an icon in the Dock with no window.
//
// `scripts/build-desktop.mjs` bundles this file into `dist-electron/main.cjs`.

import path from "node:path";

import {
  app,
  dialog,
  Menu,
  nativeImage,
  Notification,
  protocol,
  session,
  shell,
  Tray,
  type NativeImage,
} from "electron";

import { APP_SCHEME, APP_START_URL } from "../core/appAddress.ts";
import { UPDATES_HASH, type InstallRefusal } from "../core/appUpdate.ts";
import { createCollector, type Collector } from "../collector/collector.ts";
import { isQuietAt } from "../core/time-rules/quietHours.ts";
import { appMenuTemplate, GUIDE_URL } from "./menu/appMenu.ts";
import { createMenuBar, type MenuBar } from "./menu-bar/menuBar.ts";
import { menuBarActions } from "./menu-bar/menuBarActions.ts";
import { createMenuBarRoute } from "./menu-bar/menuBarRoute.ts";
import { menuBarSettingsFile } from "./menu-bar/menuBarSettings.ts";
import { applySessionRules } from "./navigation/sessionRules.ts";
import { createDesktopNotifier } from "./notifications/desktopNotifier.ts";
import { createDockBadge } from "./notifications/dockBadge.ts";
import { createAppLog, describeError, LOG_FILE } from "./process/appLog.ts";
import { refusedSwitch } from "./process/launchSwitches.ts";
import { createAppProtocolHandler } from "./protocol/appProtocol.ts";
import { createAppRoutes } from "./protocol/appRoutes.ts";
import { bundleOf } from "./updates/install/installLocation.ts";
import { foundNotice, updateDialog } from "./updates/updateDialog.ts";
import { createQuietNotice } from "./updates/quietNotice.ts";
import { createUpdateRoute } from "./updates/updateRoute.ts";
import { settingsFile } from "./updates/updateSettings.ts";
import { createUpdater, type Updater } from "./updates/updater.ts";
import { createMainWindow } from "./window/mainWindow.ts";
import { createWindowShower } from "./window/windowShower.ts";

/** The dashboard's Settings view, which the app menu's Settings… opens. */
const SETTINGS_URL = `${APP_START_URL}#settings`;

/** The Settings view, scrolled to its Updates card. */
const UPDATES_URL = `${APP_START_URL}${UPDATES_HASH}`;

const log = createAppLog({
  dir: () => app.getPath("logs"),
  // A development run prints each entry in the terminal it was started from.
  echo: app.isPackaged ? undefined : (text) => console.error(text),
});

process.on("uncaughtException", (error) => {
  log(`An error in the main process was not caught: ${describeError(error)}`);
});
process.on("unhandledRejection", (reason) => {
  log(`A promise in the main process failed and nothing handled it: ${describeError(reason)}`);
});

/** A line that says where the log is, for a dialog, or nothing when that is not known. */
function whereTheLogIs(): string {
  try {
    return `\n\nThe details are in ${path.join(app.getPath("logs"), LOG_FILE)}.`;
  } catch {
    return "";
  }
}

let collector: Collector | null = null;
let updater: Updater | null = null;
let menuBar: MenuBar | null = null;

/** Notifications the app has shown of its own, held so a click on one is still heard. */
const shownNotices: Notification[] = [];

/** Whether Check for Updates…, with the window closed, waits for an answer or shows one. */
let answering = false;

/** The app's one window, made again when it was closed. */
const windows = createWindowShower({
  ready: () => app.isReady(),
  create: (address) =>
    createMainWindow({
      userDataDir: app.getPath("userData"),
      devTools: !app.isPackaged,
      startUrl: address,
    }),
});

/**
 * Brings the window forward, making it again if it was closed. With an
 * address of the app's own, the window shows that page.
 */
function showWindow(address?: string): void {
  windows.show(address);
}

/**
 * The lamp for the menu bar, from the template images `scripts/build-desktop.mjs`
 * copies beside the main process: each at 1x and, from its `@2x` file, at 2x.
 * macOS paints a template image in the menu bar's own colour.
 */
function menuBarIcon(name: "quiet" | "lit"): NativeImage {
  const icon = nativeImage.createFromPath(
    path.join(app.getAppPath(), "menu-bar", `${name}Template.png`),
  );
  if (icon.isEmpty()) log(`The menu bar's ${name} icon could not be read.`);
  icon.setTemplateImage(true);
  return icon;
}

function openOutside(url: string): void {
  shell.openExternal(url).catch(() => {
    // Nothing on this machine opens it. There is nobody to tell.
  });
}

/** Tells the person, once for each version, that the daily check found one. */
function noticeFound(version: string, refusal: InstallRefusal | null): void {
  try {
    if (!Notification.isSupported()) return;
    const notice = new Notification(foundNotice(version, refusal));
    notice.on("click", () => showWindow(UPDATES_URL));
    shownNotices.push(notice);
    if (shownNotices.length > 5) shownNotices.shift();
    notice.show();
  } catch {
    // Not shown. Settings says it all the same.
  }
}

/** The notice of a version found, held through quiet hours as every notification is. */
const foundNotices = createQuietNotice<{ version: string; refusal: InstallRefusal | null }>({
  isQuiet: () =>
    collector !== null && isQuietAt(collector.settings.timeRules().quietHours, Date.now()),
  show: ({ version, refusal }) => noticeFound(version, refusal),
});

/**
 * Check for Updates… in the app menu. With the window open, it shows the
 * Updates card in Settings, which shows the answer. With it closed, the answer
 * comes in a dialog, which can install a version that is ready. Chosen again
 * while that answer is on its way or shown, it does nothing, so two dialogs
 * never stack.
 */
function checkForUpdates(): void {
  const updates = updater;
  if (updates === null) return;
  if (windows.current() !== null) {
    showWindow(UPDATES_URL);
    void updates.check();
    return;
  }
  if (answering) return;
  answering = true;
  void updates
    .check()
    .then(async (status) => {
      const words = updateDialog(status);
      const { response } = await dialog.showMessageBox({
        type: "info",
        message: words.message,
        detail: words.detail,
        buttons: words.buttons.map((button) => button.label),
        defaultId: 0,
        cancelId: words.buttons.length - 1,
      });
      const choice = words.buttons[response]?.choice;
      if (choice === "install") {
        const installed = await updates.install();
        if (!installed.ok) showWindow(UPDATES_URL);
      } else if (choice === "settings") {
        showWindow(UPDATES_URL);
      } else if (choice === "release") {
        openOutside(words.releaseUrl);
      }
    })
    .catch((error: unknown) => {
      log(`Check for Updates… did not work: ${describeError(error)}`);
    })
    .finally(() => {
      answering = false;
    });
}

function start(): void {
  // Every page in a sandbox, and the app's scheme treated as a secure origin of
  // its own that `fetch` can reach, both before the app is ready, as Electron
  // requires. It is not open to other origins: CORS stays off.
  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
    },
  ]);

  // Opening the app again, from the Finder, the Dock or a terminal, starts a
  // second copy that finds this one running and quits. This one shows its window.
  app.on("second-instance", () => showWindow());
  // A click on the Dock icon, or opening the app while it runs with no window.
  app.on("activate", () => showWindow());
  // Closing the window leaves the app running, as Mac apps do.
  app.on("window-all-closed", () => {
    // Nothing to do: the collector runs on, and the Dock icon opens the window again.
  });
  app.on("will-quit", () => {
    collector?.stop();
    collector = null;
    updater?.stop();
    menuBar?.stop();
  });

  app
    .whenReady()
    .then(() => {
      app.setAboutPanelOptions({
        applicationName: "Agent Lookout",
        applicationVersion: app.getVersion(),
        // Left empty, About shows the version once, not again in brackets.
        version: "",
        copyright: "Copyright © 2026 Idris Olubisi. MIT License.",
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(
          appMenuTemplate({
            development: !app.isPackaged,
            openSettings: () => showWindow(SETTINGS_URL),
            checkForUpdates,
            openGuide: () => openOutside(GUIDE_URL),
          }),
        ),
      );
      applySessionRules(session.defaultSession);

      // Built the way every host builds it, so every feature the standalone
      // server has, the app has. Its own notifications are the app's, and its
      // warnings go to the app's log.
      const badge = createDockBadge((text) => app.dock?.setBadge(text));
      // The count in the menu bar, and the sessions in its menu, each one
      // opening its details. Show in menu bar, in Settings, takes it away.
      const bar = createMenuBar({
        icons: { quiet: menuBarIcon("quiet"), lit: menuBarIcon("lit") },
        makeTray: (image) => new Tray(image),
        buildMenu: (template) => Menu.buildFromTemplate(template),
        actions: menuBarActions({
          showWindow,
          activate: () => app.focus({ steal: true }),
          checkForUpdates,
          openSettings: () => showWindow(SETTINGS_URL),
          quit: () => app.quit(),
        }),
        settings: menuBarSettingsFile(app.getPath("userData")),
        warn: log,
      });
      menuBar = bar;
      collector = createCollector({
        version: app.getVersion(),
        env: process.env,
        notifier: createDesktopNotifier({ onClick: () => showWindow(), warn: log }),
        warn: log,
        // Each is told on its own, so one that fails leaves the other right.
        onSnapshot: (snapshot) => {
          try {
            badge(snapshot);
          } catch {
            // Tried again on the next poll.
          }
          // It never throws: the notice is shown inside a try of its own.
          foundNotices.quietNow(snapshot.quiet === true);
          bar.update(snapshot);
        },
      });
      // The one thing the app asks the internet: whether GitHub has a newer
      // version of it, about once a day while the switch in Settings is on.
      updater = createUpdater({
        version: app.getVersion(),
        // An Intel copy on Apple silicon moves to the Apple silicon build.
        arch: process.arch === "arm64" || app.runningUnderARM64Translation ? "arm64" : "x64",
        packaged: app.isPackaged,
        bundle: bundleOf(app.getPath("exe")),
        settings: settingsFile(app.getPath("userData")),
        tempDir: app.getPath("temp"),
        onFound: (version, refusal) => foundNotices.found({ version, refusal }),
        quit: () => app.quit(),
        warn: log,
      });
      protocol.handle(
        APP_SCHEME,
        createAppProtocolHandler({
          api: collector.handler,
          app: createAppRoutes({
            update: createUpdateRoute(updater),
            menuBar: createMenuBarRoute(bar),
          }),
          distDir: path.join(app.getAppPath(), "dist"),
        }),
      );
      collector.start();
      updater.start();
      bar.start();
      // An update that could not be installed opens on the card that says why.
      const { update } = updater.status();
      showWindow(update.phase === "failed" && update.step === "install" ? UPDATES_URL : undefined);
    })
    .catch((error: unknown) => {
      log(`Agent Lookout could not start: ${describeError(error)}`);
      dialog.showErrorBox("Agent Lookout could not start", `${String(error)}${whereTheLogIs()}`);
      app.exit(1);
    });
}

const refused = refusedSwitch((name) => app.commandLine.hasSwitch(name), app.isPackaged);
if (refused !== null) {
  log(
    `Agent Lookout does not start with --${refused}, which would open its page to other programs.`,
  );
  app.exit(1);
} else if (app.requestSingleInstanceLock()) {
  start();
} else {
  app.quit();
}
