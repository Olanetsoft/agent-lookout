// What the app remembers about its item in the menu bar between launches:
// whether it is shown. It is one small JSON file in the app's own folder of
// user data, beside `update-state.json` and `window-state.json`.
//
// Reading never throws: a file that is missing, damaged or from another
// version gives the default, which has the item shown.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The file's name, in the app's folder of user data. */
export const MENU_BAR_SETTINGS_FILE = "menu-bar-state.json";

export interface MenuBarSettings {
  /** Whether the item is in the menu bar: Show in menu bar, in Settings. */
  show: boolean;
}

export const DEFAULT_MENU_BAR_SETTINGS: MenuBarSettings = { show: true };

/** The settings in the file's text, or the default for anything that cannot be read. */
export function readMenuBarSettings(text: string | null | undefined): MenuBarSettings {
  if (!text) return DEFAULT_MENU_BAR_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_MENU_BAR_SETTINGS;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_MENU_BAR_SETTINGS;
  }
  // Only a switch turned off stays off. Anything else is the default, shown.
  return { show: (value as { show?: unknown }).show !== false };
}

/** The file's text for the settings. */
export function writeMenuBarSettings(settings: MenuBarSettings): string {
  return `${JSON.stringify({ show: settings.show }, null, 2)}\n`;
}

/** Where the setting is kept: the file, or for a test, memory. */
export interface MenuBarSettingsStore {
  read(): MenuBarSettings;
  write(settings: MenuBarSettings): void;
}

/** The setting in `menu-bar-state.json` in a folder, the app's folder of user data. */
export function menuBarSettingsFile(dir: string): MenuBarSettingsStore {
  const file = path.join(dir, MENU_BAR_SETTINGS_FILE);
  return {
    read() {
      try {
        return readMenuBarSettings(readFileSync(file, "utf8"));
      } catch {
        return DEFAULT_MENU_BAR_SETTINGS;
      }
    },
    write(settings) {
      try {
        mkdirSync(dir, { recursive: true });
        // Written whole beside it, then moved over it, so it is never read half written.
        const next = `${file}.${process.pid}.tmp`;
        writeFileSync(next, writeMenuBarSettings(settings), { encoding: "utf8", mode: 0o600 });
        renameSync(next, file);
      } catch {
        // Not remembered. The default holds next time.
      }
    },
  };
}
