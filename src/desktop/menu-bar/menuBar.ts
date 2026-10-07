// The app's item in the menu bar: the lamp, unlit while nothing needs you and
// lit with the count beside it while something does, and a menu that lists
// those sessions. It follows each poll's snapshot, as the Dock badge does, so
// it is right with the window closed.
//
// The menu is made again as the pointer comes over the icon, so the times in it
// are those of the moment it opens. A poll makes it again only when what it
// shows apart from the times has changed, or, while it shows a time, when it
// was made a minute ago or more, for a menu opened from the keyboard, which the
// pointer never comes over. While it is open it is left as it is, and a
// snapshot that came meanwhile is shown once it has closed, after the item
// chosen in it, if any, has been told.
//
// Each menu made remembers when it was last shown, its own opening or a
// submenu's, and a press of Deny or Allow in it takes that time with it, so
// none is taken in the first second what it answers was shown. A press that
// sent nothing opens the menu again (`reopen`), with a line that says why.
//
// The switch Show in menu bar, in Settings, takes the item away and puts it
// back, and is remembered in `menu-bar-state.json` (`menuBarSettings.ts`). It
// reads off while the item could not be put there.
//
// It imports only types from Electron, so it is tested in plain Node with a
// stand-in for the tray and the menu. `main.ts` hands it Electron's.

import type { MenuItemConstructorOptions, TitleOptions } from "electron";

import type { MenuBarStatus } from "../../core/appMenuBar.ts";
import {
  menuBarHasTimes,
  menuBarKey,
  menuBarTemplate,
  menuBarTitle,
  menuBarToolTip,
  waitingSessions,
  type MenuBarActions,
  type MenuBarSnapshot,
} from "./menuBarMenu.ts";
import type { MenuBarSettingsStore } from "./menuBarSettings.ts";

/** What the item needs of Electron's `Menu`. */
export interface MenuBarMenuLike {
  on(event: "menu-will-show", listener: () => void): unknown;
  on(event: "menu-will-close", listener: () => void): unknown;
  /** Its items, each with its submenu when it has one. */
  readonly items?: readonly { readonly submenu?: MenuBarMenuLike | null }[];
}

/** What the item needs of Electron's `Tray`. */
export interface MenuBarTrayLike<Image, Menu extends MenuBarMenuLike> {
  setImage(image: Image): void;
  setTitle(title: string, options?: TitleOptions): void;
  setToolTip(toolTip: string): void;
  setContextMenu(menu: Menu | null): void;
  /** Opens its menu, as a click on it does. */
  popUpContextMenu(): void;
  on(event: "mouse-enter", listener: () => void): unknown;
  destroy(): void;
}

export interface MenuBarOptions<Image, Menu extends MenuBarMenuLike> {
  /** The lamp unlit, while nothing needs you, and lit, while something does: template images. */
  icons: { quiet: Image; lit: Image };
  /** Puts an item in the menu bar with an image: `new Tray(image)`. */
  makeTray: (image: Image) => MenuBarTrayLike<Image, Menu>;
  /** `Menu.buildFromTemplate`. */
  buildMenu: (template: MenuItemConstructorOptions[]) => Menu;
  actions: MenuBarActions;
  settings: MenuBarSettingsStore;
  now?: () => number;
  /** Runs a function once the one running now has returned, as `setTimeout` does. */
  later?: (run: () => void) => void;
  /** Told when the item could not be put in the menu bar. */
  warn?: (line: string) => void;
}

export interface MenuBar {
  /** Puts the item in the menu bar, when the switch is on. */
  start(): void;
  /** Takes each poll's snapshot. */
  update(snapshot: MenuBarSnapshot): void;
  /** Whether the item is in the menu bar: the switch is on, and the item could be put there. */
  status(): MenuBarStatus;
  /** Turns the switch on or off, remembers it, puts the item in or takes it out, and says which it is. */
  setShown(show: boolean): MenuBarStatus;
  /** Opens the menu again, made afresh, after a press in it that sent nothing. */
  reopen(): void;
  /** Takes the item out of the menu bar, as the app quits. */
  stop(): void;
}

/** The title's digits keep their width, so the icon does not move as the count changes. */
const TITLE_OPTIONS: TitleOptions = { fontType: "monospacedDigit" };

/** How old the times in a menu may grow before a poll makes it again, in milliseconds. */
export const MENU_TIMES_MAX_AGE_MS = 60_000;

export function createMenuBar<Image, Menu extends MenuBarMenuLike>(
  options: MenuBarOptions<Image, Menu>,
): MenuBar {
  const now = options.now ?? Date.now;
  const later = options.later ?? ((run: () => void) => void setTimeout(run, 0));
  let show = options.settings.read().show;
  let tray: MenuBarTrayLike<Image, Menu> | null = null;
  let latest: MenuBarSnapshot | null = null;
  /** Whether the menu is open, and whether something changed while it was. */
  let open = false;
  let behind = false;
  /** Whether the item could not be put in the menu bar the last time it was tried. */
  let missing = false;
  /** What the item shows, so it is told only of a change. */
  let shown: { title: string; lit: boolean; toolTip: string } | null = null;
  /** What the menu in place shows apart from its times, and when it was made. */
  let built: { key: string; at: number } | null = null;

  function setMenu(): void {
    if (tray === null) return;
    const at = now();
    /** When this menu, or a submenu of it, was last shown. */
    let shownAt: number | null = null;
    const menu = options.buildMenu(menuBarTemplate(latest, at, options.actions, () => shownAt));
    built = { key: menuBarKey(latest), at };
    menu.on("menu-will-show", () => {
      open = true;
      shownAt = now();
    });
    // Electron tells the top menu of a submenu's opening too, but a
    // submenu's own is heard as well, should that ever change.
    for (const item of menu.items ?? []) {
      item.submenu?.on("menu-will-show", () => {
        shownAt = now();
      });
    }
    menu.on("menu-will-close", () => {
      open = false;
      if (!behind) return;
      behind = false;
      // The item chosen hears its click after the menu closes, so the menu
      // it belongs to stays in place until then.
      later(() => {
        if (!open) setMenu();
      });
    });
    tray.setContextMenu(menu);
  }

  function refresh(): void {
    if (tray === null) return;
    const next = {
      title: menuBarTitle(latest),
      lit: latest !== null && waitingSessions(latest.sessions).length > 0,
      toolTip: menuBarToolTip(latest),
    };
    if (shown?.lit !== next.lit) tray.setImage(next.lit ? options.icons.lit : options.icons.quiet);
    if (shown?.title !== next.title) tray.setTitle(next.title, TITLE_OPTIONS);
    if (shown?.toolTip !== next.toolTip) tray.setToolTip(next.toolTip);
    shown = next;
    const stale =
      built === null ||
      built.key !== menuBarKey(latest) ||
      (menuBarHasTimes(latest) && now() - built.at >= MENU_TIMES_MAX_AGE_MS);
    if (!stale) return;
    if (open) behind = true;
    else setMenu();
  }

  function putIn(): void {
    if (tray !== null) return;
    try {
      const made = options.makeTray(options.icons.quiet);
      tray = made;
      made.on("mouse-enter", () => {
        // The pointer on its way to a click: the menu is made again with this moment's times.
        if (tray === made && !open) setMenu();
      });
      missing = false;
      shown = { title: "", lit: false, toolTip: "" };
      built = null;
      refresh();
    } catch (error) {
      tray = null;
      missing = true;
      options.warn?.(`The menu bar item could not be shown: ${String(error)}`);
    }
  }

  function takeOut(): void {
    const leaving = tray;
    tray = null;
    open = false;
    behind = false;
    missing = false;
    shown = null;
    built = null;
    try {
      leaving?.destroy();
    } catch {
      // It has gone already.
    }
  }

  return {
    start() {
      if (show) putIn();
    },
    update(snapshot) {
      latest = { sessions: snapshot.sessions, sources: snapshot.sources, note: snapshot.note };
      refresh();
    },
    status: () => ({ show: show && !missing }),
    setShown(next) {
      show = next;
      options.settings.write({ show });
      if (show) putIn();
      else takeOut();
      return { show: show && !missing };
    },
    reopen() {
      if (tray === null || open) return;
      const current = tray;
      setMenu();
      try {
        current.popUpContextMenu();
      } catch {
        // The line is there the next time the menu opens.
      }
    },
    stop: takeOut,
  };
}
