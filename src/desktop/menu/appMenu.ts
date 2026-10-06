// The menus a Mac app is expected to have, and nothing more: the app's own
// menu with About, Check for Updates…, Settings…, Hide and Quit; File with
// Close Window; Edit, so copy and paste work in the page; View, with reload and
// the developer tools in development only; Window; and Help, with the guide.
//
// It imports only types from Electron, so it is tested in plain Node.
// `main.ts` builds the menu from it.

import type { MenuItemConstructorOptions } from "electron";

/** Where the Help menu's guide opens, in the browser. */
export const GUIDE_URL = "https://github.com/Olanetsoft/agent-lookout/blob/main/docs/GUIDE.md";

export interface AppMenuOptions {
  /** Whether this is a development run, which may reload the page and open the developer tools. */
  development: boolean;
  /** Shows the dashboard's Settings view, opening the window if it is closed. */
  openSettings: () => void;
  /**
   * Checks for a newer version of the app now, whether or not the automatic
   * check is on, and shows the answer: in Settings when the window is open,
   * and in a dialog when it is not.
   */
  checkForUpdates: () => void;
  /** Opens the guide in the browser. */
  openGuide: () => void;
}

export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] {
  const forDevelopment: MenuItemConstructorOptions[] = options.development
    ? [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
      ]
    : [];
  return [
    {
      role: "appMenu",
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => options.checkForUpdates() },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => options.openSettings() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: [...forDevelopment, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Agent Lookout Guide", click: () => options.openGuide() }],
    },
  ];
}
