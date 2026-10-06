// The app's one window: the dashboard, with no title bar, its buttons on the
// rail, and nothing in it but the app's own pages.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, Menu, screen, shell } from "electron";

import { APP_START_URL } from "../../core/appAddress.ts";
import { contextMenuTemplate } from "../menu/contextMenu.ts";
import { guardNavigation } from "../navigation/windowRules.ts";
import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  NIGHT_GROUND,
  macosMajorVersion,
  windowButtonPosition,
} from "./windowFrame.ts";
import {
  placeWindow,
  readColour,
  readWindowState,
  WINDOW_STATE_FILE,
  writeWindowState,
  type WindowState,
} from "./windowState.ts";

export interface MainWindowOptions {
  /** The app's own folder of user data, where the window's state is kept. */
  userDataDir: string;
  /** Whether the developer tools may open: in development only. */
  devTools: boolean;
  /** The app's page to open first, such as the Settings view. Defaults to the dashboard's start. */
  startUrl?: string;
}

/**
 * How long the window waits for the page to paint before it is shown anyway.
 * A page that never paints, because it failed to load or its process died,
 * still leaves a window to come back to, not an app with none.
 */
const SHOW_AT_THE_LATEST_MS = 3000;

/**
 * The least time between two reloads after the page's process died, so a page
 * that dies each time it loads is not loaded again for ever.
 */
const RELOAD_GAP_MS = 10_000;

/**
 * What the window tells the page when it enters and leaves full screen, where
 * macOS hides its three buttons: `data-fullscreen` on `<html>`, which the
 * stylesheet reads to drop the rail's cell for them. Each is a fixed line, and
 * nothing from the page is ever put in one.
 */
const FULL_SCREEN_SAYS = {
  on: 'document.documentElement.dataset.fullscreen = "";',
  off: "delete document.documentElement.dataset.fullscreen;",
} as const;

function readStateFile(file: string): WindowState {
  try {
    return readWindowState(readFileSync(file, "utf8"));
  } catch {
    return readWindowState(null);
  }
}

function writeStateFile(file: string, state: WindowState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, writeWindowState(state), "utf8");
  } catch {
    // Not remembered. The window opens at the default size next time.
  }
}

/**
 * Makes the window and starts loading the dashboard in it. It is shown once the
 * page has painted, so no empty frame is ever seen, and before that its colour
 * is the ground of the theme it last showed. A page that fails to load is shown
 * all the same, and one whose process dies is loaded again.
 *
 * Its size and place are remembered when it closes, and the colour whenever the
 * page changes theme, in a small file in the app's folder of user data.
 */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const file = path.join(options.userDataDir, WINDOW_STATE_FILE);
  const saved = readStateFile(file);
  const placed = placeWindow(
    saved.bounds,
    screen.getAllDisplays().map((display) => display.workArea),
  );

  const window = new BrowserWindow({
    ...(placed ?? DEFAULT_WINDOW_SIZE),
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
    title: "Agent Lookout",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: windowButtonPosition(macosMajorVersion(process.getSystemVersion())),
    backgroundColor: saved.background ?? NIGHT_GROUND,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: options.devTools,
    },
  });
  if (saved.maximized) window.maximize();

  const contents = window.webContents;
  guardNavigation(contents, (url) => shell.openExternal(url));

  // A right-click offers Cut, Copy and Paste where they can be done.
  contents.on("context-menu", (_event, place) => {
    const template = contextMenuTemplate(place);
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window });
  });

  // Shown once the page has painted, or after a few seconds whatever happened.
  let shown = false;
  const show = (): void => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.show();
  };
  window.once("ready-to-show", show);
  const showAnyway = setTimeout(show, SHOW_AT_THE_LATEST_MS);
  window.on("closed", () => clearTimeout(showAnyway));
  // -3 is a load that was given up for another, which still paints.
  contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) show();
  });

  // A page whose process died is loaded again, not left as a blank window.
  let reloadedAt = -Infinity;
  contents.on("render-process-gone", (_event, details) => {
    if (window.isDestroyed() || details.reason === "clean-exit") return;
    if (Date.now() - reloadedAt < RELOAD_GAP_MS) return;
    reloadedAt = Date.now();
    contents.reload();
  });

  const sayFullScreen = (on: boolean): void => {
    contents.executeJavaScript(on ? FULL_SCREEN_SAYS.on : FULL_SCREEN_SAYS.off).catch(() => {
      // The page is not there to tell. It is told again when it loads.
    });
  };
  window.on("enter-full-screen", () => sayFullScreen(true));
  window.on("leave-full-screen", () => sayFullScreen(false));
  contents.on("did-finish-load", () => {
    if (window.isFullScreen()) sayFullScreen(true);
  });

  let state: WindowState = saved;
  contents.on("did-change-theme-color", (_event, color) => {
    const background = readColour(color);
    if (background === null || background === state.background) return;
    state = { ...state, background };
    window.setBackgroundColor(background);
  });
  window.on("close", () => {
    state = {
      ...state,
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
    };
    writeStateFile(file, state);
  });

  window.loadURL(options.startUrl ?? APP_START_URL).catch(() => {
    // Shown anyway, by `did-fail-load` or the time limit above.
  });
  return window;
}
