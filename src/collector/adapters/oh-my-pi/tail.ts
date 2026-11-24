import type {
  OhMyPiApproval,
  OhMyPiApprovals,
  OhMyPiLine,
} from "../../../core/mapping/oh-my-pi/ohMyPiMapping.ts";
import type { OpenFile } from "../../files/readOnlyIo.ts";
import { bytesAt, timeAt, wordAt } from "../autohand-code/jsonBytes.ts";

/**
 * Reading the newest lines of an Oh My Pi session file, as bytes. Built from
 * Oh My Pi's source at v19.0.0, with its approval lines read at v19.1.1, and
 * not yet checked on a computer running it.
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
 * - `{"type":"custom","customType":"tool_approval_requested","data":
 *   {"toolCallId":"<id>"`, then perhaps `,"parentToolCallId":"<id>"`, then
 *   `,"toolName":"`: from 19.1.0, a tool began to wait for the person's
 *   approval, written before its prompt opens. `,"approvalMode":"`, perhaps
 *   `,"reason":"` and `,"requestedAt":"<time>"` follow (at v19.1.1
 *   tool-approval-records.ts:9-17, :41-52, wrapper.ts:430-436).
 * - `{"type":"custom","customType":"tool_approval_resolved","data":
 *   {"toolCallId":"<id>","toolName":"`: that wait ended, however it did (at
 *   v19.1.1 tool-approval-records.ts:20-26, :54-64, wrapper.ts:448-454).
 * - `{"type":"message","id":"<id>","parentId":<null or id>,"timestamp":
 *   "<time>"`, then perhaps `,"runtime":{…}` of strings, then
 *   `,"message":{"role":"<role>"`: `user` and `developer` are a prompt,
 *   `toolResult` a tool's result, whose call is the `,"toolCallId":"<id>"`
 *   after it, `assistant` a reply, and `bashExecution`, `pythonExecution`,
 *   `fileMention`, `hookMessage` and `custom` are passed over. Any other role,
 *   or a message line of any other shape, cannot be read. A reply's and a
 *   result's `timestamp` is when Oh My Pi added the line,
 *   `new Date().toISOString()` (session-manager.ts:171-173, :2150-2157), and
 *   is kept as its time, or null when its bytes, digits and `:.TZ+-`, are not
 *   one. A `timestamp` that is empty, longer than 64 bytes or holds any other
 *   byte is another shape.
 * - Any other line that begins `{"type":"<word>",` is passed over: the title
 *   slot, the header, `model_usage`, `title_change` and the rest.
 *
 * Only the four times kept, `recordedAt`, an `ask`'s `startedAt`, an
 * approval's `requestedAt` and a reply's or a result's `timestamp`, are turned
 * into text, as ASCII checked by `INSTANT`. Nothing else is: a call's ID is
 * kept as its bytes, to compare with the lines after it, only while an
 * approval for it, or for a call it dispatched, waits or its tool runs, and a
 * tool's name, an approval's mode and its reason are stepped over.
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
 * An approval's two lines decide nothing by themselves. Beside the newest
 * line, the approvals that wait are kept: each asked for since the newest
 * exit, or since the file began, until its own end, or a result for its call
 * or for the call that dispatched it, as an eval's, follows
 * (docs/session.md:401-402 at v19.1.1). A result of another call ends none:
 * Oh My Pi writes results in the order the reply named the calls, so one can
 * be written while a later call still waits (agent-loop.ts:3557-3565 at
 * v19.1.1). A call asked for again takes the place of its earlier request.
 *
 * - A tool run as a command in a `bash` call asks with an ID of its own,
 *   `<the call's>:cmd:<n>`, and the `bash` call is then given its result while
 *   the command waits on, so the model goes on to its next reply
 *   (docs/approval-mode.md:18, tools/bash.ts:2109-2183 and
 *   exec/tool-command-host.ts:79-80 at v19.1.1). When an eval made the `bash`
 *   call, the eval is the command's parent and can get its result too, so a
 *   parent's result ends none of a command's. One an eval in the background
 *   asks for after its own result waits on as well.
 * - So a prompt never ends one. A reply or a refusal ends only one whose call,
 *   or the call that dispatched it, has a start since the reply or the exit
 *   before and no result: the agent loop writes the result of each of a
 *   reply's calls before the next reply, so a crash left it. So the IDs of the
 *   calls started since the newest reply or exit that have no result are kept
 *   too.
 * - A line that could end a wait and cannot be read leaves it unknown whether
 *   those asked for before it still wait, so none of them is kept, and a
 *   request that cannot be read whether another does. While one of either,
 *   asked for since the newest prompt, reply or exit, could hold up the turn,
 *   that is said, until the next of them. A tool's start or a refusal that
 *   cannot be read, and a `custom` line of a kind longer than any of these
 *   that ends within what is compared, end none.
 * - When the newest prompt, reply or exit is more than `MAX_TAIL_BYTES` back,
 *   a request before what is read could hold up the turn. One within it, with
 *   no end after it, waits whatever came before.
 * - One asked for before the newest prompt, reply or exit that was asked more
 *   than `MAX_TAIL_BYTES` back, or with a reply after it and the one before it
 *   that far back, so the calls started between are not all read, is not seen.
 *   The turn goes on without it.
 *
 * - The first time, the end is read backwards, `PIECE_BYTES` at a time, to
 *   the line that decides, any exit before it and the newest prompt, reply or
 *   exit, and, in a file written in the last 30 minutes, on to the newest
 *   exit, looking through at most `MAX_TAIL_BYTES` and the byte before them.
 *   When a request is met, or a tool's or an ask's start since the newest
 *   reply or exit, the lines from the reply or exit before the first of them
 *   are then read onwards once, to tell which still wait and which calls run.
 *   Beside the IDs kept, at most one piece and 2 KiB are held at once: the
 *   first `LINE_HEAD_BYTES` of the piece after it, and a copy of a line's
 *   first bytes.
 * - After that, only what was added is read, onwards, a piece at a time,
 *   when the file is no shorter than when it was last read, grew by
 *   `MAX_TAIL_BYTES` or less, the byte before what was added is a line break,
 *   and it was read back to its newest exit before. Otherwise it is read from
 *   its end again. Either way the same lines decide, so what is shown is what
 *   a first read of the same file gives.
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

/** The longest ID of a tool's call skipped over or compared. */
const MAX_CALL_ID_BYTES = 512;

/** The most approvals kept that wait at once. */
export const MAX_OPEN_APPROVALS = 64;

/** The most calls kept that were started since the newest reply or exit and have no result. */
export const MAX_STARTED_CALLS = 64;

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
const PARENT_CALL = bytes(',"parentToolCallId":"');
const APPROVAL_MODE = bytes(',"approvalMode":"');
const REASON = bytes(',"reason":"');
const REQUESTED_AT = bytes(',"requestedAt":"');
const RESULT_CALL = bytes(',"toolCallId":"');
const COMMAND_PART = bytes(":cmd:");
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
const APPROVAL_REQUESTED = bytes("tool_approval_requested");
const APPROVAL_RESOLVED = bytes("tool_approval_resolved");

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

/**
 * What one line is, as far as a session's status needs it: one that decides,
 * with its call for a result and a tool's or an ask's start, one of an
 * approval's two, or one passed over. A call is its ID's bytes as the line
 * holds them, or null when they cannot be read.
 */
export type TailLine =
  | Exclude<OhMyPiLine, { sort: "result" | "ask" | "tool" | "unreadable" }>
  | { sort: "result"; at: number | null; call: Buffer | null }
  | { sort: "ask"; at: number; call: Buffer | null }
  | { sort: "tool"; call: Buffer | null }
  /** Of a shape this does not read, with `endsNone` when it is of a kind that ends no wait. */
  | { sort: "unreadable"; endsNone?: true }
  /** A tool began to wait for the person's approval. */
  | { sort: "request"; call: Buffer | null; parent: Buffer | null; at: number | null }
  /** That wait ended. */
  | { sort: "resolved"; call: Buffer | null }
  | { sort: "passed" };

/** A line that decides. */
export type DecidingLine = OhMyPiLine;
export type ExitLine = Extract<OhMyPiLine, { sort: "exit" }>;

/** An approval that waits, with the bytes of the IDs a later line ends it by. */
export interface OpenApproval extends Pick<OhMyPiApproval, "start" | "at"> {
  call: Buffer;
  parent: Buffer | null;
  /** Where the reply or exit before it begins, as `replyStart` was then. */
  turn: number;
}

/**
 * What is kept of a file's newest lines between polls: no bytes but the IDs of
 * the calls that wait for an approval, of those that dispatched them, and of
 * those started since the newest reply or exit that have no result.
 */
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
  /** The approvals asked for since the newest exit that nothing has ended, at most `MAX_OPEN_APPROVALS`. */
  open: readonly OpenApproval[];
  /** The calls started since the newest reply or exit with no result, at most `MAX_STARTED_CALLS`. */
  started: readonly Buffer[];
  /** Whether a line since the newest prompt, reply or exit could not be read that could be another approval's, or the end of one asked since. */
  unread: boolean;
  /** Whether more were open at once than are kept, one of those let go asked since the newest prompt, reply or exit. */
  crowded: boolean;
  /** Where the newest prompt, reply or exit begins: 0 with none, when the whole file was read, and -1 when it is before what was read. */
  turnStart: number;
  /** The same of the newest reply or exit. */
  replyStart: number;
  /** Whether it was read back to the newest exit, its start or as far as is looked through, so it can be read on from here. */
  whole: boolean;
}

/** What a file's newest lines say now. */
export type TailView =
  /** No line that decides in the whole file, as in one `/new` has just made. */
  | { state: "none" }
  /** The newest line that decides is not in the last `MAX_TAIL_BYTES`. */
  | { state: "too-far" }
  | {
      state: "ok";
      /** Null only while an approval waits, with no line that decides in what was read. */
      newest: DecidingLine | null;
      behind: ExitLine | null;
      cutOff: ExitLine | null;
      approvals: OhMyPiApprovals;
    };

/** What a kept tail says of a file of `size` bytes. */
export function viewOf(tail: Tail, size: number): TailView {
  const reach = size - MAX_TAIL_BYTES;
  const far = tail.turnStart < 0 || tail.turnStart < reach;
  const approvals: OhMyPiApprovals = {
    open: tail.open
      // One with a reply after it only when the calls started before it were all read, to tell which that reply ends.
      .filter(({ start, turn }) => start >= reach && (start > tail.replyStart || turn >= reach))
      .map(({ start, at }): OhMyPiApproval => ({ start, at, replied: start < tail.turnStart })),
    unsure: far ? "too-far" : tail.unread ? "unread" : tail.crowded ? "too-many" : null,
  };
  const newestFar = tail.newestStart < 0 || tail.newestStart < reach;
  const newest = newestFar ? null : tail.newest;
  if (newest === null && approvals.open.length === 0) {
    return { state: newestFar ? "too-far" : "none" };
  }
  const behind = tail.behind !== null && tail.behindStart >= reach ? tail.behind : null;
  const cutOff = tail.cutOff !== null && tail.cutOffStart >= reach ? tail.cutOff : null;
  return { state: "ok", newest, behind, cutOff, approvals };
}

const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;

const isWordByte = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x61 && byte <= 0x7a) || isDigit(byte) || byte === 0x5f);

const isReasonByte = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x61 && byte <= 0x7a) || byte === 0x5f);

/** A byte of a time as `Date.toISOString()` writes one: a digit or one of `:.TZ+-`. */
const isTimeByte = (byte: number | undefined) =>
  byte !== undefined &&
  (isDigit(byte) ||
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
/** A line this cannot read, of a kind that is neither an approval's end, a result nor an exit. */
const UNREADABLE_ENDS_NONE: TailLine = { sort: "unreadable", endsNone: true };
const PASSED: TailLine = { sort: "passed" };
const UNREAD_REQUEST: TailLine = { sort: "request", call: null, parent: null, at: null };

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

/**
 * A copy of these bytes in memory of its own. `Buffer.from` and
 * `Buffer.concat` take short ones from memory they share with whatever else
 * was copied lately, a prompt or a reason among it, which would be kept with
 * them.
 */
export function ownCopy(bytes: Buffer): Buffer {
  const copy = Buffer.alloc(bytes.byteLength);
  bytes.copy(copy);
  return copy;
}

/** The bytes of a call's ID that begins at `at`, copied, or null when they are not 1 to `MAX_CALL_ID_BYTES` in reach. */
function callAt(head: Buffer, at: number): Buffer | null {
  const end = at < 0 ? -1 : stringEnd(head, at, MAX_CALL_ID_BYTES);
  return end > at ? ownCopy(head.subarray(at, end)) : null;
}

/** A tool's start, from just past its kind's closing quote. It ends no wait, whatever its shape. */
function toolLine(head: Buffer, at: number): TailLine {
  const id = after(head, at, TOOL_DATA);
  if (id < 0) return UNREADABLE_ENDS_NONE;
  const idEnd = stringEnd(head, id, MAX_CALL_ID_BYTES);
  const name = after(head, idEnd < 0 ? -1 : idEnd + 1, TOOL_NAME);
  if (name < 0) return UNREADABLE_ENDS_NONE;
  const call = callAt(head, id);
  if (bytesAt(head, name, ASK)) {
    const timeStart = after(head, name + ASK.byteLength, STARTED_AT);
    const started = timeStart < 0 ? null : timeAt(head, timeStart);
    return started === null ? UNREADABLE_ENDS_NONE : { sort: "ask", at: started, call };
  }
  return stringEnd(head, name, LINE_HEAD_BYTES) > name
    ? { sort: "tool", call }
    : UNREADABLE_ENDS_NONE;
}

/** Where what follows the JSON string that begins at `at` begins, past its closing quote, or -1. */
function pastString(head: Buffer, at: number): number {
  const end = at < 0 ? -1 : stringEnd(head, at, LINE_HEAD_BYTES);
  return end < 0 ? -1 : end + 1;
}

/**
 * An approval's request, from just past its kind's closing quote. Its tool's
 * name, its mode and its reason are stepped over. A reason that runs past what
 * is compared leaves its time unknown, and the request stands.
 */
function requestLine(head: Buffer, at: number): TailLine {
  const id = after(head, at, TOOL_DATA);
  const call = callAt(head, id);
  if (call === null) return UNREAD_REQUEST;
  let cursor = id + call.byteLength + 1;
  const parentId = after(head, cursor, PARENT_CALL);
  const parent = callAt(head, parentId);
  if (parentId >= 0) {
    if (parent === null) return UNREAD_REQUEST;
    cursor = parentId + parent.byteLength + 1;
  }
  cursor = after(head, cursor, TOOL_NAME);
  if (cursor < 0) return UNREAD_REQUEST;
  cursor = pastString(head, after(head, pastString(head, cursor), APPROVAL_MODE));
  const reason = after(head, cursor, REASON);
  if (reason >= 0) cursor = pastString(head, reason);
  const time = after(head, cursor, REQUESTED_AT);
  return { sort: "request", call, parent, at: time < 0 ? null : timeAt(head, time) };
}

/** An approval's end, from just past its kind's closing quote. */
function resolvedLine(head: Buffer, at: number): TailLine {
  const id = after(head, at, TOOL_DATA);
  const call = callAt(head, id);
  const named = call !== null && bytesAt(head, id + call.byteLength + 1, TOOL_NAME);
  return { sort: "resolved", call: named ? call : null };
}

/** A `custom` line, from just past `{"type":"custom",`. */
function customLine(head: Buffer, at: number): TailLine {
  const kind = after(head, at, CUSTOM_TYPE);
  if (kind < 0) return PASSED;
  const kindEnd = stringEnd(head, kind, MAX_WORD_BYTES);
  if (kindEnd < 0) {
    // One that ends further on is longer than any kind that decides.
    return stringEnd(head, kind, LINE_HEAD_BYTES) < 0 ? UNREADABLE : UNREADABLE_ENDS_NONE;
  }
  const is = (word: Buffer) => kindEnd - kind === word.byteLength && bytesAt(head, kind, word);
  if (is(SESSION_EXIT)) return exitLine(head, kindEnd + 1);
  if (is(TOOL_EXECUTION_START)) return toolLine(head, kindEnd + 1);
  if (is(APPROVAL_REQUESTED)) return requestLine(head, kindEnd + 1);
  if (is(APPROVAL_RESOLVED)) return resolvedLine(head, kindEnd + 1);
  // A refusal's time comes after its `data`, which is not read, so it has none.
  if (is(PROVIDER_REFUSAL)) {
    return head[kindEnd + 1] === COMMA ? { sort: "reply", at: null } : UNREADABLE_ENDS_NONE;
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
  if (index < 0) return UNREADABLE;
  const [word, sort] = ROLES[index] as [Buffer, TailLine["sort"]];
  // Only a reply's or a result's time is turned into text, once its role is known.
  if (sort === "reply") return { sort, at: timeAt(head, time) };
  if (sort === "result") {
    const call = callAt(head, after(head, role + word.byteLength, RESULT_CALL));
    return { sort, at: timeAt(head, time), call };
  }
  return sort === "passed" ? PASSED : ({ sort } as TailLine);
}

/**
 * What a line is, without its line break, from its first `LINE_HEAD_BYTES`
 * bytes alone. Nothing but the times of an exit, an `ask`, an approval's
 * request, a reply and a result is turned into text.
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
    open: [],
    started: [],
    unread: false,
    crowded: false,
    turnStart: 0,
    replyStart: 0,
    whole: true,
  };
}

/** Whether a line lets the exit behind it stand: a reply or a result. */
const keepsBehind = (line: TailLine) => line.sort === "reply" || line.sort === "result";

/** Whether a line lets the exit cut off before it stand: a reply, a result, or a tool's or an ask's start. */
const keepsCutOff = (line: TailLine) =>
  keepsBehind(line) || line.sort === "tool" || line.sort === "ask";

/** Whether a line begins or ends a turn, so that an approval asked before it holds up none: a prompt, a reply or an exit. */
const turns = (line: TailLine) =>
  line.sort === "prompt" || line.sort === "reply" || line.sort === "exit";

/** What a line that decides is kept as: without its call, which only an approval is compared with. */
function decidingOf(
  line: Exclude<TailLine, { sort: "request" } | { sort: "resolved" } | { sort: "passed" }>,
): DecidingLine {
  switch (line.sort) {
    case "result":
    case "ask":
      return { sort: line.sort, at: line.at } as DecidingLine;
    case "tool":
    case "unreadable":
      return { sort: line.sort };
    default:
      return line;
  }
}

const has = (calls: readonly Buffer[], call: Buffer | null) =>
  call !== null && calls.some((one) => one.equals(call));

/** Whether an ID is one Oh My Pi gives a command that a `bash` call runs: that call's, then `:cmd:` and a number. */
function isCommand(call: Buffer): boolean {
  let number = call.byteLength;
  while (number > 0 && isDigit(call[number - 1])) number -= 1;
  const part = number - COMMAND_PART.byteLength;
  return number < call.byteLength && part > 0 && bytesAt(call, part, COMMAND_PART);
}

/** Whether a result for `call` ends this wait: one for its own call, or for the call that dispatched it, which a command can outlive. */
const resultEnds = (one: OpenApproval, call: Buffer) =>
  one.call.equals(call) || (one.parent?.equals(call) === true && !isCommand(one.call));

/** The tail after a line that could end a wait and cannot be read: none kept before it is known to wait. */
function unreadEnd(tail: Tail): Tail {
  if (tail.open.length === 0) return tail;
  const since = tail.open.some(({ start }) => start >= tail.turnStart);
  return { ...tail, open: [], unread: tail.unread || since };
}

/** The tail with one more approval open. */
function foldRequest(tail: Tail, one: OpenApproval): Tail {
  const open = [...tail.open.filter(({ call }) => !call.equals(one.call)), one];
  if (open.length <= MAX_OPEN_APPROVALS) return { ...tail, open };
  // More than it keeps: the oldest go, and whether they wait is not known.
  const gone = open.slice(0, -MAX_OPEN_APPROVALS);
  const since = gone.some(({ start }) => start >= tail.turnStart);
  return { ...tail, open: open.slice(-MAX_OPEN_APPROVALS), crowded: tail.crowded || since };
}

/** The tail with one more call started. */
function foldStart(tail: Tail, call: Buffer | null): Tail {
  if (call === null || has(tail.started, call)) return tail;
  return { ...tail, started: [...tail.started, call].slice(-MAX_STARTED_CALLS) };
}

/** The approvals after one more line, with the newest line and the exits as they were. */
function foldApprovals(tail: Tail, line: TailLine, start: number): Tail {
  const turned = turns(line) ? { ...tail, unread: false, crowded: false, turnStart: start } : tail;
  switch (line.sort) {
    case "exit":
      return { ...turned, replyStart: start, open: [], started: [] };
    case "reply": {
      // Each of the last reply's calls has its result by now, so one started with none was left by a crash.
      const { open, started } = tail;
      const left = open.filter(({ call, parent }) => !has(started, call) && !has(started, parent));
      return { ...turned, replyStart: start, open: left, started: [] };
    }
    case "prompt":
      return turned;
    case "tool":
    case "ask":
      return foldStart(tail, line.call);
    case "request": {
      const { call, parent, at } = line;
      return call === null
        ? { ...tail, unread: true }
        : foldRequest(tail, { start, at, call, parent, turn: tail.replyStart });
    }
    case "resolved":
    case "result": {
      const { call } = line;
      if (call === null) return unreadEnd(tail);
      const ended = tail.open.filter((one) =>
        line.sort === "result" ? resultEnds(one, call) : one.call.equals(call),
      );
      const runs = line.sort === "result" && has(tail.started, call);
      if (ended.length === 0 && !runs) return tail;
      return {
        ...tail,
        open: tail.open.filter((one) => !ended.includes(one)),
        started: runs ? tail.started.filter((one) => !one.equals(call)) : tail.started,
      };
    }
    // It could be the result that ends one, unless it is of a kind that ends none.
    case "unreadable":
      return line.endsNone === true ? tail : unreadEnd(tail);
    case "passed":
      return tail;
  }
}

/**
 * The tail after one more line, newer than every line before it, beginning at
 * `start`. A reply or a result keeps the exit behind and the exit cut off, or
 * takes the newest line as both when that is an exit. A tool's or an ask's
 * start keeps the exit cut off, or takes the newest exit as it, and drops the
 * exit behind. Any other line that decides drops both. An approval's request
 * or end changes only the approvals, which any line that decides can change
 * too.
 */
export function foldLine(before: Tail, line: TailLine, start: number): Tail {
  const tail = foldApprovals(before, line, start);
  if (line.sort === "passed" || line.sort === "request" || line.sort === "resolved") return tail;
  const next: Tail = { ...tail, newest: decidingOf(line), newestStart: start };
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

/** What looking back over a file's end finds. */
interface LookedBack {
  /** Its newest lines, with no approval and no call that runs told yet. */
  tail: Tail;
  /** Where the lines that tell those begin, or -1 when there are none. */
  from: number;
}

/**
 * Looks back over a file's end, from its newest whole line to the line that
 * decides, any exit before it and the newest prompt, reply or exit, and with
 * `further` on to the newest exit, for an approval that waits from an earlier
 * turn. When a request is met, or a tool's or an ask's start since the newest
 * reply or exit, on to the reply or exit before the first of them too. It
 * holds one piece, the first `LINE_HEAD_BYTES` of the bytes after it, and a
 * copy of a line's first bytes at once, and none of them once it is done.
 */
async function lookBack(file: OpenFile, size: number, further: boolean): Promise<LookedBack> {
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
    const far = { newestStart: -1, turnStart: -1, replyStart: -1 };
    return { tail: floor === 0 ? emptyTail(0) : { ...emptyTail(null), ...far }, from: -1 };
  }
  const end = last + 1;
  /** Lines judged, newest first, until the one that decides and every look back from it end. */
  let tail: Tail = { ...emptyTail(end), newestStart: -1, turnStart: -1, replyStart: -1 };
  /** Whether a tool's or an ask's start was looked back past, the newest among them: then no exit is behind. */
  let pastStart = false;
  /** Whether the look back for an exit is over, the one for the newest prompt, reply or exit, and the one for approvals. */
  let exitsDone = false;
  let turnDone = false;
  let whole = false;
  /** Whether a reply or an exit was met. */
  let replied = false;
  /** Where the lines begin that are read once more, onwards: at the reply or the exit before the earliest of them that is needed, once that is met. */
  let from = -1;
  let seekingReply = false;
  let lineEnd = last;
  while (!exitsDone || !turnDone || seekingReply || (further && !whole)) {
    const before = await newlineBefore(lineEnd);
    const start = before >= 0 ? before + 1 : floor === 0 ? 0 : -1;
    // Before what is read: what no line was found for is too far back.
    if (start < 0 || start < reach) {
      whole = true;
      break;
    }
    const line = judgeLine(headOf(start, lineEnd));
    const runs = !replied && (line.sort === "tool" || line.sort === "ask");
    if (line.sort === "request" || runs) seekingReply = true;
    if (seekingReply) from = start;
    if (line.sort === "reply" || line.sort === "exit") {
      seekingReply = false;
      if (!replied) tail = { ...tail, replyStart: start };
      replied = true;
    }
    if (line.sort !== "request" && line.sort !== "passed" && line.sort !== "resolved") {
      if (tail.newest === null) {
        tail = { ...tail, newest: decidingOf(line), newestStart: start };
        exitsDone = !keepsCutOff(line);
      } else if (!exitsDone && line.sort === "exit") {
        tail = {
          ...tail,
          behind: pastStart ? null : line,
          behindStart: pastStart ? 0 : start,
          cutOff: line,
          cutOffStart: start,
        };
        exitsDone = true;
      } else if (!keepsCutOff(line)) {
        exitsDone = true;
      }
      if (!keepsBehind(line)) pastStart = true;
      if (!turnDone && turns(line)) {
        tail = { ...tail, turnStart: start };
        turnDone = true;
      }
      // An exit ends every wait before it.
      if (line.sort === "exit") whole = true;
    }
    if (start === 0) {
      if (tail.newest === null) tail = { ...tail, newestStart: 0 };
      if (!turnDone) tail = { ...tail, turnStart: 0 };
      if (!replied) tail = { ...tail, replyStart: 0 };
      whole = true;
      break;
    }
    lineEnd = start - 1;
  }
  return { tail: { ...tail, whole }, from };
}

/**
 * Reads a file's end, as `lookBack` does. Then the lines from where it says
 * are read once more, onwards, for the approvals that wait and the calls that
 * run, so that they are told as `readOnwards` tells them.
 */
export async function readFromEnd(file: OpenFile, size: number, further = true): Promise<Tail> {
  const { tail, from } = await lookBack(file, size, further);
  if (tail.end === null || from < 0) return tail;
  const folded = await readOnwards(file, tail.end, emptyTail(from));
  if (folded === null) throw new Changed("The file changed while it was read.");
  const { open, started, unread, crowded } = folded;
  return { ...tail, open, started, unread, crowded };
}

/**
 * Folds what was added since `known` was read, onwards, a piece at a time,
 * holding one piece, the first `LINE_HEAD_BYTES` of the line being read, and
 * a copy of them as more are added.
 * Null when the file does not go on from there: shorter, grown by more than
 * `MAX_TAIL_BYTES`, or with no line break before what was added, and when it
 * was not read back to its newest exit, so an approval could wait unseen.
 */
export async function readOnwards(file: OpenFile, size: number, known: Tail): Promise<Tail | null> {
  const { end } = known;
  if (end === null || !known.whole || size < end || size - end > MAX_TAIL_BYTES) return null;
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
