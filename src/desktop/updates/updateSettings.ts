// What the app remembers about updates between launches: whether it checks by
// itself, when a check last had an answer, the last version it told the person
// about, so a notification is shown once for each, and the version it was
// installing when it quit, so the copy that opens next knows whether that
// worked. It is one small JSON file in the app's own folder of user data,
// beside `window-state.json`.
//
// Reading never throws: a file that is missing, damaged or from another
// version gives the defaults, which have the automatic check on.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseVersion } from "./release/version.ts";

/** The file's name, in the app's folder of user data. */
export const UPDATE_SETTINGS_FILE = "update-state.json";

export interface UpdateSettings {
  /** Whether the app checks by itself, about once a day. */
  automatic: boolean;
  /** When a check last had an answer from GitHub, in milliseconds since 1970. */
  lastCheckedAt: number | null;
  /** The last version a notification was shown for. */
  notifiedVersion: string | null;
  /**
   * The version Install and Restart was pressed for, until a copy of the app
   * opens again. That copy is the new version when the install worked.
   */
  installingVersion: string | null;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  automatic: true,
  lastCheckedAt: null,
  notifiedVersion: null,
  installingVersion: null,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A version as the file holds one, such as "0.2.1", or null for anything else. */
function versionOrNull(field: unknown): string | null {
  return typeof field === "string" && parseVersion(field) !== null ? field : null;
}

/** The settings in the file's text, or the defaults for anything that cannot be read. */
export function readUpdateSettings(text: string | null | undefined): UpdateSettings {
  if (!text) return DEFAULT_UPDATE_SETTINGS;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_UPDATE_SETTINGS;
  }
  if (!isObject(value)) return DEFAULT_UPDATE_SETTINGS;
  const { automatic, lastCheckedAt, notifiedVersion, installingVersion } = value;
  return {
    // Only a switch turned off stays off. Anything else is the default, on.
    automatic: automatic !== false,
    lastCheckedAt:
      Number.isSafeInteger(lastCheckedAt) && (lastCheckedAt as number) > 0
        ? (lastCheckedAt as number)
        : null,
    notifiedVersion: versionOrNull(notifiedVersion),
    installingVersion: versionOrNull(installingVersion),
  };
}

/** The file's text for the settings. */
export function writeUpdateSettings(settings: UpdateSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Where the settings are kept: the file, or for a test, memory. */
export interface UpdateSettingsStore {
  read(): UpdateSettings;
  write(settings: UpdateSettings): void;
}

/** The settings in `update-state.json` in a folder, the app's folder of user data. */
export function settingsFile(dir: string): UpdateSettingsStore {
  const file = path.join(dir, UPDATE_SETTINGS_FILE);
  return {
    read() {
      try {
        return readUpdateSettings(readFileSync(file, "utf8"));
      } catch {
        return DEFAULT_UPDATE_SETTINGS;
      }
    },
    write(settings) {
      try {
        mkdirSync(dir, { recursive: true });
        // Written whole beside it, then moved over it, so it is never read half written.
        const next = `${file}.${process.pid}.tmp`;
        writeFileSync(next, writeUpdateSettings(settings), { encoding: "utf8", mode: 0o600 });
        renameSync(next, file);
      } catch {
        // Not remembered. The defaults hold next time.
      }
    },
  };
}
