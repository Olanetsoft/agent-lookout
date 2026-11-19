import path from "node:path";

import {
  emptyGrokBuildTurn,
  type GrokBuildOutcome,
  type GrokBuildTurn,
} from "../../../core/mapping/grok-build/grokBuildMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isMissing } from "../../files/readOnlyIo.ts";
import { bytesAt } from "../autohand-code/jsonBytes.ts";
import { trustedFile } from "./folders.ts";

/**
 * Reading the little this adapter needs from a Grok Build session's event
 * log, `<session folder>/events.jsonl`. Built from Grok Build's source at
 * 1.0.45 (commit 2bdd1d6) and not yet checked on a machine running it.
 *
 * The session's own process adds each event as one line, in one write, at the
 * log's end, and never rewrites one (`xai-grok-session-events/src/log.rs:62-81`).
 * Each is `{"ts":"<time>","type":"<kind>",…}`, its time in UTC to the
 * millisecond (`log.rs:12-17`, `:64`, `types.rs:5-7`). So:
 *
 * - The first time, the end is read backwards, 64 KiB at a time and at most
 *   8 MiB, and the line break before it, from the newest whole line to the
 *   newest that starts or ends a turn, and the lines from there on are folded.
 *   A whole log of 8 MiB or less with neither has no turn yet. One whose
 *   newest such line is not in its last 8 MiB, or that has more than 8 MiB
 *   after it, says nothing.
 * - After that, only what was added is read, at most 8 MiB at once, and folded
 *   the same way, so what is kept is what a first read of the same file gives.
 *   A log that shrank, was replaced, or does not go on from the last line
 *   read, is read from its end again. Bytes after the last line break are a
 *   line still being written, and wait until it is whole.
 * - A line counts only when it begins `{"ts":"<time>","type":"<kind>"`, its
 *   kind of `a`-`z`, digits and `_`, ends with `}`, and has no second
 *   `{"ts":"` in it, as two lines run together by a crash would. Of a line
 *   that counts only its first 512 bytes are compared, with the few words
 *   below, each right after the kind but `schema_version`, which is looked for
 *   anywhere after it. Each word begins `,"`, and JSON writes a quote inside
 *   a string as `\"`, so nothing a model, a tool, a hook or a server put in a
 *   field can match. Any other line at or after the newest that starts or
 *   ends a turn says nothing can be told.
 *
 * Of each line only its time, its kind and these are kept, as numbers and
 * flags:
 *
 * - `turn_started` with `,"schema_version":"1.`: a turn under way.
 * - `turn_ended` with `,"outcome":"` and `completed`, `cancelled`, `error` or
 *   `interrupted` first: how it ended. Its reasons are never looked at.
 * - `tool_started` with `,"tool_name":"ask_user_question"}`: a question,
 *   closed by a `tool_completed` with `,"tool_name":"ask_user_question",`, a
 *   new round, `loop_started`, or `phase_changed` to `waiting_for_model`.
 *   With `,"tool_name":"exit_plan_mode"}`: a plan put for approval.
 * - A first token, a tool call, a permission check, or `phase_changed` to
 *   text, reasoning, a tool or a permission prompt: the model wrote.
 *
 * Each file is opened without following a link, only as an ordinary file
 * with one name of the user Agent Lookout runs as, and only when its size,
 * modified time or identity changed. A read that fails is never kept. Nothing
 * here writes, renames, deletes or locks anything.
 */

export const EVENTS_FILE = "events.jsonl";

/** How much of a log's end is read at a time, going backwards. */
export const PIECE_BYTES = 64 * 1024;

/** The most of a log's end read, and of what was added read at once, each with the line break before it. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** The most of each line compared. */
export const HEAD_BYTES = 512;

const NEWLINE = 0x0a;
const CLOSE_BRACE = 0x7d;
const QUOTE = 0x22;

const LINE_START = Buffer.from('{"ts":"');
const TYPE_KEY = Buffer.from('","type":"');
/** `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
const TIME_LENGTH = 24;
const TYPE_AT = LINE_START.byteLength + TIME_LENGTH + TYPE_KEY.byteLength;
const MAX_KIND_BYTES = 64;

const kind = (word: string) => Buffer.from(word);
const TURN_STARTED = kind("turn_started");
const TURN_ENDED = kind("turn_ended");
const TOOL_STARTED = kind("tool_started");
const TOOL_COMPLETED = kind("tool_completed");
const LOOP_STARTED = kind("loop_started");
const PHASE_CHANGED = kind("phase_changed");
const FIRST_TOKEN = kind("first_token");
const PERMISSION_REQUESTED = kind("permission_requested");
const PERMISSION_RESOLVED = kind("permission_resolved");

const SCHEMA_1 = Buffer.from(',"schema_version":"1.');
const OUTCOME = Buffer.from(',"outcome":"');
const OUTCOMES: readonly Exclude<GrokBuildOutcome, "other">[] = [
  "completed",
  "cancelled",
  "error",
  "interrupted",
];
const OUTCOME_WORDS = OUTCOMES.map((word) => Buffer.from(`${word}"`));
const ASK_STARTED = Buffer.from(',"tool_name":"ask_user_question"}');
const PLAN_STARTED = Buffer.from(',"tool_name":"exit_plan_mode"}');
const ASK_COMPLETED = Buffer.from(',"tool_name":"ask_user_question",');
const WAITING_FOR_MODEL = Buffer.from(',"phase":"waiting_for_model"}');
const OUTPUT_PHASES = [
  "streaming_text",
  "streaming_reasoning",
  "tool_execution",
  "permission_prompt",
].map((phase) => Buffer.from(`,"phase":"${phase}"}`));

const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const isKindByte = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x61 && byte <= 0x7a) || isDigit(byte) || byte === 0x5f);

/** The number the digits at `at` make, or null when one is not a digit. */
function digitsAt(line: Buffer, at: number, count: number): number | null {
  let value = 0;
  for (let index = at; index < at + count; index += 1) {
    const byte = line[index];
    if (!isDigit(byte)) return null;
    value = value * 10 + ((byte as number) - 0x30);
  }
  return value;
}

/** The time `YYYY-MM-DDTHH:MM:SS.mmmZ` at `at`, worked out from its digits, or null. */
export function timeAt(line: Buffer, at: number): number | null {
  const marks: [number, number][] = [
    [4, 0x2d],
    [7, 0x2d],
    [10, 0x54],
    [13, 0x3a],
    [16, 0x3a],
    [19, 0x2e],
    [23, 0x5a],
  ];
  for (const [offset, byte] of marks) if (line[at + offset] !== byte) return null;
  const year = digitsAt(line, at, 4);
  const month = digitsAt(line, at + 5, 2);
  const day = digitsAt(line, at + 8, 2);
  const hours = digitsAt(line, at + 11, 2);
  const minutes = digitsAt(line, at + 14, 2);
  const seconds = digitsAt(line, at + 17, 2);
  const ms = digitsAt(line, at + 20, 3);
  if (
    year === null ||
    month === null ||
    day === null ||
    hours === null ||
    minutes === null ||
    seconds === null ||
    ms === null
  ) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || hours > 23 || minutes > 59 || seconds > 59) return null;
  const value = Date.UTC(year, month - 1, day, hours, minutes, seconds, ms);
  // A day past its month's end rolls over, and is not a time Grok Build writes.
  return new Date(value).getUTCDate() === day ? value : null;
}

/** What one line does to the fold. */
export type LogLine =
  /** Not a line Grok Build writes. */
  | { sort: "malformed" }
  | { sort: "started"; at: number; schemaOk: boolean }
  | { sort: "ended"; at: number; outcome: GrokBuildOutcome }
  /** A line of a turn's own. */
  | {
      sort: "turn";
      at: number;
      output: boolean;
      askOpened: boolean;
      askClosed: boolean;
      planCalled: boolean;
      askCleared: boolean;
    }
  /** A line that counts and is not a turn's: a session's own, such as an MCP server's. */
  | { sort: "other" };

/** Whether `word`, then the line's end, is at `at`, the end being the index of its line break. */
function endsWith(line: Buffer, at: number, word: Buffer, end: number): boolean {
  return at + word.byteLength === end && bytesAt(line, at, word);
}

/**
 * What the line from `start` to its line break at `end` is. Only its first
 * 512 bytes are compared, and the rest is looked through for a second
 * `{"ts":"` alone.
 */
export function judgeLine(data: Buffer, start: number, end: number): LogLine {
  const malformed: LogLine = { sort: "malformed" };
  if (end - start < TYPE_AT + 3 || data[end - 1] !== CLOSE_BRACE) return malformed;
  if (!bytesAt(data, start, LINE_START)) return malformed;
  const at = timeAt(data, start + LINE_START.byteLength);
  if (at === null) return malformed;
  if (!bytesAt(data, start + LINE_START.byteLength + TIME_LENGTH, TYPE_KEY)) return malformed;
  const kindAt = start + TYPE_AT;
  let kindEnd = kindAt;
  while (kindEnd < end && kindEnd - kindAt < MAX_KIND_BYTES && isKindByte(data[kindEnd])) {
    kindEnd += 1;
  }
  if (kindEnd === kindAt || data[kindEnd] !== QUOTE) return malformed;
  // Two lines run together, as a crash in the middle of one leaves them.
  if (data.subarray(start + 1, end).indexOf(LINE_START) >= 0) return malformed;

  const head = data.subarray(start, Math.min(end, start + HEAD_BYTES));
  const after = kindEnd + 1 - start;
  const lineEnd = end - start;
  const is = (word: Buffer) => kindEnd - kindAt === word.byteLength && bytesAt(data, kindAt, word);

  if (is(TURN_STARTED)) {
    const found = head.indexOf(SCHEMA_1, after);
    return { sort: "started", at, schemaOk: found >= 0 };
  }
  if (is(TURN_ENDED)) {
    if (!bytesAt(head, after, OUTCOME)) return { sort: "ended", at, outcome: "other" };
    const wordAt = after + OUTCOME.byteLength;
    const index = OUTCOME_WORDS.findIndex((word) => bytesAt(head, wordAt, word));
    return { sort: "ended", at, outcome: OUTCOMES[index] ?? "other" };
  }
  const turn = {
    sort: "turn" as const,
    at,
    output: false,
    askOpened: false,
    askClosed: false,
    planCalled: false,
    askCleared: false,
  };
  if (is(TOOL_STARTED)) {
    return {
      ...turn,
      output: true,
      askOpened: endsWith(head, after, ASK_STARTED, lineEnd),
      planCalled: endsWith(head, after, PLAN_STARTED, lineEnd),
    };
  }
  if (is(TOOL_COMPLETED)) return { ...turn, askClosed: bytesAt(head, after, ASK_COMPLETED) };
  if (is(LOOP_STARTED)) return { ...turn, askCleared: true };
  if (is(PHASE_CHANGED)) {
    return {
      ...turn,
      askCleared: endsWith(head, after, WAITING_FOR_MODEL, lineEnd),
      output: OUTPUT_PHASES.some((phase) => endsWith(head, after, phase, lineEnd)),
    };
  }
  if (is(FIRST_TOKEN) || is(PERMISSION_REQUESTED)) return { ...turn, output: true };
  if (is(PERMISSION_RESOLVED)) return turn;
  return { sort: "other" };
}

/** The fold after one more line. A line that starts or ends a turn starts it afresh. */
export function foldLine(turn: GrokBuildTurn, line: LogLine): GrokBuildTurn {
  if (line.sort === "started") {
    return { ...emptyGrokBuildTurn(), boundary: "started", at: line.at, schemaOk: line.schemaOk };
  }
  if (line.sort === "ended") {
    return { ...emptyGrokBuildTurn(), boundary: "ended", at: line.at, outcome: line.outcome };
  }
  if (line.sort === "malformed") return { ...turn, malformed: true };
  if (line.sort === "other") return turn;
  const next = { ...turn };
  next.turnLineAt = next.turnLineAt === null ? line.at : Math.max(next.turnLineAt, line.at);
  if (line.output) next.outputSeen = true;
  if (line.askCleared) {
    next.openQuestions = 0;
    next.questionSince = null;
  }
  if (line.askOpened) {
    if (next.openQuestions === 0) next.questionSince = line.at;
    next.openQuestions += 1;
  }
  if (line.askClosed && next.openQuestions > 0) {
    next.openQuestions -= 1;
    if (next.openQuestions === 0) next.questionSince = null;
  }
  if (line.planCalled) next.planToolAt = line.at;
  return next;
}

/** The fold of a log whose newest turn's start or end is not in what can be read. */
function tooFarTurn(): GrokBuildTurn {
  return { ...emptyGrokBuildTurn(), tooFar: true };
}

/** What is kept of one log between polls: numbers and flags, no bytes. */
interface Known {
  /** The log's folder, so a session found in another is read afresh. */
  folder: string;
  /** The open file's size, time and identity as it was read. */
  info: FileInfo;
  turn: GrokBuildTurn;
  /** Just past the last whole line read, or null when no line break was found to go on from. */
  end: number | null;
  /** Where the newest line that starts or ends a turn begins, 0 when there is none, or -1 when it is before what was read. */
  boundaryStart: number;
}

/** The fold, given where the newest turn's line begins and the file's size. */
function settled(turn: GrokBuildTurn, boundaryStart: number, size: number): GrokBuildTurn {
  return boundaryStart < 0 || boundaryStart < size - MAX_LOG_BYTES ? tooFarTurn() : turn;
}

class Changed extends Error {}

async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = await file.read(position, length);
  if (data.byteLength !== length) throw new Changed("The file shrank while it was read.");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Folds the whole lines of `data`, from `from` to `to`, `to` just past a line
 * break. `offset` is where `data` begins in the file. Gives the fold, and
 * where the newest line that starts or ends a turn begins.
 */
function foldLines(
  data: Buffer,
  from: number,
  to: number,
  offset: number,
  turn: GrokBuildTurn,
  boundaryStart: number,
): { turn: GrokBuildTurn; boundaryStart: number } {
  let folded = turn;
  let boundary = boundaryStart;
  let at = from;
  while (at < to) {
    const newline = data.indexOf(NEWLINE, at);
    if (newline < 0 || newline >= to) break;
    const line = judgeLine(data, at, newline);
    if (line.sort === "started" || line.sort === "ended") boundary = offset + at;
    folded = foldLine(folded, line);
    at = newline + 1;
  }
  return { turn: folded, boundaryStart: boundary };
}

/** Reads a log's end backwards, as a first read does. */
async function readFromEnd(file: OpenFile, size: number): Promise<Omit<Known, "folder" | "info">> {
  // The last 8 MiB, and the byte before them, so a line that starts 8 MiB
  // from the end is found whole, as reading onwards finds it.
  const floor = Math.max(0, size - MAX_LOG_BYTES - 1);
  let memory = Buffer.alloc(0);
  /** The bytes held run from here to `size`. */
  let start = size;
  const indexOf = (position: number) => memory.byteLength - (size - position);
  async function more(): Promise<boolean> {
    const want = Math.min(PIECE_BYTES, start - floor);
    if (want <= 0) return false;
    const piece = await readExactly(file, start - want, want);
    const held = size - start;
    if (memory.byteLength < held + want) {
      const grown = Buffer.alloc(
        Math.min(size - floor, Math.max(held + want, 2 * memory.byteLength)),
      );
      memory.copy(grown, grown.byteLength - held, memory.byteLength - held);
      memory = grown;
    }
    piece.copy(memory, indexOf(start - want));
    start -= want;
    return true;
  }
  /** The position of the newest line break before `before`, reading more as needed, or -1 when there is none in reach. */
  async function newlineBefore(before: number): Promise<number> {
    // Where the search goes on from, going down: what is held above it has been searched.
    let from = before - 1;
    for (;;) {
      if (from >= start) {
        const found = memory.lastIndexOf(NEWLINE, indexOf(from));
        if (found >= indexOf(start)) return start + (found - indexOf(start));
        from = start - 1;
      }
      if (!(await more())) return -1;
    }
  }

  const last = await newlineBefore(size);
  if (last < 0) {
    // No whole line: an empty log, or a line still being written, has no turn yet.
    if (floor === 0) return { turn: emptyGrokBuildTurn(), end: 0, boundaryStart: 0 };
    return { turn: tooFarTurn(), end: null, boundaryStart: -1 };
  }
  const end = last + 1;
  let lineEnd = end;
  for (;;) {
    const before = await newlineBefore(lineEnd - 1);
    let lineStart: number;
    if (before >= 0) lineStart = before + 1;
    else if (start === 0) lineStart = 0;
    else return { turn: tooFarTurn(), end, boundaryStart: -1 };
    const line = judgeLine(memory, indexOf(lineStart), indexOf(lineEnd - 1));
    const boundary = line.sort === "started" || line.sort === "ended";
    if (boundary || lineStart === 0) {
      // From the newest line that starts or ends a turn, or from the log's
      // start when it has none, every line is folded as reading onwards does.
      const offset = size - memory.byteLength;
      const folded = foldLines(
        memory,
        indexOf(lineStart),
        indexOf(end),
        offset,
        emptyGrokBuildTurn(),
        0,
      );
      return { turn: folded.turn, end, boundaryStart: folded.boundaryStart };
    }
    lineEnd = lineStart;
  }
}

/** Folds what was added since `known`, or null when the log does not go on from there. */
async function readOnwards(
  file: OpenFile,
  size: number,
  known: Known,
): Promise<Omit<Known, "folder" | "info"> | null> {
  const { end } = known;
  if (end === null || size < end || size - end > MAX_LOG_BYTES) return null;
  const from = Math.max(0, end - 1);
  const data = await readExactly(file, from, size - from);
  if (end > 0 && data[0] !== NEWLINE) return null;
  const first = end > 0 ? 1 : 0;
  const last = data.lastIndexOf(NEWLINE);
  if (last < first) return { turn: known.turn, end, boundaryStart: known.boundaryStart };
  // A fold that said nothing could be told starts afresh only at a turn's line, as a first read would.
  const folded = foldLines(data, first, last + 1, from, known.turn, known.boundaryStart);
  return { turn: folded.turn, end: from + last + 1, boundaryStart: folded.boundaryStart };
}

/** What one log says now. */
export type LogRead =
  | {
      state: "ok";
      turn: GrokBuildTurn;
      /** Its modified time as it was opened for this, never before its `lstat`'s. */
      writtenAt: number;
    }
  /** No `events.jsonl`. */
  | { state: "missing" }
  /** One that could not be read, or is not an ordinary file of this user's with one name. */
  | { state: "unreadable" };

const sameFile = (a: FileInfo, b: FileInfo) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export interface LogReader {
  /** What a session's log says, opened only when it changed. */
  read(sessionId: string, folder: string): Promise<LogRead>;
  /**
   * The log's modified time by `lstat` alone, for a session whose process
   * has ended, whose log is not read: null when there is none, or it is not
   * an ordinary file of this user's with one name.
   */
  writtenAt(folder: string): Promise<number | null>;
  /** Forgets every session not in this set. */
  keepOnly(ids: ReadonlySet<string>): void;
  /** How many logs it keeps, for the tests that check none is kept once its session has gone. */
  readonly kept: number;
}

export interface LogReaderOptions {
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
}

/** A reader of Grok Build's event logs, which keeps what it read of each until it changes. */
export function createLogReader(options: LogReaderOptions): LogReader {
  const { io, platform, euid } = options;
  const remembered = new Map<string, Known>();

  async function readFile(folder: string, looked: FileInfo, known: Known | undefined) {
    const file = await io.openRegular(path.join(folder, EVENTS_FILE));
    try {
      const { info } = file;
      if (!trustedFile(info, platform, euid)) return null;
      const goesOn = known && known.folder === folder && known.info.ino === info.ino;
      const read =
        (goesOn ? await readOnwards(file, info.size, known) : null) ??
        (await readFromEnd(file, info.size));
      const next: Known = {
        folder,
        info,
        ...read,
        turn: settled(read.turn, read.boundaryStart, info.size),
      };
      return { next, writtenAt: Math.max(looked.mtimeMs, info.mtimeMs) };
    } finally {
      await file.close().catch(() => {});
    }
  }

  return {
    async read(sessionId, folder) {
      let looked: FileInfo;
      try {
        looked = await io.lstat(path.join(folder, EVENTS_FILE));
      } catch (error) {
        return isMissing(error) ? { state: "missing" } : { state: "unreadable" };
      }
      // Checked before what was read is reused: a second name or another
      // owner leaves the size, time and identity as they were.
      if (!trustedFile(looked, platform, euid)) return { state: "unreadable" };
      const known = remembered.get(sessionId);
      if (known && known.folder === folder && sameFile(known.info, looked)) {
        return { state: "ok", turn: known.turn, writtenAt: looked.mtimeMs };
      }
      let opened: Awaited<ReturnType<typeof readFile>>;
      try {
        opened = await readFile(folder, looked, known);
      } catch {
        // Gone, refused or changed as it was read: nothing is kept of it, and
        // it is read again on the next poll.
        return { state: "unreadable" };
      }
      if (opened === null) return { state: "unreadable" };
      remembered.set(sessionId, opened.next);
      return { state: "ok", turn: opened.next.turn, writtenAt: opened.writtenAt };
    },
    async writtenAt(folder) {
      try {
        const looked = await io.lstat(path.join(folder, EVENTS_FILE));
        return trustedFile(looked, platform, euid) ? looked.mtimeMs : null;
      } catch {
        return null;
      }
    },
    keepOnly(ids) {
      for (const id of remembered.keys()) if (!ids.has(id)) remembered.delete(id);
    },
    get kept() {
      return remembered.size;
    },
  };
}
