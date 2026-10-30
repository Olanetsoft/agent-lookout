// What the app remembers about the switch Keep the Mac awake between launches:
// whether it is on. It is one small JSON file in the app's own folder of user
// data, beside `menu-bar-state.json` and `update-state.json`. It holds the
// switch and nothing about any session.
//
// Reading never throws: a file that is missing, damaged or from another
// version gives the default, which has the switch off.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The file's name, in the app's folder of user data. */
export const KEEP_AWAKE_SETTINGS_FILE = "keep-awake-state.json";

export interface KeepAwakeSettings {
  /** Whether the switch Keep the Mac awake, in Settings, is on. */
  on: boolean;
}

export const DEFAULT_KEEP_AWAKE_SETTINGS: KeepAwakeSettings = { on: false };

/** The settings in the file's text, or the default for anything that cannot be read. */
export function readKeepAwakeSettings(text: string | null | undefined): KeepAwakeSettings {
  if (!text) return DEFAULT_KEEP_AWAKE_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_KEEP_AWAKE_SETTINGS;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return DEFAULT_KEEP_AWAKE_SETTINGS;
  }
  // Only a switch turned on stays on. Anything else is the default, off.
  return { on: (value as { on?: unknown }).on === true };
}

/** The file's text for the settings. */
export function writeKeepAwakeSettings(settings: KeepAwakeSettings): string {
  return `${JSON.stringify({ on: settings.on }, null, 2)}\n`;
}

/** Where the setting is kept: the file, or for a test, memory. */
export interface KeepAwakeSettingsStore {
  read(): KeepAwakeSettings;
  write(settings: KeepAwakeSettings): void;
}

/** The setting in `keep-awake-state.json` in a folder, the app's folder of user data. */
export function keepAwakeSettingsFile(dir: string): KeepAwakeSettingsStore {
  const file = path.join(dir, KEEP_AWAKE_SETTINGS_FILE);
  return {
    read() {
      try {
        return readKeepAwakeSettings(readFileSync(file, "utf8"));
      } catch {
        return DEFAULT_KEEP_AWAKE_SETTINGS;
      }
    },
    write(settings) {
      try {
        mkdirSync(dir, { recursive: true });
        // Written whole beside it, then moved over it, so it is never read half written.
        const next = `${file}.${process.pid}.tmp`;
        writeFileSync(next, writeKeepAwakeSettings(settings), { encoding: "utf8", mode: 0o600 });
        renameSync(next, file);
      } catch {
        // Not remembered. The default, off, holds next time.
      }
    },
  };
}
