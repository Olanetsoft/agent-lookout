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
// count of sessions that need you on the Dock icon; clicking its Dock icon
// opens the window again; Cmd+Q quits, and the collector stops.
//
// What would otherwise be lost, an error here or a warning from the collector,
// goes to the app's log (`process/appLog.ts`). A startup that fails says so in
// a dialog and quits, rather than leaving an icon in the Dock with no window.
//
// `scripts/build-desktop.mjs` bundles this file into `dist-electron/main.cjs`.

import path from "node:path";

import { app, dialog, Menu, protocol, session, shell, type BrowserWindow } from "electron";

import { APP_SCHEME, APP_START_URL } from "../core/appAddress.ts";
import { createCollector, type Collector } from "../collector/collector.ts";
import { appMenuTemplate, GUIDE_URL } from "./menu/appMenu.ts";
import { applySessionRules } from "./navigation/sessionRules.ts";
import { createDesktopNotifier } from "./notifications/desktopNotifier.ts";
import { createDockBadge } from "./notifications/dockBadge.ts";
import { createAppLog, describeError, LOG_FILE } from "./process/appLog.ts";
import { refusedSwitch } from "./process/launchSwitches.ts";
import { createAppProtocolHandler } from "./protocol/appProtocol.ts";
import { createMainWindow } from "./window/mainWindow.ts";

/** The dashboard's Settings view, which the app menu's Settings… opens. */
const SETTINGS_URL = `${APP_START_URL}#settings`;

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

let window: BrowserWindow | null = null;
let collector: Collector | null = null;

/**
 * Brings the window forward, making it again if it was closed. With an
 * address of the app's own, the window shows that page.
 */
function showWindow(address?: string): void {
  if (!app.isReady()) return;
  if (window === null || window.isDestroyed()) {
    window = createMainWindow({
      userDataDir: app.getPath("userData"),
      devTools: !app.isPackaged,
      startUrl: address,
    });
    window.on("closed", () => {
      window = null;
    });
    return;
  }
  if (address !== undefined) {
    // Only the address's fragment differs, so the page changes view without loading again.
    window.loadURL(address).catch(() => {
      // The page stays where it was.
    });
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
            openGuide: () => {
              shell.openExternal(GUIDE_URL).catch(() => {
                // Nothing on this machine opens it. There is nobody to tell.
              });
            },
          }),
        ),
      );
      applySessionRules(session.defaultSession);

      // Built the way every host builds it, so every feature the standalone
      // server has, the app has. Its own notifications are the app's, and its
      // warnings go to the app's log.
      const badge = createDockBadge((text) => app.dock?.setBadge(text));
      collector = createCollector({
        version: app.getVersion(),
        env: process.env,
        notifier: createDesktopNotifier({ onClick: () => showWindow(), warn: log }),
        warn: log,
        onSnapshot: badge,
      });
      protocol.handle(
        APP_SCHEME,
        createAppProtocolHandler({
          api: collector.handler,
          distDir: path.join(app.getAppPath(), "dist"),
        }),
      );
      collector.start();
      showWindow();
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
