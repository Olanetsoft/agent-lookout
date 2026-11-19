import path from "node:path";

import { pathsOf } from "../../files/paths.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isMissing } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { trustedFile } from "./folders.ts";

/**
 * Grok Build's list of the sessions its terminal app has open,
 * `<grok home>/active_sessions.json`. Built from Grok Build's source at
 * 1.0.45 (commit 2bdd1d6) and not yet checked on a machine running it.
 *
 * - It is one JSON array, each entry `{session_id, pid, cwd, opened_at}`
 *   (`xai-grok-active-sessions/src/lib.rs:15-21`). Grok Build writes it whole
 *   to `active_sessions.json.tmp` and renames that over it (`:130-141`), so a
 *   read never catches it half written. Its lock, `active_sessions.lock`, and
 *   that temporary file are never opened, locked or looked up.
 * - An entry is added when a session in the terminal app is ready, with the
 *   app's own process ID and the time (`xai-grok-pager/src/app/effects/mod.rs:133-140`),
 *   and taken out when the app quits, closes the session or moves on from it,
 *   as /new does. A crash leaves it, until the next session Grok Build opens
 *   prunes entries whose process has gone (`lib.rs:45-50`).
 * - It is looked at with `lstat` every poll and read only when its size,
 *   modified time or identity changed, opened without following a link, only
 *   as an ordinary file with one name of the user Agent Lookout runs as, and
 *   only when it is 1 MiB or less.
 * - Of each entry only these four are kept, and an entry is passed over unless
 *   its ID could name a folder, its process ID is one, its `cwd` is a whole
 *   path of at most 4,096 characters with no control character, and its
 *   `opened_at` is a time as Grok Build writes one. Anything else in it is
 *   dropped with the parsed text. At most the 200 newest entries are kept.
 *
 * An empty file is an empty list, as Grok Build reads it (`lib.rs:111-128`).
 * One that cannot be read or parsed fails the poll, so no session is finished
 * from it, though Grok Build itself would read it as empty. Nothing here
 * writes, renames, locks or deletes anything.
 */

export const REGISTRY_FILE = "active_sessions.json";

/** The largest list read. */
export const MAX_REGISTRY_BYTES = 1_048_576;

/** The most entries kept, the newest first. */
export const MAX_ENTRIES = 200;

/** The longest folder kept. */
const MAX_CWD_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** The largest process ID kept. */
const MAX_PID = 2_147_483_647;

/**
 * A session's ID as this adapter puts one in a path: letters, digits, `.`,
 * `_` and `-`, at most 128, and not `.` or `..`. Grok Build makes a UUIDv7,
 * and a client can choose one with `-s`.
 */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * `opened_at` as chrono writes a time in UTC: to the second, with 3, 6 or 9
 * digits of a second when they are not all 0, and `Z`. An offset is read too.
 */
const OPENED_AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function isGrokSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value) && value !== "." && value !== "..";
}

/** What is kept of one entry. */
export interface RegistryEntry {
  sessionId: string;
  pid: number;
  /** The session's working folder, as Grok Build wrote it. */
  cwd: string;
  /** When Grok Build listed the session, in epoch milliseconds, as written: judged against the clock on each poll. */
  openedAt: number;
}

/** `opened_at` in epoch milliseconds, or null for anything not in its form. */
export function openedAtOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = OPENED_AT.exec(value);
  if (!match) return null;
  const [year, month, day, hours, minutes, seconds] = match.slice(1, 7).map(Number) as number[];
  const fraction = match[7] ?? "";
  const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
  const at = Date.UTC(
    year as number,
    (month as number) - 1,
    day as number,
    hours as number,
    minutes as number,
    seconds as number,
    ms,
  );
  const check = new Date(at);
  // A day or an hour out of range rolls over, and is not a time Grok Build writes.
  if (
    !Number.isSafeInteger(at) ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== (month as number) - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hours ||
    check.getUTCMinutes() !== minutes
  ) {
    return null;
  }
  if (match[8] === undefined) return at;
  const offset = (Number(match[9]) * 60 + Number(match[10])) * 60_000;
  return match[8] === "+" ? at - offset : at + offset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function folderOf(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  return pathsOf(platform).isAbsolute(value) ? value : null;
}

/** One entry as this keeps it, or null for one it passes over. */
export function entryOf(value: unknown, platform: NodeJS.Platform): RegistryEntry | null {
  if (!isRecord(value)) return null;
  const sessionId = value.session_id;
  if (!isGrokSessionId(sessionId)) return null;
  const pid = validPid(value.pid);
  // Grok Build's own check takes a process ID only as a positive 32-bit number (`lib.rs:146-149`).
  if (pid === undefined || pid > MAX_PID) return null;
  const cwd = folderOf(value.cwd, platform);
  if (cwd === null) return null;
  const openedAt = openedAtOf(value.opened_at);
  if (openedAt === null) return null;
  return { sessionId, pid, cwd, openedAt };
}

/**
 * The entries of a list's text, one for each session, the newest by
 * `opened_at` first, at most `MAX_ENTRIES`, or null when the text is not a
 * JSON array. Grok Build keeps one entry for each session (`lib.rs:45-50`): of
 * two, the newer is kept.
 */
export function parseRegistry(text: string, platform: NodeJS.Platform): RegistryEntry[] | null {
  if (text.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The error's words can hold the text, so it is dropped unread.
    return null;
  }
  if (!Array.isArray(value)) return null;
  const bySession = new Map<string, RegistryEntry>();
  for (const item of value) {
    const entry = entryOf(item, platform);
    if (entry === null) continue;
    const kept = bySession.get(entry.sessionId);
    if (kept === undefined || entry.openedAt > kept.openedAt) bySession.set(entry.sessionId, entry);
  }
  return [...bySession.values()]
    .sort((a, b) => b.openedAt - a.openedAt || (a.sessionId < b.sessionId ? -1 : 1))
    .slice(0, MAX_ENTRIES);
}

/** What one look at the list found. */
export type RegistryRead =
  | { state: "ok"; entries: readonly RegistryEntry[] }
  /** No file: no session is open. */
  | { state: "missing" }
  /** One that could not be read, is over the limit, is not an ordinary file of this user's, or does not parse. */
  | { state: "error"; why: "unreadable" | "too-large" | "broken" };

const sameFile = (a: FileInfo, b: FileInfo) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export interface RegistryReader {
  read(): Promise<RegistryRead>;
}

export interface RegistryReaderOptions {
  home: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
}

/** A reader of the list, which keeps the entries it read until the file changes. */
export function createRegistryReader(options: RegistryReaderOptions): RegistryReader {
  const { io, platform, euid } = options;
  const file = path.join(options.home, REGISTRY_FILE);
  /** The entries of the last read that parsed, by the open file's size, time and identity. */
  let known: { info: FileInfo; entries: RegistryEntry[] } | null = null;

  async function readWhole(): Promise<RegistryRead> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      if (!trustedFile(info, platform, euid)) return { state: "error", why: "unreadable" };
      if (info.size > MAX_REGISTRY_BYTES) return { state: "error", why: "too-large" };
      const bytes = await handle.read(0, info.size);
      // Read short: the file changed as it was read, and is read again next poll.
      if (bytes.byteLength !== info.size) return { state: "error", why: "unreadable" };
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
      const entries = parseRegistry(text, platform);
      if (entries === null) return { state: "error", why: "broken" };
      // Kept by the open file's own size, time and identity, which the next
      // poll's `lstat` gives while it stays as it was.
      known = { info, entries };
      return { state: "ok", entries };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return {
    async read() {
      let looked: FileInfo;
      try {
        looked = await io.lstat(file);
      } catch (error) {
        if (isMissing(error)) {
          known = null;
          return { state: "missing" };
        }
        return { state: "error", why: "unreadable" };
      }
      // Checked before what was read is reused: a second name or another owner
      // leaves the size, time and identity as they were.
      if (!trustedFile(looked, platform, euid)) return { state: "error", why: "unreadable" };
      if (known && sameFile(known.info, looked)) return { state: "ok", entries: known.entries };
      if (looked.size > MAX_REGISTRY_BYTES) return { state: "error", why: "too-large" };
      try {
        return await readWhole();
      } catch {
        // A refused open, or a read that failed: nothing is kept of it, and
        // it is read again next poll.
        return { state: "error", why: "unreadable" };
      }
    },
  };
}
