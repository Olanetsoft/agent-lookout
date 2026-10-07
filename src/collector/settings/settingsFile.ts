import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { openWithoutFollowingNow } from "../files/noFollow.ts";
import { tildify } from "../files/paths.ts";

/**
 * The one file the collector keeps its own settings in, and everything it does
 * to it: `~/.agent-lookout/settings.json`, or the file
 * `AGENT_LOOKOUT_SETTINGS_FILE` names. It is read as the collector starts,
 * again before each change, and again when another copy of Agent Lookout has
 * written it, and written only when the person changes a setting in the
 * dashboard.
 *
 * The folder is made with mode 700 and the file written with mode 600, read
 * and written by its owner alone. A link where the file or its folder should
 * be is never followed: the file is not read through one and not written
 * through one. A write goes to a new file beside it, put on the disk before
 * it takes the old one's place, so the file is never seen half written, nor
 * left empty by a crash.
 */

/** Names the settings file, in place of `~/.agent-lookout/settings.json`. */
export const SETTINGS_FILE_ENV = "AGENT_LOOKOUT_SETTINGS_FILE";

/** A file's mode: read and written by its owner, and by nobody else. */
export const SETTINGS_FILE_MODE = 0o600;

/** The folder's mode, when the collector makes it. */
export const SETTINGS_FOLDER_MODE = 0o700;

/** The most the file may hold. The settings are a few hundred bytes. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

/** Where the settings are kept. */
export interface SettingsSetup {
  /** The file, as an absolute path. */
  file: string;
  /** The same, with the home folder written `~`, to show. */
  shown: string;
}

/** Where the settings are kept, as the environment says. */
export function readSettingsSetup(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): SettingsSetup {
  const named = env[SETTINGS_FILE_ENV]?.trim() || undefined;
  const file = path.resolve(named ?? path.join(homeDir, ".agent-lookout", "settings.json"));
  return { file, shown: tildify(file, homeDir) };
}

/**
 * What reading the file came to:
 *
 * missing  there is no file, or no folder for it: nothing has been set yet
 * read     its text
 * refused  it was not read, with the sentence that says why
 */
export type SettingsText =
  { kind: "missing" } | { kind: "read"; text: string } | { kind: "refused"; problem: string };

/** How a write went. */
export type SettingsWrite = { ok: true } | { ok: false; problem: string };

// The file is opened without following a link at its name, and without
// waiting on a named pipe, on every system: `noFollow.ts`.

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** What is at a path, without following a link: null when nothing is. */
function kindAt(target: string): "file" | "folder" | "link" | "other" | null {
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink()) return "link";
    if (info.isFile()) return "file";
    return info.isDirectory() ? "folder" : "other";
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Puts a folder's list of names on the disk, so a file renamed into it stays
 * renamed after a crash. Where a folder cannot be opened to be synced, as on
 * Windows, the rename stands as the system keeps it.
 */
function syncFolder(folder: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(folder, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // The file is written. Only how soon the disk has its new name is left to the system.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** What is said of a settings file that is a link. */
const linkRefused = (shown: string): SettingsText => ({
  kind: "refused",
  problem: `${shown} is a link, which Agent Lookout does not follow, so the time rules and the permission rules are off.`,
});

/** What is said of a settings file that is a folder, a pipe or a device. */
const notOrdinary = (shown: string): SettingsText => ({
  kind: "refused",
  problem: `${shown} is not an ordinary file, so the time rules and the permission rules are off.`,
});

/**
 * What tells this settings file from the next one written: its inode, size and
 * time of change, without following a link, or null when nothing is there. A
 * write puts a new file in the old one's place, so each write has a new inode.
 * Never throws.
 */
export function readSettingsStamp(setup: SettingsSetup): string | null {
  try {
    const info = lstatSync(setup.file, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

/** Reads the settings file, as its setup names it. Never throws. */
export function readSettingsText(setup: SettingsSetup): SettingsText {
  const { file, shown } = setup;
  const folder = path.dirname(file);
  try {
    const folderKind = kindAt(folder);
    if (folderKind === null) return { kind: "missing" };
    if (folderKind !== "folder") {
      return {
        kind: "refused",
        problem: `The folder of ${shown} is a link or not a folder, which Agent Lookout does not follow, so the time rules and the permission rules are off.`,
      };
    }
    // Said the same on every system, before the open, which refuses either too.
    const fileKind = kindAt(file);
    if (fileKind === "link") return linkRefused(shown);
    if (fileKind === "folder" || fileKind === "other") return notOrdinary(shown);
  } catch {
    return {
      kind: "refused",
      problem: `${shown} could not be read, so the time rules and the permission rules are off.`,
    };
  }

  let fd: number;
  try {
    fd = openWithoutFollowingNow(file, constants.O_RDONLY);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP") return linkRefused(shown);
    return {
      kind: "refused",
      problem: `${shown} could not be read, so the time rules and the permission rules are off.`,
    };
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return notOrdinary(shown);
    if (info.size > MAX_SETTINGS_BYTES) {
      return {
        kind: "refused",
        problem: `${shown} is larger than 64 KB, so it was not read and the time rules and the permission rules are off.`,
      };
    }
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const read = readSync(fd, buffer, filled, buffer.byteLength - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { kind: "read", text: buffer.toString("utf8", 0, filled) };
  } catch {
    return {
      kind: "refused",
      problem: `${shown} could not be read, so the time rules and the permission rules are off.`,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the settings file whole, as its setup names it: the folder made with
 * mode 700 when it is not there, the text written to a new file of mode 600
 * beside it, which then takes the old one's place. Nothing is written through
 * a link, at the file's name or the folder's. Never throws.
 */
export function writeSettingsText(setup: SettingsSetup, text: string): SettingsWrite {
  const { file, shown } = setup;
  const folder = path.dirname(file);
  const notSaved = {
    ok: false,
    problem: `${shown} could not be written, so the change was not saved.`,
  } as const;

  let temporary: string | null = null;
  try {
    mkdirSync(folder, { recursive: true, mode: SETTINGS_FOLDER_MODE });
    if (kindAt(folder) !== "folder") {
      return {
        ok: false,
        problem: `The folder of ${shown} is a link or not a folder, which Agent Lookout does not write through, so the change was not saved.`,
      };
    }
    const there = kindAt(file);
    if (there !== null && there !== "file") {
      return {
        ok: false,
        problem: `${shown} is a link or not an ordinary file, which Agent Lookout does not write through, so the change was not saved.`,
      };
    }

    temporary = path.join(
      folder,
      `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const fd = openWithoutFollowingNow(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      SETTINGS_FILE_MODE,
    );
    try {
      writeSync(fd, text);
      // On the disk before it takes the old one's place, so a crash or a
      // power cut leaves the old file or the new one, never an empty one.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    temporary = null;
    syncFolder(folder);
    return { ok: true };
  } catch {
    return notSaved;
  } finally {
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // It was never made, or has gone already.
      }
    }
  }
}
