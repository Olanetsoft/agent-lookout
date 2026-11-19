import path from "node:path";

import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { folder, SESSION_ID } from "../pi/sessionFile.ts";
import type { SessionFileRef } from "../pi/sessionFiles.ts";

/**
 * Reading the little this adapter needs from a Droid session file. Built from
 * Factory's documentation and its Droid SDKs, droid-sdk 0.5.0 and
 * @factory/droid-sdk 0.11.0, and not yet checked on a computer running Droid.
 *
 * Droid keeps each session in one JSONL file, `<id>.jsonl`, which holds the
 * whole conversation. Its first line is a `session_start` entry, with the
 * session's title, its folder (`cwd`) and its `owner`, and the conversation
 * follows (`_parse_session` in the Python SDK's `discovery.py`, and the
 * `SessionStartEventSchema` of the TypeScript SDK's npm files). So:
 *
 * - The session's ID is the file's name without `.jsonl`, as both SDKs take
 *   it. A name that is not one Droid gives is never opened.
 * - Only the first line is read, from the first `FIRST_READ_BYTES`, and up to
 *   `MAX_FIRST_LINE_BYTES` when it runs past them.
 * - The first line is turned into text and parsed only when it holds
 *   `"session_start"` as bytes. Only its `type`, whether it has a title, and
 *   its `cwd` are looked at, and only `cwd` is kept. The title, which Droid
 *   makes from the first prompt or a rename, the `owner`, which can be an
 *   email address, and everything else are dropped with the parsed line.
 * - No byte after the first line break is turned into text. Only the file's
 *   size is compared with where the first line ends: a file with nothing after
 *   it is not a session yet.
 *
 * A file is opened only when its size, modified time or identity changes, read
 * only, without following a link at its name and, in a project folder, only
 * when that folder is a real folder. A file that showed a session and is then
 * found not to, as while Droid rewrites its first line, goes on showing it
 * until the file holds still for a poll: then what it holds is what is shown.
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The bytes read first. Most first lines are far shorter. */
export const FIRST_READ_BYTES = 4 * 1024;

/** The most of a file's start read for its first line. A longer one is not taken for a session's. */
export const MAX_FIRST_LINE_BYTES = 64 * 1024;

const SESSION_FILE_ENDING = ".jsonl";

const NEWLINE = 0x0a;
const BACKSLASH = 0x5c;

/** The bytes JSON counts as space: space, tab, carriage return and line feed. */
const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** The type of the first line, as bytes, with the quotes JSON writes around a key or a value. */
const SESSION_START = Buffer.from('"session_start"');

/** Whether a name in the sessions folder is a project's folder: Droid's begin with `-`. */
export function isDroidProjectFolder(name: string): boolean {
  return name.startsWith("-");
}

/**
 * The session's ID from its file's name: the name without `.jsonl`, when that
 * is an ID as `SESSION_ID` allows. Null for any other name, whose file is not
 * opened. The `sessionId` on the first line is never used.
 */
export function sessionIdOf(fileName: string): string | null {
  if (!fileName.endsWith(SESSION_FILE_ENDING)) return null;
  const stem = fileName.slice(0, -SESSION_FILE_ENDING.length);
  return SESSION_ID.test(stem) ? stem : null;
}

/**
 * Whether these bytes hold `token` where JSON can write it only as a key or a
 * value: its opening quote is not escaped, as it is inside a string, where
 * JSON writes `"` as `\"`. Nothing is turned into text.
 */
export function holdsToken(bytes: Buffer, token: Buffer): boolean {
  let from = 0;
  while (from <= bytes.byteLength - token.byteLength) {
    const at = bytes.indexOf(token, from);
    if (at < 0) return false;
    let slashes = 0;
    while (at - slashes - 1 >= 0 && bytes[at - slashes - 1] === BACKSLASH) slashes += 1;
    if (slashes % 2 === 0) return true;
    from = at + 1;
  }
  return false;
}

/** Whether a first line, as bytes, holds `"session_start"` as a key or a value. */
export function holdsSessionStart(line: Buffer): boolean {
  return holdsToken(line, SESSION_START);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Whether a parsed first line has a title, as Factory's SDKs require of a
 * session's: a `title` that is text, even empty, or the older `sessionTitle`
 * that is text other than spaces, which the TypeScript SDK takes in its place.
 * Neither is kept.
 */
function hasTitle(value: Record<string, unknown>): boolean {
  if (typeof value.title === "string") return true;
  const older = value.sessionTitle;
  return typeof older === "string" && older.trim() !== "";
}

/**
 * What is kept of a first line, or null when it is not a session's: not a
 * JSON object, not of type `session_start`, or with no title. `cwd` is kept
 * when it is a full path, and is null otherwise.
 */
export function parseFirstLine(
  text: string,
  platform: NodeJS.Platform,
): { cwd: string | null } | null {
  const value = parseLine(text);
  if (!isRecord(value) || value.type !== "session_start" || !hasTitle(value)) return null;
  return { cwd: folder(value.cwd, platform) };
}

/** What is kept of one session file. */
export interface DroidSessionFile {
  /** The file's name without `.jsonl`. */
  id: string;
  /** The session's folder: a full path, or null when the first line's is not one. */
  cwd: string | null;
}

/** What a file showed. */
export type DroidShown =
  | { state: "ok"; session: DroidSessionFile }
  /** No session: gone, not in a real folder, not whole yet, or nothing after its first line. */
  | { state: "none" }
  /** Its first line is not a Droid session's. */
  | { state: "other" };

/** What a file shows on this poll, with the time of its last write when it shows a session. */
export type DroidFileRead =
  | {
      state: "ok";
      session: DroidSessionFile;
      /**
       * The file's modified time: the open file's, when it was opened on this
       * poll and that is later, else its `lstat`'s.
       */
      writtenAt: number;
    }
  | { state: "none" }
  | { state: "other" };

const NONE: DroidShown = { state: "none" };
const OTHER: DroidShown = { state: "other" };

interface Remembered {
  /** The file's `lstat` when it was last read. */
  info: FileInfo;
  /** What it showed then. */
  shown: DroidShown;
  /** What the file as it was then holds, which it shows once it holds still. */
  holds: DroidShown;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * What the bytes of a file's start hold: a session, nothing yet, or not a
 * session. Only the first line is ever turned into text.
 */
async function firstLineOf(
  file: OpenFile,
  id: string,
  platform: NodeJS.Platform,
): Promise<DroidShown> {
  let head = asBuffer(await file.read(0, FIRST_READ_BYTES));
  let end = head.indexOf(NEWLINE);
  // Only when the first line runs past the first read, and no further than the cap.
  if (end < 0 && head.byteLength === FIRST_READ_BYTES && file.info.size > FIRST_READ_BYTES) {
    const rest = await file.read(FIRST_READ_BYTES, MAX_FIRST_LINE_BYTES - FIRST_READ_BYTES);
    head = Buffer.concat([head, asBuffer(rest)]);
    end = head.indexOf(NEWLINE);
  }
  // Not whole yet, or a first line too long to be a session's.
  if (end < 0) return file.info.size <= head.byteLength ? NONE : OTHER;
  const line = head.subarray(0, end);
  // An empty first line, as while a file is made. Looked at as bytes.
  if (line.every((byte) => WHITESPACE.has(byte))) return NONE;
  if (!holdsSessionStart(line)) return OTHER;
  const kept = parseFirstLine(line.toString("utf8"), platform);
  if (kept === null) return OTHER;
  // Nothing after the first line yet, as in a session that never had a prompt.
  if (file.info.size <= end + 1) return NONE;
  return { state: "ok", session: { id, cwd: kept.cwd } };
}

export interface DroidSessionReader {
  /** What a session file shows, given its `lstat` and its ID, opened only when that changed. */
  read(ref: SessionFileRef, id: string): Promise<DroidFileRead>;
  /** Forgets every file not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
}

/** A reader of Droid's session files, which keeps what it read of each until it changes. */
export function createDroidSessionReader(
  sessionsDir: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): DroidSessionReader {
  const remembered = new Map<string, Remembered>();

  function answer(shown: DroidShown, writtenAt: number): DroidFileRead {
    if (shown.state !== "ok") return shown;
    return { state: "ok", session: shown.session, writtenAt };
  }

  return {
    async read(ref, id) {
      const known = remembered.get(ref.path);
      if (known && sameFile(known.info, ref.info)) {
        // The file held still since it was read, so what it holds is what it shows.
        if (known.shown !== known.holds) remembered.set(ref.path, { ...known, shown: known.holds });
        return answer(known.holds, ref.info.mtimeMs);
      }
      try {
        // A link at the folder's name would lead out of the sessions folder,
        // and opening a file does not look at the names before its own. Not
        // remembered: it says nothing of the file.
        const parent = path.dirname(ref.path);
        if (parent !== sessionsDir && (await io.lstat(parent)).kind !== "directory") {
          return { state: "none" };
        }
        const file = await io.openRegular(ref.path);
        let holds: DroidShown;
        let openedAt: number;
        try {
          // Another file than the one its `lstat` found, as when it was
          // replaced since or a folder became a link: tried again next poll.
          if (file.info.ino !== ref.info.ino) throw new Error("The file was replaced.");
          holds = await firstLineOf(file, id, platform);
          openedAt = file.info.mtimeMs;
        } finally {
          await file.close();
        }
        // A file that showed a session and now does not, as while Droid
        // rewrites it, shows it until it holds still.
        const shown = holds.state !== "ok" && known?.shown.state === "ok" ? known.shown : holds;
        remembered.set(ref.path, { info: ref.info, shown, holds });
        return answer(shown, Math.max(ref.info.mtimeMs, openedAt));
      } catch {
        // Gone since its `lstat`, replaced, or a read error: what it showed
        // stands, and it is tried again on the next poll, since nothing here
        // took note of it.
        return answer(known?.shown ?? NONE, ref.info.mtimeMs);
      }
    },
    keepOnly(paths) {
      for (const file of remembered.keys()) if (!paths.has(file)) remembered.delete(file);
    },
  };
}
