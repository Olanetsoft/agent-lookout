import type { OhMyPiLine } from "../../../core/mapping/oh-my-pi/ohMyPiMapping.ts";
import type { OpenFile } from "../../files/readOnlyIo.ts";
import { bytesAt, timeAt, wordAt } from "../autohand-code/jsonBytes.ts";

/**
 * Reading the newest lines of an Oh My Pi session file, as bytes. Built from
 * Oh My Pi's source at v19.0.0 and not yet checked on a computer running it.
 *
 * Oh My Pi adds each entry as one line, `JSON.stringify` of an object whose
 * keys come in the order the code builds them, at the file's end
 * (packages/coding-agent/src/session/session-manager.ts:1961-1980, :2150-2157,
 * :3588, :3770-3774). JSON writes a quote inside a string as `\"` and a line
 * break as `\n`, so the bytes a line begins with can only be its own keys,
 * and nothing a prompt, a reply or a tool holds can look like them. Of each
 * line only its first `LINE_HEAD_BYTES` are compared, with these shapes:
 *
 * - `{"type":"custom","customType":"session_exit","data":{"reason":"<word>",
 *   "kind":"<kind>","recordedAt":"<time>"`: Oh My Pi wrote that it stopped,
 *   and how (agent-session.ts:4205-4237, exit-diagnostics.ts:38-44).
 * - `{"type":"custom","customType":"tool_execution_start","data":
 *   {"toolCallId":"<id>","toolName":"`, written just before a tool runs
 *   (agent-session.ts:4191-4203): with `ask","startedAt":"<time>"`, its
 *   `ask` tool waits for an answer; with any other name, a tool runs.
 * - `{"type":"custom","customType":"provider_refusal",`: a provider refused a
 *   reply, which ends the turn as a reply does (provider-refusal.ts:12). Its
 *   line's time comes after its `data`, which is not read, so it has none.
 * - `{"type":"message","id":"<id>","parentId":<null or id>,"timestamp":
 *   "<time>"`, then perhaps `,"runtime":{…}` of strings, then
 *   `,"message":{"role":"<role>"`: `user` and `developer` are a prompt,
 *   `toolResult` a tool's result, `assistant` a reply, and `bashExecution`,
 *   `pythonExecution`, `fileMention`, `hookMessage` and `custom` are passed
 *   over. Any other role, or a message line of any other shape, cannot be
 *   read. A reply's and a result's `timestamp` is when Oh My Pi added the
 *   line, `new Date().toISOString()` (session-manager.ts:171-173,
 *   :2150-2157), and is kept as its time, or null when it is not one.
 * - Any other line that begins `{"type":"<word>",` is passed over: the title
 *   slot, the header, `model_usage`, `title_change` and the rest.
 *
 * Only the three times kept, `recordedAt`, an `ask`'s `startedAt` and a
 * reply's or a result's `timestamp`, are turned into text, as ASCII checked by
 * `INSTANT`. Nothing else is.
 *
 * The newest line not passed over decides. When it is a reply, a result or
 * a tool's or an ask's start, the lines before it are looked back over too,
 * past replies, results, tools' and asks' starts and lines passed over, to
 * the first exit, prompt or line that cannot be read:
 *
 * - An exit found so is the exit cut off. Oh My Pi writes its exit line, then
 *   aborts the turn, and goes on writing the lines the abort makes, tools'
 *   starts among them, for as long as it drains the turn
 *   (agent-session.ts:7202-7305, agent-loop.ts:3557-3565, :1633-1660). A
 *   round run after the exit with no prompt, as `/retry` and `--restore` run,
 *   writes the same lines, so whether the exit cut off decides is judged by
 *   the time the newest reply or result carries (`exitOf` in
 *   ohMyPiMapping.ts), never by when the file was last written, which a
 *   rename moves.
 * - When no tool's or ask's start is passed, the newest included, the exit is
 *   also the exit behind, and decides as an exit does whenever the file was
 *   written.
 *
 * - The first time, the end is read backwards, `PIECE_BYTES` at a time, to
 *   the line that decides and any exit before it, looking through at most
 *   `MAX_TAIL_BYTES` and the byte before them. At most one piece and 2 KiB
 *   are held at once: the first `LINE_HEAD_BYTES` of the piece after it, and
 *   a copy of a line's first bytes.
 * - After that, only what was added is read, onwards, a piece at a time,
 *   when the file is no shorter than when it was last read, grew by
 *   `MAX_TAIL_BYTES` or less, and the byte before what was added is a line
 *   break. Otherwise it is read from its end again. Either way the same lines
 *   decide, so what is kept is what a first read of the same file gives.
 * - A line that decides, or an exit before it, that begins more than
 *   `MAX_TAIL_BYTES` before the end is too far back, as a first read would
 *   not reach it. A last line with no line break yet waits until it is whole.
 */

/** How much is read at a time, going backwards or onwards. */
export const PIECE_BYTES = 64 * 1024;

/** The most of a file's end looked through, and of what was added read onwards. */
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** The most of each line compared. */
export const LINE_HEAD_BYTES = 1024;

/** The longest ID of a tool's call skipped over. */
const MAX_CALL_ID_BYTES = 512;

/** The longest word of a line's type, a `custom` line's kind, or an exit's reason. */
const MAX_WORD_BYTES = 64;
const MAX_REASON_BYTES = 32;

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const CLOSE_BRACE = 0x7d;
const COLON = 0x3a;

const bytes = (text: string) => Buffer.from(text);

const TYPE_START = bytes('{"type":"');
const CUSTOM_TYPE = bytes('"customType":"');
const EXIT_DATA = bytes(',"data":{"reason":"');
const KIND_KEY = bytes('","kind":"');
const KINDS = ["normal", "signal", "fatal", "process_exit"].map((kind) => bytes(`${kind}"`));
const FATAL = 2;
const RECORDED_AT = bytes(',"recordedAt":"');
const TOOL_DATA = bytes(',"data":{"toolCallId":"');
const TOOL_NAME = bytes(',"toolName":"');
const ASK = bytes('ask"');
const STARTED_AT = bytes(',"startedAt":"');
const ID_KEY = bytes('"id":"');
const PARENT_KEY = bytes(',"parentId":');
const NULL = bytes("null");
const TIMESTAMP_KEY = bytes(',"timestamp":"');
const RUNTIME_KEY = bytes(',"runtime":{');
const ROLE_KEY = bytes(',"message":{"role":"');

const MESSAGE = bytes("message");
const CUSTOM = bytes("custom");
const SESSION_EXIT = bytes("session_exit");
const TOOL_EXECUTION_START = bytes("tool_execution_start");
const PROVIDER_REFUSAL = bytes("provider_refusal");

/** The roles of a message line, each with its closing quote, and what each is. */
const ROLES: readonly [Buffer, TailLine["sort"]][] = [
  ["user", "prompt"],
  ["developer", "prompt"],
  ["toolResult", "result"],
  ["assistant", "reply"],
  ["bashExecution", "passed"],
  ["pythonExecution", "passed"],
  ["fileMention", "passed"],
  ["hookMessage", "passed"],
  ["custom", "passed"],
].map(([role, sort]) => [bytes(`${role}"`), sort as TailLine["sort"]]);
const ROLE_WORDS = ROLES.map(([word]) => word);

/** What one line is, as far as a session's status needs it: one that decides, or one passed over. */
export type TailLine = OhMyPiLine | { sort: "passed" };

/** A line that decides. */
export type DecidingLine = OhMyPiLine;
export type ExitLine = Extract<OhMyPiLine, { sort: "exit" }>;

/** What is kept of a file's newest lines between polls: no bytes. */
export interface Tail {
  /** Just past the last whole line read, or null when no line break was found to go on from. */
  end: number | null;
  /** The newest line that decides, or null when none was found. */
  newest: DecidingLine | null;
  /** Where it begins: 0 with none, when the whole file was read, and -1 when it is before what was read. */
  newestStart: number;
  /** The exit behind it, with only replies, results and lines passed over after it, or null. */
  behind: ExitLine | null;
  behindStart: number;
  /** The exit cut off before it, with tools' and asks' starts after it too, or null. */
  cutOff: ExitLine | null;
  cutOffStart: number;
}

/** What a file's newest lines say now. */
export type TailView =
  /** No line that decides in the whole file, as in one `/new` has just made. */
  | { state: "none" }
  /** The newest line that decides is not in the last `MAX_TAIL_BYTES`. */
  | { state: "too-far" }
  | { state: "ok"; newest: DecidingLine; behind: ExitLine | null; cutOff: ExitLine | null };

/** What a kept tail says of a file of `size` bytes. */
export function viewOf(tail: Tail, size: number): TailView {
  const reach = size - MAX_TAIL_BYTES;
  if (tail.newestStart < 0 || tail.newestStart < reach) return { state: "too-far" };
  if (tail.newest === null) return { state: "none" };
  const behind = tail.behind !== null && tail.behindStart >= reach ? tail.behind : null;
  const cutOff = tail.cutOff !== null && tail.cutOffStart >= reach ? tail.cutOff : null;
  return { state: "ok", newest: tail.newest, behind, cutOff };
}

const isWordByte = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f);

const isReasonByte = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x61 && byte <= 0x7a) || byte === 0x5f);

/** A byte of a time as `Date.toISOString()` writes one: a digit or one of `:.TZ+-`. */
const isTimeByte = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x30 && byte <= 0x39) ||
    byte === COLON ||
    byte === 0x2e ||
    byte === 0x54 ||
    byte === 0x5a ||
    byte === 0x2b ||
    byte === 0x2d);

/** Where a run of 1 to `max` bytes `allowed` lets through, from `at`, ends at a quote, or -1. */
function runTo(
  head: Buffer,
  at: number,
  max: number,
  allowed: (byte: number | undefined) => boolean,
): number {
  let end = at;
  while (end < head.byteLength && end - at < max && allowed(head[end])) end += 1;
  return end > at && head[end] === QUOTE ? end : -1;
}

/** Where the JSON string whose text begins at `at` ends, at its closing quote, within `max` bytes, or -1. */
function stringEnd(head: Buffer, at: number, max: number): number {
  let end = at;
  while (end < head.byteLength && end - at <= max) {
    const byte = head[end];
    if (byte === QUOTE) return end;
    // A control character is never inside a JSON string.
    if (byte === undefined || byte < 0x20) return -1;
    end += byte === BACKSLASH ? 2 : 1;
  }
  return -1;
}

/** Where `word` ends when it is at `at`, or -1. */
function after(head: Buffer, at: number, word: Buffer): number {
  return at >= 0 && bytesAt(head, at, word) ? at + word.byteLength : -1;
}

const UNREADABLE: TailLine = { sort: "unreadable" };
const PASSED: TailLine = { sort: "passed" };

/** An exit's line, from just past its kind's closing quote. */
function exitLine(head: Buffer, at: number): TailLine {
  const reason = after(head, at, EXIT_DATA);
  if (reason < 0) return UNREADABLE;
  const reasonEnd = runTo(head, reason, MAX_REASON_BYTES, isReasonByte);
  const kindAt = after(head, reasonEnd, KIND_KEY);
  if (reasonEnd < 0 || kindAt < 0) return UNREADABLE;
  const kind = wordAt(head, kindAt, KINDS);
  if (kind < 0) return UNREADABLE;
  const timeStart = after(head, kindAt + (KINDS[kind] as Buffer).byteLength, RECORDED_AT);
  if (timeStart < 0) return UNREADABLE;
  const recorded = timeAt(head, timeStart);
  return recorded === null ? UNREADABLE : { sort: "exit", fatal: kind === FATAL, at: recorded };
}

/** A tool's start, from just past its kind's closing quote. */
function toolLine(head: Buffer, at: number): TailLine {
  const id = after(head, at, TOOL_DATA);
  if (id < 0) return UNREADABLE;
  const idEnd = stringEnd(head, id, MAX_CALL_ID_BYTES);
  const name = after(head, idEnd < 0 ? -1 : idEnd + 1, TOOL_NAME);
  if (name < 0) return UNREADABLE;
  if (bytesAt(head, name, ASK)) {
    const timeStart = after(head, name + ASK.byteLength, STARTED_AT);
    const started = timeStart < 0 ? null : timeAt(head, timeStart);
    return started === null ? UNREADABLE : { sort: "ask", at: started };
  }
  return stringEnd(head, name, LINE_HEAD_BYTES) > name ? { sort: "tool" } : UNREADABLE;
}

/** A `custom` line, from just past `{"type":"custom",`. */
function customLine(head: Buffer, at: number): TailLine {
  const kind = after(head, at, CUSTOM_TYPE);
  if (kind < 0) return PASSED;
  const kindEnd = stringEnd(head, kind, MAX_WORD_BYTES);
  if (kindEnd < 0) return UNREADABLE;
  const is = (word: Buffer) => kindEnd - kind === word.byteLength && bytesAt(head, kind, word);
  if (is(SESSION_EXIT)) return exitLine(head, kindEnd + 1);
  if (is(TOOL_EXECUTION_START)) return toolLine(head, kindEnd + 1);
  // A refusal's time comes after its `data`, which is not read, so it has none.
  if (is(PROVIDER_REFUSAL)) {
    return head[kindEnd + 1] === COMMA ? { sort: "reply", at: null } : UNREADABLE;
  }
  return PASSED;
}

/** Where a `runtime` object of strings alone, from just past its `{`, ends, past its `}`, or -1. */
function runtimeEnd(head: Buffer, at: number): number {
  let cursor = at;
  if (head[cursor] === CLOSE_BRACE) return cursor + 1;
  for (;;) {
    if (head[cursor] !== QUOTE) return -1;
    const keyEnd = stringEnd(head, cursor + 1, LINE_HEAD_BYTES);
    if (keyEnd < 0 || head[keyEnd + 1] !== COLON || head[keyEnd + 2] !== QUOTE) return -1;
    const valueEnd = stringEnd(head, keyEnd + 3, LINE_HEAD_BYTES);
    if (valueEnd < 0) return -1;
    cursor = valueEnd + 1;
    if (head[cursor] === CLOSE_BRACE) return cursor + 1;
    if (head[cursor] !== COMMA) return -1;
    cursor += 1;
  }
}

/** A `message` line, from just past `{"type":"message",`. */
function messageLine(head: Buffer, at: number): TailLine {
  const id = after(head, at, ID_KEY);
  const idEnd = id < 0 ? -1 : stringEnd(head, id, MAX_CALL_ID_BYTES);
  let cursor = after(head, idEnd < 0 ? -1 : idEnd + 1, PARENT_KEY);
  if (cursor < 0) return UNREADABLE;
  if (bytesAt(head, cursor, NULL)) cursor += NULL.byteLength;
  else if (head[cursor] === QUOTE) {
    const parentEnd = stringEnd(head, cursor + 1, MAX_CALL_ID_BYTES);
    cursor = parentEnd < 0 ? -1 : parentEnd + 1;
  } else return UNREADABLE;
  const time = after(head, cursor, TIMESTAMP_KEY);
  const timeEnd = time < 0 ? -1 : runTo(head, time, MAX_WORD_BYTES, isTimeByte);
  if (timeEnd < 0) return UNREADABLE;
  cursor = timeEnd + 1;
  const runtime = after(head, cursor, RUNTIME_KEY);
  if (runtime >= 0) cursor = runtimeEnd(head, runtime);
  const role = after(head, cursor, ROLE_KEY);
  if (role < 0) return UNREADABLE;
  const index = wordAt(head, role, ROLE_WORDS);
  const sort = index < 0 ? "unreadable" : (ROLES[index] as [Buffer, TailLine["sort"]])[1];
  // Only a reply's or a result's time is turned into text, once its role is known.
  if (sort === "reply" || sort === "result") return { sort, at: timeAt(head, time) };
  return sort === "passed" ? PASSED : ({ sort } as TailLine);
}

/**
 * What a line is, without its line break, from its first `LINE_HEAD_BYTES`
 * bytes alone. Nothing but the times of an exit, an `ask`, a reply and a
 * result is turned into text.
 */
export function judgeLine(line: Buffer): TailLine {
  const head = line.subarray(0, LINE_HEAD_BYTES);
  if (!bytesAt(head, 0, TYPE_START)) return UNREADABLE;
  const word = TYPE_START.byteLength;
  const wordEnd = runTo(head, word, MAX_WORD_BYTES, isWordByte);
  if (wordEnd < 0 || head[wordEnd + 1] !== COMMA) return UNREADABLE;
  const rest = wordEnd + 2;
  const is = (kind: Buffer) => wordEnd - word === kind.byteLength && bytesAt(head, word, kind);
  if (is(MESSAGE)) return messageLine(head, rest);
  if (is(CUSTOM)) return customLine(head, rest);
  return PASSED;
}

/** A tail with no lines read yet, of a file whose start is read: none decides. */
function emptyTail(end: number | null): Tail {
  return {
    end,
    newest: null,
    newestStart: 0,
    behind: null,
    behindStart: 0,
    cutOff: null,
    cutOffStart: 0,
  };
}

/** Whether a line lets the exit behind it stand: a reply or a result. */
const keepsBehind = (line: DecidingLine) => line.sort === "reply" || line.sort === "result";

/** Whether a line lets the exit cut off before it stand: a reply, a result, or a tool's or an ask's start. */
const keepsCutOff = (line: DecidingLine) =>
  keepsBehind(line) || line.sort === "tool" || line.sort === "ask";

/**
 * The tail after one more line, newer than every line before it, beginning at
 * `start`. A reply or a result keeps the exit behind and the exit cut off, or
 * takes the newest line as both when that is an exit. A tool's or an ask's
 * start keeps the exit cut off, or takes the newest exit as it, and drops the
 * exit behind. Any other line that decides drops both.
 */
export function foldLine(tail: Tail, line: TailLine, start: number): Tail {
  if (line.sort === "passed") return tail;
  const next: Tail = { ...tail, newest: line, newestStart: start };
  if (!keepsCutOff(line)) {
    return { ...next, behind: null, behindStart: 0, cutOff: null, cutOffStart: 0 };
  }
  if (tail.newest?.sort === "exit") {
    next.cutOff = tail.newest;
    next.cutOffStart = tail.newestStart;
    if (keepsBehind(line)) {
      next.behind = tail.newest;
      next.behindStart = tail.newestStart;
    }
  }
  return keepsBehind(line) ? next : { ...next, behind: null, behindStart: 0 };
}

class Changed extends Error {}

async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = await file.read(position, length);
  if (data.byteLength !== length) throw new Changed("The file shrank while it was read.");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Reads a file's end backwards, from its newest whole line to the line that
 * decides and any exit before it. It holds one piece, the first
 * `LINE_HEAD_BYTES` of the bytes after it, and a copy of a line's first bytes
 * at once.
 */
export async function readFromEnd(file: OpenFile, size: number): Promise<Tail> {
  // The last bytes looked through, and the byte before them, so a line that
  // starts `MAX_TAIL_BYTES` from the end is found whole, as reading onwards finds it.
  const floor = Math.max(0, size - MAX_TAIL_BYTES - 1);
  const reach = size - MAX_TAIL_BYTES;
  let piece: Buffer = Buffer.alloc(0);
  /** Where `piece` begins in the file. The bytes after it are in `carry`. */
  let pieceStart = size;
  let carry: Buffer = Buffer.alloc(0);

  async function earlier(): Promise<boolean> {
    const want = Math.min(PIECE_BYTES, pieceStart - floor);
    if (want <= 0) return false;
    // The start of the piece in hand becomes the carry, and the piece is let
    // go before the next is read, so no two pieces are held at once.
    carry = Buffer.alloc(0);
    carry = Buffer.from(piece.subarray(0, Math.min(LINE_HEAD_BYTES, piece.byteLength)));
    piece = Buffer.alloc(0);
    piece = await readExactly(file, pieceStart - want, want);
    pieceStart -= want;
    return true;
  }

  /** The position of the newest line break before `before`, reading earlier as needed, or -1 when none is in reach. */
  async function newlineBefore(before: number): Promise<number> {
    let from = before - 1;
    for (;;) {
      if (from >= pieceStart && from < pieceStart + piece.byteLength) {
        const found = piece.lastIndexOf(NEWLINE, from - pieceStart);
        if (found >= 0) return pieceStart + found;
        from = pieceStart - 1;
      }
      if (!(await earlier())) return -1;
    }
  }

  /** The first bytes of the line from `start` to its line break at `lineEnd`. */
  function headOf(start: number, lineEnd: number): Buffer {
    const length = Math.min(LINE_HEAD_BYTES, lineEnd - start);
    const inPiece = start - pieceStart;
    const fromPiece = piece.subarray(inPiece, Math.min(piece.byteLength, inPiece + length));
    if (fromPiece.byteLength === length) return fromPiece;
    const rest = carry.subarray(
      Math.max(0, inPiece - piece.byteLength),
      length - fromPiece.byteLength + Math.max(0, inPiece - piece.byteLength),
    );
    return Buffer.concat([fromPiece, rest]);
  }

  const last = await newlineBefore(size);
  if (last < 0) {
    // No whole line: an empty file, or one still being written, has none that decides.
    return floor === 0 ? emptyTail(0) : { ...emptyTail(null), newestStart: -1 };
  }
  const end = last + 1;
  /** Lines judged, newest first, until the one that decides and the look back from it end. */
  let newest: DecidingLine | null = null;
  let newestStart = -1;
  /** Whether a tool's or an ask's start was looked back past, the newest among them: then no exit is behind. */
  let pastStart = false;
  /** The newest line that decides, with no exit before it. */
  const alone = (found: DecidingLine): Tail => ({
    ...emptyTail(end),
    newest: found,
    newestStart,
  });
  let lineEnd = last;
  for (;;) {
    const before = await newlineBefore(lineEnd);
    const start = before >= 0 ? before + 1 : floor === 0 ? 0 : -1;
    if (start < 0 || start < reach) {
      // Before what is read: with no line that decides yet, it is too far back.
      if (newest === null) return { ...emptyTail(end), newestStart: -1 };
      return alone(newest);
    }
    const line = judgeLine(headOf(start, lineEnd));
    if (line.sort !== "passed") {
      if (newest === null) {
        newest = line;
        newestStart = start;
        if (!keepsCutOff(line)) return alone(newest);
      } else if (line.sort === "exit") {
        return {
          ...alone(newest),
          behind: pastStart ? null : line,
          behindStart: pastStart ? 0 : start,
          cutOff: line,
          cutOffStart: start,
        };
      } else if (!keepsCutOff(line)) {
        return alone(newest);
      }
      if (!keepsBehind(line)) pastStart = true;
    }
    if (start === 0) return newest === null ? emptyTail(end) : alone(newest);
    lineEnd = start - 1;
  }
}

/**
 * Folds what was added since `known` was read, onwards, a piece at a time,
 * holding one piece, the first `LINE_HEAD_BYTES` of the line being read, and
 * a copy of them as more are added.
 * Null when the file does not go on from there: shorter, grown by more than
 * `MAX_TAIL_BYTES`, or with no line break before what was added.
 */
export async function readOnwards(file: OpenFile, size: number, known: Tail): Promise<Tail | null> {
  const { end } = known;
  if (end === null || size < end || size - end > MAX_TAIL_BYTES) return null;
  if (end > 0 && (await readExactly(file, end - 1, 1))[0] !== NEWLINE) return null;
  let tail = known;
  let lineStart = end;
  let head: Buffer = Buffer.alloc(0);
  for (let at = end; at < size;) {
    const piece = await readExactly(file, at, Math.min(PIECE_BYTES, size - at));
    let from = 0;
    for (;;) {
      const newline = piece.indexOf(NEWLINE, from);
      const upTo = newline < 0 ? piece.byteLength : newline;
      if (head.byteLength < LINE_HEAD_BYTES) {
        const take = piece.subarray(from, Math.min(upTo, from + LINE_HEAD_BYTES - head.byteLength));
        head = Buffer.concat([head, take]);
      }
      if (newline < 0) break;
      tail = foldLine(tail, judgeLine(head), lineStart);
      lineStart = at + newline + 1;
      head = Buffer.alloc(0);
      from = newline + 1;
    }
    at += piece.byteLength;
  }
  return { ...tail, end: lineStart };
}
