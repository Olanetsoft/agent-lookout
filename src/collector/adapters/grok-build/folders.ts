import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isTrusted } from "../autohand-code/folders.ts";

/**
 * Finding each Grok Build session's folder, `sessions/<working folder>/<ID>/`
 * in Grok Build's home. Built from Grok Build's source at 1.0.45 (commit
 * 2bdd1d6) and not yet checked on a machine running it.
 *
 * Grok Build names the folder for a session's working folder by URL-encoding
 * it: each byte of its UTF-8 but a letter, a digit and `-`, `_`, `.` and `~`
 * becomes `%` and two upper-case hex digits (`encode_cwd_dirname` in
 * `xai-grok-config/src/paths.rs:61-65`, with urlencoding 2.1.3). A name over
 * 255 bytes is `<slug>-<hash>` instead, with a BLAKE3 hash (`:66-77`), which
 * Node cannot work out. So:
 *
 * - Every poll, each session's folder is looked up with `lstat`: `sessions`,
 *   then the folder for its working folder, then its ID in that, each a real
 *   folder of the user Agent Lookout runs as, never a link. A folder found
 *   before is looked up the same way, and dropped when it fails.
 * - A session whose folder is not found so is looked for by its ID in every
 *   folder in `sessions`: at most once a minute, a clock set back counting as
 *   time enough, for at most the 10 newest missing sessions, in at most the
 *   first 2,000 names, sorted, whose names Grok Build could write. Each is
 *   looked up with `lstat`, then its session's ID in it. One found is the
 *   session's. Two are not either, as Grok Build itself takes neither
 *   (`xai-grok-shell/src/session/storage/relocation/mod.rs:76-77`, `:114-118`).
 *   The names are only put in paths: never decoded, logged or shown, and none
 *   but a folder found is kept past the look. A `.cwd` file is never read.
 *
 * Nothing here opens, writes, renames, locks or deletes anything.
 */

export const SESSIONS_DIR = "sessions";

/** The longest name of a folder, as Grok Build makes them (`paths.rs:55-56`). */
export const MAX_FOLDER_NAME_BYTES = 255;

/** How often, at most, every folder in `sessions` is looked in for missing sessions. */
export const SWEEP_MS = 60_000;

/** The most names in `sessions` looked in at one look. */
export const MAX_SWEEP_NAMES = 2_000;

/** The most missing sessions looked for at one look, the newest first. */
export const MAX_SWEEP_IDS = 10;

/**
 * A folder's name Grok Build could write: what URL-encoding leaves, with `%`,
 * or a slug of lower-case letters, digits and `-`, then `-` and 16 hex digits.
 */
const FOLDER_NAME = /^[A-Za-z0-9._~%-]{1,255}$/;

const isUnreserved = (byte: number) =>
  (byte >= 0x30 && byte <= 0x39) ||
  (byte >= 0x41 && byte <= 0x5a) ||
  (byte >= 0x61 && byte <= 0x7a) ||
  byte === 0x2d ||
  byte === 0x2e ||
  byte === 0x5f ||
  byte === 0x7e;

/**
 * The name Grok Build gives the folder of a working folder's sessions, as
 * urlencoding 2.1.3 writes it, or null when it is over 255 bytes and so a
 * hash this cannot make. Node's `encodeURIComponent` leaves `!'()*` as they
 * are, so it is not used.
 */
export function encodedFolderName(cwd: string): string | null {
  let name = "";
  for (const byte of Buffer.from(cwd, "utf8")) {
    name += isUnreserved(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    if (name.length > MAX_FOLDER_NAME_BYTES) return null;
  }
  return name === "" ? null : name;
}

/** A folder this adapter looks in: a real one, of the user it runs as. */
export function trustedFolder(
  info: FileInfo,
  platform: NodeJS.Platform,
  euid: number | null,
): boolean {
  return isTrusted(info, "session-folder", platform, euid);
}

/** A file this adapter reads: an ordinary one with one name, of the user it runs as. */
export function trustedFile(
  info: FileInfo,
  platform: NodeJS.Platform,
  euid: number | null,
): boolean {
  return isTrusted(info, "metadata", platform, euid);
}

/** Where a session's folder was found, or why not. */
export type FolderLook =
  | { state: "found"; folder: string }
  | { state: "none" }
  /** Its ID is in two folders, so neither is taken. */
  | { state: "ambiguous" };

/** A session whose folder is wanted. */
export interface FolderWanted {
  sessionId: string;
  cwd: string;
  openedAt: number;
}

export interface FolderFinder {
  /** The folder of each of these sessions, by ID. */
  find(wanted: readonly FolderWanted[], now: number): Promise<Map<string, FolderLook>>;
  /** Forgets the folder found for every session not in this set. */
  keepOnly(ids: ReadonlySet<string>): void;
  /** How many folders it keeps, for the tests that check none is kept once its session has gone. */
  readonly kept: number;
}

export interface FolderFinderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
  /** How often, at most, the folders are looked through. Defaults to a minute. */
  sweepMs?: number;
  /** The most names looked in at one look. Defaults to 2,000. */
  maxNames?: number;
  /** The most missing sessions looked for at one look. Defaults to 10. */
  maxIds?: number;
}

export function createFolderFinder(options: FolderFinderOptions): FolderFinder {
  const { sessionsDir, io, platform, euid } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const maxNames = options.maxNames ?? MAX_SWEEP_NAMES;
  const maxIds = options.maxIds ?? MAX_SWEEP_IDS;
  /** The name of the folder in `sessions` each session's was found in, by ID. */
  const found = new Map<string, string>();
  /** When every folder was last looked through, or null before the first time. */
  let sweptAt: number | null = null;

  /** Whether `lstat` finds a real folder of this user's at a path. */
  async function isFolder(target: string): Promise<boolean> {
    try {
      return trustedFolder(await io.lstat(target), platform, euid);
    } catch {
      return false;
    }
  }

  /** Whether a session's folder is in the folder of this name in `sessions`. */
  async function holds(name: string, sessionId: string): Promise<boolean> {
    const parent = path.join(sessionsDir, name);
    return (await isFolder(parent)) && (await isFolder(path.join(parent, sessionId)));
  }

  /** Looks through every folder in `sessions` for these sessions, by ID. */
  async function sweep(ids: readonly string[]): Promise<Map<string, FolderLook>> {
    const looks = new Map<string, FolderLook>();
    let names: string[];
    try {
      names = await io.readdir(sessionsDir);
    } catch {
      return looks;
    }
    const kept = names
      .filter((name) => FOLDER_NAME.test(name))
      .sort()
      .slice(0, maxNames);
    const hits = new Map<string, string[]>();
    for (const name of kept) {
      const parent = path.join(sessionsDir, name);
      if (!(await isFolder(parent))) continue;
      for (const id of ids) {
        if (!(await isFolder(path.join(parent, id)))) continue;
        hits.set(id, [...(hits.get(id) ?? []), name]);
      }
    }
    for (const id of ids) {
      const places = hits.get(id) ?? [];
      if (places.length === 1 && places[0] !== undefined) {
        found.set(id, places[0]);
        looks.set(id, { state: "found", folder: path.join(sessionsDir, places[0], id) });
      } else {
        looks.set(id, places.length > 1 ? { state: "ambiguous" } : { state: "none" });
      }
    }
    return looks;
  }

  return {
    async find(wanted, now) {
      const looks = new Map<string, FolderLook>();
      if (wanted.length === 0) return looks;
      if (!(await isFolder(sessionsDir))) {
        for (const { sessionId } of wanted) looks.set(sessionId, { state: "none" });
        return looks;
      }
      const missing: FolderWanted[] = [];
      for (const item of wanted) {
        const { sessionId } = item;
        const before = found.get(sessionId);
        if (before !== undefined) {
          if (await holds(before, sessionId)) {
            looks.set(sessionId, {
              state: "found",
              folder: path.join(sessionsDir, before, sessionId),
            });
            continue;
          }
          found.delete(sessionId);
        }
        const name = encodedFolderName(item.cwd);
        if (name !== null && name !== before && (await holds(name, sessionId))) {
          found.set(sessionId, name);
          looks.set(sessionId, { state: "found", folder: path.join(sessionsDir, name, sessionId) });
          continue;
        }
        missing.push(item);
        looks.set(sessionId, { state: "none" });
      }
      if (missing.length === 0) return looks;
      // A clock set back counts as time enough.
      const due = sweptAt === null || now < sweptAt || now - sweptAt >= sweepMs;
      if (!due) return looks;
      sweptAt = now;
      const ids = [...missing]
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, maxIds)
        .map((item) => item.sessionId);
      for (const [id, look] of await sweep(ids)) looks.set(id, look);
      return looks;
    },
    keepOnly(ids) {
      for (const id of found.keys()) if (!ids.has(id)) found.delete(id);
    },
    get kept() {
      return found.size;
    },
  };
}
