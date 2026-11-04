import path from "node:path";

import { pathsOf } from "../../files/paths.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { SessionFileRef } from "./sessionFiles.ts";

/**
 * Reading the little this adapter needs from a Pi session file. Built from Pi's
 * source at v1.5.0 and not yet checked on a computer running it.
 *
 * A session file is JSONL, and holds the whole conversation. Pi makes it at a
 * session's first message, with a header line first, and adds to it, one line at a
 * time, with each entry (`_persist` in `session-manager.ts`). So:
 *
 * - The first line is the header, read from the first `MAX_HEAD_BYTES`. Only its
 *   `id`, `timestamp`, `cwd` and `version` are looked at. `parentSession`, which
 *   names another file, and anything Pi adds are dropped with the parsed line.
 * - Of every other line, only one that begins `{"type":"session_info"` is ever
 *   turned into text or parsed, and only its `name` is kept. It is found in the
 *   bytes, and a line that holds a prompt, a reply or a tool's output stays as
 *   bytes: JSON writes a line break inside a string as `\n`, so such a line can
 *   hold those bytes only at its start, and no text in a message can look like
 *   one.
 * - The newest name wins, and an empty one clears it, as in `buildSessionInfo`.
 * - The bytes looked at are the first `MAX_HEAD_BYTES` and the last
 *   `MAX_TAIL_BYTES`, the first time a file is read. After that, as Pi only adds
 *   to a file, only what it added is read, up to `MAX_TAIL_BYTES`.
 * - A file is opened without following a link and only inside a real folder.
 *
 * Each file is opened only when its size, modified time or identity changes.
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a file's start read for its header, which holds two paths at most. */
export const MAX_HEAD_BYTES = 64 * 1024;

/** The most of a file's end read at once for a name. What is said is in these bytes, and stays there. */
export const MAX_TAIL_BYTES = 256 * 1024;

/** The longest line read for a name. Pi sets no limit, and a longer one is no name for a list. */
export const MAX_NAME_LINE_BYTES = 4 * 1024;

/** The newest format this reads. A higher one is a newer Pi's. Older ones are read as they are. */
export const SESSION_VERSION = 3;

/** A session's id as `assertValidSessionId` allows, of 200 characters or less. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/;

/** A time as Pi writes one, with `Date.toISOString()`. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The longest folder kept. A longer one is not a folder. */
const MAX_CWD_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

const NEWLINE = 0x0a;

/** How a name's line begins, after the line before it ended. */
const NAME_LINE = Buffer.from('\n{"type":"session_info"');

/** What is kept of one session file. */
export interface PiSessionFile {
  id: string;
  /** The session's folder: an absolute path, or null when the header's is not one. */
  cwd: string | null;
  /** `timestamp` in epoch milliseconds, or null when it is not a time. */
  startedAt: number | null;
  /** The newest name the bytes read gave it. */
  ownName: string | null;
}

export type SessionFileRead =
  | { state: "ok"; session: PiSessionFile }
  /** No ordinary file in a real folder, as for a link or a file that went. */
  | { state: "none" }
  /** Not a session file this reads: broken, or wrong types where it counts. */
  | { state: "broken" }
  /** Of a newer format than this reads. */
  | { state: "newer" };

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

function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function folder(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  return pathsOf(platform).isAbsolute(value) ? value : null;
}

/**
 * The kept fields of a header, `"newer"` for one of a newer format, or null for
 * anything else: not a JSON object, or not a session's. A bad value in another
 * field is treated as none. `version` is missing from Pi's first format.
 */
export function parseHeader(
  line: string,
  platform: NodeJS.Platform,
): Omit<PiSessionFile, "ownName"> | "newer" | null {
  const value = parseLine(line);
  if (!isRecord(value) || value.type !== "session") return null;
  const { version, id } = value;
  if (version !== undefined && typeof version !== "number") return null;
  if (typeof version === "number" && version > SESSION_VERSION) return "newer";
  if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
  return { id, cwd: folder(value.cwd, platform), startedAt: timeOf(value.timestamp) };
}

/** The name on a `session_info` line, or null for no name: an empty one, or a bad line. */
export function nameOnLine(line: Buffer): string | null {
  if (line.byteLength > MAX_NAME_LINE_BYTES) return null;
  const value = parseLine(line.toString("utf8"));
  if (!isRecord(value) || value.type !== "session_info") return null;
  return typeof value.name === "string" ? value.name.trim() || null : null;
}

/**
 * What the newest whole `session_info` line in these bytes says, or undefined when
 * they hold none. Only that line is turned into text.
 */
export function newestName(bytes: Buffer): string | null | undefined {
  let from = bytes.byteLength;
  while (from >= 0) {
    const start = bytes.lastIndexOf(NAME_LINE, from);
    if (start < 0) return undefined;
    const end = bytes.indexOf(NEWLINE, start + 1);
    if (end >= 0) return nameOnLine(bytes.subarray(start + 1, end));
    // Half written: the line before it stands until the rest comes.
    from = start - 1;
  }
  return undefined;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export interface SessionFileReader {
  /** What a session file says, given its `lstat`, opened only when that changed. */
  read(ref: SessionFileRef): Promise<SessionFileRead>;
  /** Forgets every file not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
}

interface Reading {
  read: SessionFileRead;
  /** Where the line after the last whole line read begins. */
  readTo: number;
}

interface Remembered extends Reading {
  info: FileInfo;
}

const NONE: Reading = { read: { state: "none" }, readTo: 0 };
const BROKEN: Reading = { read: { state: "broken" }, readTo: 0 };

/** A reader of session files, which keeps what it read of each until it changes. */
export function createSessionFileReader(
  sessionsDir: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): SessionFileReader {
  const remembered = new Map<string, Remembered>();

  /** The bytes from the line at `from` to the end, at most `MAX_TAIL_BYTES`, for a name. */
  async function scan(
    file: OpenFile,
    from: number,
  ): Promise<{ name: string | null | undefined; readTo: number }> {
    const { size } = file.info;
    // One byte before the line, so that the line before's end is there to find.
    const start = Math.max(0, from - 1, size - MAX_TAIL_BYTES);
    const bytes = asBuffer(await file.read(start, size - start));
    const end = bytes.lastIndexOf(NEWLINE);
    return { name: newestName(bytes), readTo: end < 0 ? from : start + end + 1 };
  }

  async function fromTheStart(file: OpenFile): Promise<Reading> {
    const head = asBuffer(await file.read(0, MAX_HEAD_BYTES));
    const end = head.indexOf(NEWLINE);
    // Half written, or a first line too long to be a header.
    if (end < 0) return BROKEN;
    const header = parseHeader(head.toString("utf8", 0, end), platform);
    if (header === "newer") return { read: { state: "newer" }, readTo: 0 };
    if (header === null) return BROKEN;
    const readTo = head.lastIndexOf(NEWLINE) + 1;
    const ownName = newestName(head) ?? null;
    const session = { ...header, ownName };
    if (readTo >= file.info.size) return { read: { state: "ok", session }, readTo };
    return addedTo(file, session, readTo);
  }

  async function addedTo(file: OpenFile, session: PiSessionFile, from: number): Promise<Reading> {
    const { name, readTo } = await scan(file, from);
    const next = name === undefined ? session : { ...session, ownName: name };
    return { read: { state: "ok", session: next }, readTo };
  }

  async function readFile(ref: SessionFileRef, known: Remembered | undefined): Promise<Reading> {
    // A link at the folder's name would lead out of the sessions folder, and
    // opening a file does not look at the names before its own.
    const parent = path.dirname(ref.path);
    if (parent !== sessionsDir && (await io.lstat(parent)).kind !== "directory") return NONE;
    const file = await io.openRegular(ref.path);
    try {
      if (
        known?.read.state === "ok" &&
        known.info.ino === file.info.ino &&
        known.readTo <= file.info.size
      ) {
        return await addedTo(file, known.read.session, known.readTo);
      }
      return await fromTheStart(file);
    } finally {
      await file.close();
    }
  }

  return {
    async read(ref) {
      const known = remembered.get(ref.path);
      if (known && sameFile(known.info, ref.info)) return known.read;
      try {
        const reading = await readFile(ref, known);
        remembered.set(ref.path, { ...reading, info: ref.info });
        return reading.read;
      } catch {
        // Gone since its `lstat`, or a read error: what was read of it stands, and
        // it is tried again on the next poll, since nothing here took note of it.
        return known?.read ?? NONE.read;
      }
    },
    keepOnly(paths) {
      for (const file of remembered.keys()) if (!paths.has(file)) remembered.delete(file);
    },
  };
}
