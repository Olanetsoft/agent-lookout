// What each item of the menu bar's menu does, made from the parts of the app
// that `main.ts` hands it. Choosing a session opens the window on its details,
// `#overview/session/<id>`, making the window if it was closed and bringing it
// forward if it was not, as the page's own links to a session do.
//
// A choice in the menu bar leaves the app where it was among the others, so
// each item that shows something brings the app to the front first. Deny and
// Allow show nothing, and leave it where it was.
//
// It imports nothing from Electron, so it is tested in plain Node.

import { APP_START_URL } from "../../core/appAddress.ts";
import { sessionHash } from "../../core/sessions/sessionHash.ts";
import type { MenuBarActions, MenuBarPress } from "./menuBarMenu.ts";

/** The app's address of a session's details. */
export function sessionAddress(sessionId: string): string {
  return `${APP_START_URL}${sessionHash(sessionId)}`;
}

export interface MenuBarActionsOptions {
  /** Shows the window at an address of the app's own, or as it was, making it when it is closed. */
  showWindow: (address?: string) => void;
  /** Brings the app in front of the others. */
  activate: () => void;
  /** Check for Updates…, as the app menu has it. */
  checkForUpdates: () => void;
  /** Settings…, as the app menu has it. */
  openSettings: () => void;
  /** Deny or Allow for a held permission request, as the app answers one. */
  answer: (press: MenuBarPress) => void;
  quit: () => void;
}

export function menuBarActions(options: MenuBarActionsOptions): MenuBarActions {
  const inFront =
    (run: () => void): (() => void) =>
    () => {
      options.activate();
      run();
    };
  return {
    openSession: (sessionId) => inFront(() => options.showWindow(sessionAddress(sessionId)))(),
    answer: (press) => options.answer(press),
    openApp: inFront(() => options.showWindow()),
    checkForUpdates: inFront(options.checkForUpdates),
    openSettings: inFront(options.openSettings),
    quit: () => options.quit(),
  };
}
