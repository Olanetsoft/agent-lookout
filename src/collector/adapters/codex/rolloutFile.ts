import { isImportedCodexTurn } from "../../../core/mapping/codexMapping.ts";
import type { ReadOnlyIo, FileInfo, OpenFile } from "../../files/readOnlyIo.ts";

/**
 * Reading one Codex session file, a rollout, for the little this adapter needs.
 *
 * A rollout is JSON Lines. Each line is
 * `{"timestamp":"<UTC time>","type":"<item>","payload":{...}}`
 * (codex-rs/history/src/lib.rs, `RolloutLine`). It holds the whole
 * conversation, so it is read narrowly and almost nothing is kept:
 *
 * - From the head, the first `session_meta` line, and from it only `id`,
 *   `timestamp`, `cwd`, `source`, `thread_source`, `parent_thread_id`,
 *   `originator` and `cli_version`. The same line also carries the base
 *   instructions, tool definitions, git details and account ids, which are dropped.
 * - From the tail, the last turn line, an `event_msg` whose `payload.type` is
 *   `task_started`, `task_complete` or `turn_aborted` (or another name that
 *   starts with `task_` or `turn_`), with its time and whether its `turn_id`
 *   marks a turn imported from another agent, and the time of the last line.
 *
 * Nothing else is kept: no prompt, reply, command or file content. `JSON.parse`
 * runs only on a line that names `session_meta`, or names `event_msg` and looks
 * like a turn line, so message lines are never parsed.
 *
 * Every read is bounded: 2 MiB for the head and 8 MiB for the tail. After the
 * first read, only what was appended since is read. A last line that is still
 * being written is left for the next read.
 */

/** The most of a file's start that is searched for its `session_meta` line. */
export const HEAD_LIMIT_BYTES = 2 * 1024 * 1024;

/** The most of a file's end that is searched for its last turn line, and the most read onward at once. */
export const TAIL_LIMIT_BYTES = 8 * 1024 * 1024;

/** The head is searched in this much first, which holds the `session_meta` line of an ordinary file. */
const FIRST_HEAD_BYTES = 256 * 1024;

/** The tail is read backwards in pieces of this size. */
const TAIL_CHUNK_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

/**
 * A session's `source`, made small: a string as it was, or an object such as
 * `{"custom":"chatgpt"}` with each value kept only when it is a string.
 */
export type CodexSource = string | Readonly<Record<string, string | true>>;

/** The only fields kept from a `session_meta` line. */
export interface RolloutMeta {
  id?: string;
  /** When the session was created, as Codex wrote it: an ISO 8601 time in UTC. */
  timestamp?: string;
  cwd?: string;
  source?: CodexSource;
  threadSource?: string;
  parentThreadId?: string;
  /** The program that created the session, such as `codex_cli_rs` or `Codex Desktop`. */
  originator?: string;
  /** The Codex version that created the session, such as `0.160.0`. */
  cliVersion?: string;
}

/** What is known about one rollout file. */
export interface RolloutState {
  /** Null when no complete `session_meta` line was found in the head. */
  meta: RolloutMeta | null;
  /**
   * The `payload.type` of the last turn line. Null when the whole file has been
   * read and holds none. Undefined when none was found within the scan limit.
   */
  lastTurn: string | null | undefined;
  /** Epoch milliseconds of the last turn line, when it has a time. */
  lastTurnAt: number | null;
  /**
   * True when the last turn line is one Codex copied in from another agent's
   * session, not a turn Codex ran: the session has been imported and not used since.
   */
  lastTurnImported: boolean;
  /** Epoch milliseconds of the last complete line that has a time. */
  lastLineAt: number | null;
}

/** Codex writes times as `YYYY-MM-DDTHH:MM:SS.mmmZ`. Anything else is not read as a time. */
const CODEX_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Epoch milliseconds of a time Codex wrote, or null. Whether it could be right is decided where the clock is known. */
export function parseCodexTime(value: unknown): number | null {
  if (typeof value !== "string" || !CODEX_TIME.test(value)) return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

/** A line's time, read from its start without parsing the line. Codex writes `timestamp` first. */
const LINE_TIME = /^\{"timestamp":"([^"]{1,64})"/;

/** A hint that a line may be a turn line, checked before it is parsed. */
const TURN_HINT = /"type":"(?:task|turn)_/;

/** A turn line's `payload.type`. */
const TURN_TYPE = /^(?:task|turn)_/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A short label, such as a version or a program's name. Anything longer is not one, and is not kept. */
function label(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : undefined;
}

function compactSource(value: unknown): CodexSource | undefined {
  if (typeof value === "string") return text(value);
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([kind, detail]) => [
      kind,
      typeof detail === "string" ? detail : (true as const),
    ]),
  );
}

function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The kept fields of a `session_meta` line, or null when the line is not one. */
export function readMetaLine(line: string): RolloutMeta | null {
  if (!line.includes('"session_meta"')) return null;
  const value = parse(line);
  if (!value || value.type !== "session_meta" || !isRecord(value.payload)) return null;
  const payload = value.payload;
  const meta: RolloutMeta = {
    id: text(payload.id),
    timestamp: text(payload.timestamp),
    cwd: text(payload.cwd),
    source: compactSource(payload.source),
    threadSource: text(payload.thread_source),
    parentThreadId: text(payload.parent_thread_id),
    originator: label(payload.originator),
    cliVersion: label(payload.cli_version),
  };
  for (const key of Object.keys(meta) as (keyof RolloutMeta)[]) {
    if (meta[key] === undefined) delete meta[key];
  }
  return meta;
}

export interface TurnLine {
  turn: string;
  at: number | null;
  /** The turn was copied in from another agent's session, not run by Codex. */
  imported: boolean;
}

/** A turn line's type, time and whether it was imported, or null when the line is not a turn line. */
export function readTurnLine(line: string): TurnLine | null {
  if (!line.includes('"event_msg"') || !TURN_HINT.test(line)) return null;
  const value = parse(line);
  if (!value || value.type !== "event_msg" || !isRecord(value.payload)) return null;
  const turn = value.payload.type;
  if (typeof turn !== "string" || !TURN_TYPE.test(turn)) return null;
  return {
    turn,
    at: parseCodexTime(value.timestamp),
    imported: isImportedCodexTurn(value.payload.turn_id),
  };
}

/** A line's time, or null. */
function lineTime(line: string): number | null {
  const match = LINE_TIME.exec(line);
  return match ? parseCodexTime(match[1]) : null;
}

function bytes(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a file that shrank while being read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = bytes(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

/** The first complete `session_meta` line within the head limit. */
async function readHead(file: OpenFile, size: number): Promise<RolloutMeta | null> {
  for (const limit of [FIRST_HEAD_BYTES, HEAD_LIMIT_BYTES]) {
    const length = Math.min(limit, size);
    const head = await readExactly(file, 0, length);
    // Each line that names `session_meta` is tried in turn, and only those:
    // one search moves forward through the head, so it is read once.
    let named = head.indexOf('"session_meta"');
    while (named !== -1) {
      const end = head.indexOf(NEWLINE, named);
      // The line goes on past what was read: read more, or give up at the limit.
      if (end === -1) break;
      const start = named > 0 ? head.lastIndexOf(NEWLINE, named - 1) + 1 : 0;
      const meta = readMetaLine(head.toString("utf8", start, end));
      if (meta) return meta;
      named = head.indexOf('"session_meta"', end + 1);
    }
    if (length >= size) return null;
  }
  return null;
}

interface Tail {
  lastTurn: string | null | undefined;
  lastTurnAt: number | null;
  lastTurnImported: boolean;
  lastLineAt: number | null;
  /** Where the complete lines end. Null when no line end was found within the limit. */
  end: number | null;
}

/**
 * Reads backwards from the end until it finds a turn line, reaches the start
 * of the file, or has read the tail limit. The bytes after the last newline are
 * a line still being written, and are left alone.
 */
async function scanTail(file: OpenFile, size: number): Promise<Tail> {
  let position = size;
  let budget = TAIL_LIMIT_BYTES;
  /** The bytes from `position` to the first newline after it: not yet known to be a whole line. */
  let fragment: Buffer = Buffer.alloc(0);
  let end: number | null = null;
  let lastLineAt: number | null = null;

  /** Takes one complete line. Returns the turn line when this is one. */
  const take = (line: string) => {
    if (line.trim() === "") return null;
    const turn = readTurnLine(line);
    lastLineAt ??= lineTime(line) ?? turn?.at ?? null;
    return turn;
  };
  const found = (turn: TurnLine): Tail => ({
    lastTurn: turn.turn,
    lastTurnAt: turn.at,
    lastTurnImported: turn.imported,
    lastLineAt,
    end,
  });

  while (position > 0 && budget > 0) {
    const length = Math.min(TAIL_CHUNK_BYTES, position, budget);
    const start = position - length;
    const chunk = await readExactly(file, start, length);
    budget -= length;
    position = start;
    const buffer = fragment.byteLength > 0 ? Buffer.concat([chunk, fragment]) : chunk;

    let cut = buffer.byteLength;
    if (end === null) {
      const last = buffer.lastIndexOf(NEWLINE);
      if (last === -1) {
        fragment = buffer;
        continue;
      }
      end = start + last + 1;
      cut = last;
    }

    let newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    while (newline !== -1) {
      const turn = take(buffer.toString("utf8", newline + 1, cut));
      if (turn) return found(turn);
      cut = newline;
      newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    }

    if (start === 0) {
      const turn = take(buffer.toString("utf8", 0, cut));
      if (turn) return found(turn);
      // The whole file has been read and holds no turn line.
      return { lastTurn: null, lastTurnAt: null, lastTurnImported: false, lastLineAt, end };
    }
    fragment = buffer.subarray(0, cut);
  }

  // The start was reached with no complete line at all, or the limit with no turn line.
  if (position === 0) {
    return { lastTurn: null, lastTurnAt: null, lastTurnImported: false, lastLineAt, end: end ?? 0 };
  }
  return { lastTurn: undefined, lastTurnAt: null, lastTurnImported: false, lastLineAt, end };
}

/** What is cached for one file between polls. */
interface Cached extends RolloutState {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the lines read so far end, always at a line's start. Null when not known. */
  offset: number | null;
}

function stateOf(cached: Cached): RolloutState {
  return {
    meta: cached.meta,
    lastTurn: cached.lastTurn,
    lastTurnAt: cached.lastTurnAt,
    lastTurnImported: cached.lastTurnImported,
    lastLineAt: cached.lastLineAt,
  };
}

export interface RolloutReader {
  /**
   * What is known about a file, read only as far as it changed since the last
   * call. `info` is what a `lstat` of it said this poll. Throws when the file
   * cannot be read; the caller skips it for this poll.
   */
  read(file: string, info: FileInfo): Promise<RolloutState>;
  /** Forgets every file not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createRolloutReader(io: ReadOnlyIo): RolloutReader {
  const cache = new Map<string, Cached>();

  async function readFresh(file: string): Promise<Cached> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const meta = await readHead(handle, info.size);
      const tail = await scanTail(handle, info.size);
      return {
        meta,
        lastTurn: tail.lastTurn,
        lastTurnAt: tail.lastTurnAt,
        lastTurnImported: tail.lastTurnImported,
        lastLineAt: tail.lastLineAt,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: tail.end,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads only what was appended since the last read. Returns null when the file
   * has to be read afresh: it is a different file, it shrank, it was rewritten
   * in place, too much was added at once, or it had no `session_meta` line yet.
   */
  async function readOnward(file: string, cached: Cached, info: FileInfo): Promise<Cached | null> {
    const offset = cached.offset;
    if (cached.meta === null || offset === null) return null;
    if (info.ino !== cached.ino || info.size <= cached.size || info.size < offset) return null;
    if (info.size - offset > TAIL_LIMIT_BYTES) return null;

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      if (opened.ino !== cached.ino || opened.size < offset) return null;
      // One byte more than the new lines, so the newline before them can be checked.
      // If it is not there, the file was rewritten and the offset means nothing.
      const from = offset > 0 ? offset - 1 : 0;
      const read = await readExactly(handle, from, opened.size - from);
      if (offset > 0 && read[0] !== NEWLINE) return null;
      const added = offset > 0 ? read.subarray(1) : read;

      const next: Cached = {
        ...cached,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
      };
      let start = 0;
      let newline = added.indexOf(NEWLINE);
      while (newline !== -1) {
        const line = added.toString("utf8", start, newline);
        if (line.trim() !== "") {
          const turn = readTurnLine(line);
          const at = lineTime(line) ?? turn?.at ?? null;
          if (at !== null) next.lastLineAt = at;
          if (turn) {
            next.lastTurn = turn.turn;
            next.lastTurnAt = turn.at;
            next.lastTurnImported = turn.imported;
          }
        }
        start = newline + 1;
        newline = added.indexOf(NEWLINE, start);
      }
      next.offset = offset + start;
      return next;
    } finally {
      await handle.close();
    }
  }

  return {
    async read(file, info) {
      const cached = cache.get(file);
      if (
        cached &&
        cached.ino === info.ino &&
        cached.size === info.size &&
        cached.mtimeMs === info.mtimeMs
      ) {
        return stateOf(cached);
      }
      const next = (cached && (await readOnward(file, cached, info))) || (await readFresh(file));
      cache.set(file, next);
      return stateOf(next);
    },
    keepOnly(files) {
      for (const file of cache.keys()) {
        if (!files.has(file)) cache.delete(file);
      }
    },
  };
}
