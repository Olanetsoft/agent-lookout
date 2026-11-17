import {
  mayBeIdle,
  mayBeWorking,
  type JournalRecord,
  type QueueState,
  type TrailEntry,
} from "../../../core/mapping/prime-agent/primeAgentMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { INSTANT } from "../pi/sessionFile.ts";

/**
 * Reading a Prime Agent worker's recovery journal, for the steps it took and
 * whether its queue is parked, and nothing else. Built from Prime Agent's
 * source at v0.10.3 and not yet checked on a computer running it.
 *
 * A daemon worker keeps one journal, `daemon-workers/<hash>/<worker ID>.recovery.jsonl`
 * (`launch_worker` in `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`),
 * and adds lines to it, each one JSON object written by `serde_json` from a
 * `Value` that keeps its fields in the order they are declared
 * (`append_record` in `journal.rs`, and `preserve_order` in `Cargo.toml`).
 * There are two kinds:
 *
 * - A record line, `WorkerRecoveryRecord`:
 *   `{"activeSessionId":"…","sessionId":"…","sessionFile":"…","busy":true,"operation":"…","recordedAt":"…"}`,
 *   with `sessionFile` left out when the worker has no file.
 * - A queue line, `WorkerQueueSnapshotRecord`:
 *   `{"version":2,"type":"queue_snapshot","active_session_id":"…","steering":[…],"follow_up":[…],"suspended":false,"recorded_at":"…"}`,
 *   whose lanes hold the messages queued for the session, with their text.
 *
 * So the reader:
 *
 * - takes a line as a record only when, as bytes, it begins
 *   `{"activeSessionId":"`, is at most 4 KiB and ends
 *   `,"recordedAt":"<time>"}`. Only then is it turned into text and parsed,
 *   and only its session, the name of its file without its folders, `busy`,
 *   its step and its time are kept;
 * - takes a line as a queue line when, as bytes, it begins
 *   `{"version":2,"type":"queue_snapshot","active_session_id":"`. Only the
 *   worker's ID after that and the time at its end are turned into text.
 *   Whether the queue is parked is told by which of the two endings
 *   `,"suspended":true,"recorded_at":"` and `,"suspended":false,"recorded_at":"`
 *   comes before the time, compared as bytes. The lanes between are never
 *   turned into text, parsed or kept. A `"` inside a JSON string is always
 *   written `\"`, so those bytes can only be the line's own structure;
 * - leaves every other line as bytes, the queue lines of the first format
 *   among them.
 *
 * The first read of a journal is of its last 1 MiB, and after that only what
 * was added, at most 8 MiB on one poll: past that, the last 1 MiB is read
 * again. Prime Agent rewrites the file whole, under the same name, when every
 * session it holds is idle and when its end was torn, so a file with another
 * identity, or one that shrank, is read from its start again. Only when the
 * slot's run of idle records began is carried over that rewrite, which leaves
 * only the slot's newest record. A last line with no newline yet is left for
 * the next read. Nothing here writes, renames, locks or deletes anything, and
 * the journal's `.writer-lock` is never opened.
 */

/** A worker's journal, after its ID. */
export const JOURNAL_SUFFIX = ".recovery.jsonl";

/** The most of a journal's end read the first time, and after a jump. */
export const FIRST_READ_BYTES = 1024 * 1024;

/** The most of what was added read on one poll. Past it, the end is read again. */
export const MAX_ADDED_BYTES = 8 * 1024 * 1024;

/** The longest record line read. Prime Agent's are a few hundred bytes. */
export const MAX_RECORD_LINE_BYTES = 4 * 1024;

/** The longest worker ID read from a queue line. Prime Agent's have 12 characters. */
export const MAX_WORKER_ID_BYTES = 128;

/** The shortest and the longest time read: Prime Agent writes 24 bytes. */
const MIN_TIME_BYTES = 20;
const MAX_TIME_BYTES = 30;

/** The most record lines kept, newest last, for the time a working run began. */
export const MAX_TRAIL = 256;

const NEWLINE = 0x0a;
const QUOTE = 0x22;

const RECORD_START = Buffer.from('{"activeSessionId":"');
const RECORD_TIME = Buffer.from(',"recordedAt":"');
const QUEUE_START = Buffer.from('{"version":2,"type":"queue_snapshot","active_session_id":"');
const PARKED = Buffer.from(',"suspended":true,"recorded_at":"');
const NOT_PARKED = Buffer.from(',"suspended":false,"recorded_at":"');
const LINE_END = Buffer.from('"}');

/** The bytes of a worker's ID: letters, digits, `_` and `-`. */
const ID_BYTE = /^[A-Za-z0-9_-]$/;

/** The bytes of a time: digits and `-:.TZ+`. */
const TIME_BYTE = /^[0-9:.TZ+-]$/;

/**
 * Bytes as text, when there are at most `max` of them, or null. The one way
 * any byte of a journal is turned into text.
 */
export function decodeAtMost(bytes: Buffer, max: number): string | null {
  return bytes.byteLength <= max ? bytes.toString("utf8") : null;
}

function startsWith(line: Buffer, start: Buffer): boolean {
  return line.byteLength >= start.byteLength && line.subarray(0, start.byteLength).equals(start);
}

/** Whether every byte is one a pattern of one character allows. */
function allBytes(bytes: Buffer, allowed: RegExp): boolean {
  for (const byte of bytes) if (!allowed.test(String.fromCharCode(byte))) return false;
  return true;
}

/**
 * The time at the end of a line that ends `<key>"<time>"}`, with which of the
 * keys came before it, or null. Nothing is turned into text but the time.
 */
function timeAtEnd(line: Buffer, keys: readonly Buffer[]): { key: Buffer; at: number } | null {
  if (line.byteLength < LINE_END.byteLength) return null;
  const end = line.byteLength - LINE_END.byteLength;
  if (!line.subarray(end).equals(LINE_END)) return null;
  const open = line.lastIndexOf(QUOTE, end - 1);
  if (open < 0) return null;
  const time = line.subarray(open + 1, end);
  if (time.byteLength < MIN_TIME_BYTES || time.byteLength > MAX_TIME_BYTES) return null;
  if (!allBytes(time, TIME_BYTE)) return null;
  const key = keys.find((each) => {
    const from = open + 1 - each.byteLength;
    return from >= 0 && line.subarray(from, open + 1).equals(each);
  });
  if (key === undefined) return null;
  const text = decodeAtMost(time, MAX_TIME_BYTES);
  if (text === null || !INSTANT.test(text)) return null;
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : { key, at };
}

/** The name of a file without its folders, on any system. */
function lastName(file: string): string {
  return file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
}

/** What one record line says, with its worker's ID, or null for any line that is not one. */
export function parseRecordLine(line: Buffer): (JournalRecord & { slot: string }) | null {
  if (line.byteLength > MAX_RECORD_LINE_BYTES || !startsWith(line, RECORD_START)) return null;
  const end = timeAtEnd(line, [RECORD_TIME]);
  if (end === null) return null;
  const text = decodeAtMost(line, MAX_RECORD_LINE_BYTES);
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { activeSessionId, sessionId, sessionFile, busy, operation, recordedAt } = value as Record<
    string,
    unknown
  >;
  if (typeof activeSessionId !== "string" || typeof sessionId !== "string") return null;
  if (typeof operation !== "string" || typeof busy !== "boolean") return null;
  if (typeof recordedAt !== "string" || !INSTANT.test(recordedAt)) return null;
  if (sessionFile !== undefined && typeof sessionFile !== "string") return null;
  return {
    slot: activeSessionId,
    sessionId,
    sessionFile: sessionFile === undefined ? null : lastName(sessionFile),
    busy,
    operation,
    recordedAt: end.at,
  };
}

/**
 * What one queue line says, with its worker's ID: whether the queue is parked,
 * and when. `unreadable` for a line that begins as a queue line and does not
 * end as one, and null for any other line. Only the ID and the time are
 * turned into text.
 */
export function parseQueueLine(
  line: Buffer,
): { slot: string | null; queue: Exclude<QueueState, null> } | null {
  if (!startsWith(line, QUEUE_START)) return null;
  const from = QUEUE_START.byteLength;
  const close = line.indexOf(QUOTE, from);
  const idBytes = close < 0 ? null : line.subarray(from, close);
  const slot =
    idBytes !== null &&
    idBytes.byteLength > 0 &&
    idBytes.byteLength <= MAX_WORKER_ID_BYTES &&
    allBytes(idBytes, ID_BYTE)
      ? decodeAtMost(idBytes, MAX_WORKER_ID_BYTES)
      : null;
  const end = timeAtEnd(line, [PARKED, NOT_PARKED]);
  if (slot === null || end === null) return { slot, queue: "unreadable" };
  return { slot, queue: { suspended: end.key === PARKED, recordedAt: end.at } };
}

/** What is known of one worker's slot from its journal. */
export interface JournalState {
  /** The slot's record lines, oldest first, from the last one that could not say working. */
  trail: readonly TrailEntry[];
  /** The slot's newest queue line. */
  queue: QueueState;
  /**
   * When the slot's run of idle records of one session, to its newest, began,
   * in epoch milliseconds, or null when its newest is not idle. A `turn_end`
   * always starts a run.
   */
  idleSince: number | null;
}

/** What a read keeps as it goes. */
interface Taking {
  trail: TrailEntry[];
  queue: QueueState;
  idleSince: number | null;
  /** The slot's newest record before the file was rewritten, until a record is read after it. */
  carried?: JournalRecord;
}

/** A read with nothing kept from before. */
function afresh(): Taking {
  return { trail: [], queue: null, idleSince: null };
}

/** A read of a file Prime Agent rewrote, with when the run of idle records began and the newest record before. */
function carriedOver(known: Taking): Taking {
  return {
    trail: [],
    queue: null,
    idleSince: known.idleSince,
    carried: known.trail.at(-1)?.record ?? known.carried,
  };
}

/** Takes in one whole line, for one worker's slot. Lines of another slot are left. */
function take(state: Taking, line: Buffer, slot: string): void {
  const record = parseRecordLine(line);
  if (record !== null) {
    if (record.slot !== slot) return;
    const kept: JournalRecord = {
      sessionId: record.sessionId,
      sessionFile: record.sessionFile,
      busy: record.busy,
      operation: record.operation,
      recordedAt: record.recordedAt,
    };
    // An idle record goes on the run of idle records before it, while that is the same
    // session's. A turn_end never does: its turn was admitted with a busy record
    // (worker/input.rs:143-147; worker/turn.rs:89-92, :1153-1162), which a rewrite may have dropped.
    const previous = state.trail.at(-1)?.record ?? state.carried;
    state.carried = undefined;
    state.idleSince = !mayBeIdle(kept)
      ? null
      : kept.operation !== "turn_end" &&
          previous !== undefined &&
          mayBeIdle(previous) &&
          previous.sessionId === kept.sessionId &&
          previous.sessionFile === kept.sessionFile
        ? (state.idleSince ?? previous.recordedAt)
        : kept.recordedAt;
    const entry = { record: kept, queue: state.queue };
    // A line that cannot say working ends any run before it.
    if (!mayBeWorking(kept)) state.trail = [entry];
    else {
      state.trail.push(entry);
      if (state.trail.length > MAX_TRAIL) state.trail.shift();
    }
    return;
  }
  const queue = parseQueueLine(line);
  // A queue line whose ID cannot be read may be this slot's, so it is taken as unreadable.
  if (queue !== null && (queue.slot === null || queue.slot === slot)) state.queue = queue.queue;
}

/** Where a read of bytes ends: after its last whole line. */
function takeLines(state: Taking, bytes: Buffer, slot: string, skipFirst: boolean): number {
  let start = 0;
  if (skipFirst) {
    // The read began inside a line, whose start was not read.
    const first = bytes.indexOf(NEWLINE);
    if (first < 0) return 0;
    start = first + 1;
  }
  for (;;) {
    const end = bytes.indexOf(NEWLINE, start);
    if (end < 0) return start;
    take(state, bytes.subarray(start, end), slot);
    start = end + 1;
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

interface Cached {
  info: FileInfo;
  slot: string;
  /** Where the line after the last whole line read begins. */
  readTo: number;
  state: Taking;
}

export interface JournalReader {
  /**
   * What a worker's journal says of its slot, given the journal's `lstat`,
   * read only as far as it grew since the last read. Null when it cannot be
   * read. Never rejects.
   */
  read(file: string, info: FileInfo, slot: string): Promise<JournalState | null>;
  /** Forgets every journal not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createJournalReader(io: ReadOnlyIo): JournalReader {
  const cached = new Map<string, Cached>();

  /** The end of a journal, from at most `FIRST_READ_BYTES` before its end. */
  async function fromTheEnd(open: OpenFile, slot: string, state: Taking): Promise<Cached> {
    const { size } = open.info;
    const start = Math.max(0, size - FIRST_READ_BYTES);
    const bytes = asBuffer(await open.read(start, size - start));
    const readTo = start + takeLines(state, bytes, slot, start > 0);
    return { info: open.info, slot, readTo, state };
  }

  async function readFile(file: string, slot: string, known: Cached | undefined): Promise<Cached> {
    const open = await io.openRegular(file);
    try {
      const { size, ino } = open.info;
      const grew =
        known !== undefined &&
        known.slot === slot &&
        known.info.ino === ino &&
        known.readTo <= size &&
        size - known.readTo <= MAX_ADDED_BYTES;
      if (!grew) {
        // Rewritten by Prime Agent, which keeps the slot's newest record. Past
        // a jump, the lines that were not read could have said anything.
        const rewritten =
          known?.slot === slot && (known.info.ino !== ino || size < known.readTo) ? known : null;
        return await fromTheEnd(
          open,
          slot,
          rewritten === null ? afresh() : carriedOver(rewritten.state),
        );
      }
      const bytes = asBuffer(await open.read(known.readTo, size - known.readTo));
      const state: Taking = { ...known.state, trail: [...known.state.trail] };
      const readTo = known.readTo + takeLines(state, bytes, slot, false);
      return { info: open.info, slot, readTo, state };
    } finally {
      await open.close();
    }
  }

  return {
    async read(file, info, slot) {
      const known = cached.get(file);
      if (
        known &&
        known.slot === slot &&
        known.info.ino === info.ino &&
        known.info.size === info.size &&
        known.info.mtimeMs === info.mtimeMs
      ) {
        return known.state;
      }
      try {
        const next = await readFile(file, slot, known);
        cached.set(file, next);
        return next.state;
      } catch {
        // Gone since its lookup, or not to be read: tried again on the next poll.
        cached.delete(file);
        return null;
      }
    },
    keepOnly(files) {
      for (const file of cached.keys()) if (!files.has(file)) cached.delete(file);
    },
  };
}
