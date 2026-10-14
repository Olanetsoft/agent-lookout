// What the app remembers about installing its Claude Code plugin: that it
// tried, when, and what came of it, and whether the Overview has said so. It
// is one small JSON file in the app's own folder of user data, beside
// `update-state.json`, and it is written before the first command runs, so
// the app tries once and never again.
//
// Unlike the app's other files, a file that is there and cannot be read is
// never taken for "never tried": that would give the plugin back to a person
// who removed it. Only a file that is not there at all means the app has not
// tried.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { openWithoutFollowingNow } from "../../collector/files/noFollow.ts";
import { isPluginInstallStep, type PluginInstallStep } from "../../core/answers/pluginInstall.ts";

/** The file's name, in the app's folder of user data. */
export const PLUGIN_INSTALL_FILE = "plugin-install-state.json";

/** Far more than a record needs. A larger file is not one. */
const MAX_RECORD_BYTES = 4_096;

/**
 * What came of the one try:
 *
 * running            it is under way, or the app quit before it finished
 * installed          it installed the plugin, and `claude plugin list` names it
 * already-installed  `claude plugin list` named the plugin, so nothing was installed
 * failed             it could not, at `step`
 * turned-off         `AGENT_LOOKOUT_PLUGIN_INSTALL=off`, so nothing was run
 */
export type PluginInstallOutcome =
  "running" | "installed" | "already-installed" | "failed" | "turned-off";

const OUTCOMES: readonly PluginInstallOutcome[] = [
  "running",
  "installed",
  "already-installed",
  "failed",
  "turned-off",
];

export interface PluginInstallRecord {
  /** When the app decided to try, in milliseconds since 1970. */
  triedAt: number;
  outcome: PluginInstallOutcome;
  /** Where it stopped, set only when the outcome is "failed". */
  step: PluginInstallStep | null;
  /** Whether the person dismissed what the Overview said of it. */
  told: boolean;
}

/** What is in the file: nothing, a record, or something that cannot be read. */
export type PluginInstallReading =
  { kind: "none" } | { kind: "record"; record: PluginInstallRecord } | { kind: "unreadable" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutcome(value: unknown): value is PluginInstallOutcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/** The record in the file's text, or null for anything that is not exactly one. */
export function readPluginInstallRecord(text: string): PluginInstallRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  const { triedAt, outcome, step, told } = value;
  if (!Number.isSafeInteger(triedAt) || (triedAt as number) <= 0) return null;
  if (!isOutcome(outcome)) return null;
  if (told !== undefined && typeof told !== "boolean") return null;
  if (outcome === "failed") {
    if (!isPluginInstallStep(step)) return null;
  } else if (step !== undefined && step !== null) {
    return null;
  }
  return {
    triedAt: triedAt as number,
    outcome,
    step: outcome === "failed" ? (step as PluginInstallStep) : null,
    told: told === true,
  };
}

/** The file's text for the record. */
export function writePluginInstallRecord(record: PluginInstallRecord): string {
  const { triedAt, outcome, step, told } = record;
  return `${JSON.stringify({ triedAt, outcome, step, told }, null, 2)}\n`;
}

/** Where the record is kept: the file, or for a test, memory. */
export interface PluginInstallStore {
  read(): PluginInstallReading;
  /** True once the record is in place, and false when it could not be written. */
  write(record: PluginInstallRecord): boolean;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

/** The record in `plugin-install-state.json` in a folder, the app's folder of user data. */
export function pluginInstallFile(dir: string): PluginInstallStore {
  const file = path.join(dir, PLUGIN_INSTALL_FILE);
  return {
    read() {
      let fd: number;
      try {
        // Never through a link, and never waiting on a named pipe.
        fd = openWithoutFollowingNow(file, constants.O_RDONLY);
      } catch (error) {
        return errorCode(error) === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
      }
      let text: string;
      try {
        // A small file of its own, read through the one it opened, and no further than a record goes.
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > MAX_RECORD_BYTES) return { kind: "unreadable" };
        const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
        let filled = 0;
        while (filled < buffer.byteLength) {
          const read = readSync(fd, buffer, filled, buffer.byteLength - filled, filled);
          if (read === 0) break;
          filled += read;
        }
        if (filled > MAX_RECORD_BYTES) return { kind: "unreadable" };
        text = buffer.toString("utf8", 0, filled);
      } catch {
        return { kind: "unreadable" };
      } finally {
        closeSync(fd);
      }
      const record = readPluginInstallRecord(text);
      return record === null ? { kind: "unreadable" } : { kind: "record", record };
    },
    write(record) {
      try {
        mkdirSync(dir, { recursive: true });
        // Written whole beside it, then moved over it, so it is never read half written.
        const next = `${file}.${process.pid}.tmp`;
        writeFileSync(next, writePluginInstallRecord(record), { encoding: "utf8", mode: 0o600 });
        renameSync(next, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
