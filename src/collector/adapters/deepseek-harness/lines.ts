import type {
  DeepseekHarnessEnd,
  DeepseekHarnessLine,
} from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import { plausibleTime } from "../../../core/time.ts";
import { pathsOf } from "../../files/paths.ts";

/**
 * Reading the lines of a DeepSeek Harness log, as bytes. Built from DeepSeek
 * Harness's source at dsh-v0.2.2-rc.3 and not yet checked on a computer
 * running it.
 *
 * The first line is the session's header, which is parsed as JSON once its
 * first bytes are a header's. Every other line is one event, written by
 * `JSON.stringify` with its keys in the order its writer builds the object:
 * `type`, `seq`, `time`, `data`, then others (core/session/src/index.ts:
 * 538-544, session-persistence-jsonl/src/format.ts:321-324). A chat imported
 * from chat.deepseek.com is written by the import itself, not by a session,
 * with `type`, `data`, then others, then `seq` and `time` (deepseek-chat-
 * import/src/conversation.ts:180-183, importer.ts:564-568). Both orders are
 * read.
 * `JSON.stringify` writes every `"` inside a string as `\"`, so bytes such as
 * `","seq":` or `,"data":{"turn":` can only be the line's own structure, never
 * text in it.
 *
 * Of an event line only its first `LINE_HEAD_BYTES` are looked at, and
 * compared with the bytes each wanted kind begins with. What a status needs
 * of a kind comes before any text: a turn's reason, an approval's ID, a
 * call's ID and its tool's name. So do the kind, number and time, except in
 * the chat import's order, where the number and time are its last bytes and
 * are taken only when the whole line is within those first bytes. These
 * become text only once their bytes pass a check of what they can hold: the
 * IDs, with `latin1`. A title its model wrote, or one marked as the person's,
 * is the one part of a line decoded with JSON's own rules, and only for a
 * session shown, never for a subagent's.
 */

/** The most of a line looked at, except a title's. */
export const LINE_HEAD_BYTES = 512;

/** The longest title line read. A longer one gives no name. */
export const TITLE_LINE_MAX = 4 * 1024;

/** The longest title turned into text, in bytes as written. */
export const TITLE_MAX = 1024;

/** The longest event kind passed over to find its number. */
const TYPE_MAX = 128;

/** The longest call ID taken. */
const CALL_ID_MAX = 128;

/** The longest session ID, parent ID and folder kept from a header. */
const ID_MAX = 1024;
const CWD_MAX = 4096;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

const bytes = (text: string) => Buffer.from(text, "latin1");

const HEADER_START = bytes('{"type":"session","version":4,"id":"');
const TYPE_START = bytes('{"type":"');
const SEQ = bytes('","seq":');
const TIME = bytes(',"time":');
const DATA = bytes(',"data":');
/** After the kind, in the chat import's order. */
const DATA_FIRST = bytes('","data":');
/** Before the number, at a line's end in the chat import's order. */
const SEQ_KEY = bytes(',"seq":');
const CLOSE = bytes("}");

const TURN = bytes('{"turn":');
const REASON = bytes(',"reason":{"kind":"');
const ID = bytes('{"id":"');
const OUTCOME = bytes('","outcome":"');
const STEP = bytes(',"step":');
const CALL_ID = bytes(',"callId":"');
const NAME = bytes('","name":"');
const ARGUMENTS = bytes('","arguments":');
const RESULT = bytes(',"message":{"role":"tool","source":{"kind":"tool","callId":"');
const INHERITED = bytes('{"inherited":true}');
const TITLE = bytes('{"title":"');
const TITLE_END = bytes('","messageSeqs":[');
const SOURCE = bytes('],"source":{"kind":"');

/** The tools whose calls wait for the person: a question, and a plan to approve. */
const QUESTION_TOOLS = [bytes("ask_user_question"), bytes("exit_plan_mode")];

const TYPES = {
  turnStart: bytes("turn/start"),
  turnEnd: bytes("turn/end"),
  approvalAsked: bytes("approval/asked"),
  approvalDecided: bytes("approval/decided"),
  toolCall: bytes("tool/call"),
  toolResult: bytes("tool/result"),
  endSeed: bytes("session/end-seed"),
  title: bytes("session/title"),
};

const ENDS: ReadonlyMap<string, DeepseekHarnessEnd> = new Map([
  ["completed", "completed"],
  ["blocked", "blocked"],
  ["max-tokens", "max-tokens"],
  ["interrupted", "interrupted"],
  ["forked", "forked"],
  ["aborted", "aborted"],
  ["error", "error"],
]);

/** A place in a line's bytes. Each step moves on and says whether the bytes were as expected. */
class Cursor {
  at: number;
  constructor(
    private readonly data: Uint8Array,
    at = 0,
  ) {
    this.at = at;
  }

  /** The bytes at the cursor are `literal`. */
  expect(literal: Uint8Array): boolean {
    const { data, at } = this;
    if (at + literal.byteLength > data.byteLength) return false;
    for (let i = 0; i < literal.byteLength; i++) if (data[at + i] !== literal[i]) return false;
    this.at = at + literal.byteLength;
    return true;
  }

  /** Whether the bytes at the cursor are `literal`, without moving. */
  sees(literal: Uint8Array): boolean {
    const { at } = this;
    const seen = this.expect(literal);
    this.at = at;
    return seen;
  }

  /** A run of 1 to 16 digits, as a number, or null. */
  digits(): number | null {
    const { data } = this;
    let next = this.at;
    let value = 0;
    while (
      next < data.byteLength &&
      (data[next] as number) >= 0x30 &&
      (data[next] as number) <= 0x39
    ) {
      value = value * 10 + ((data[next] as number) - 0x30);
      next++;
      if (next - this.at > 16) return null;
    }
    if (next === this.at || !Number.isSafeInteger(value)) return null;
    this.at = next;
    return value;
  }

  /**
   * Where a run of printable bytes other than `"` and `\` ends, of 1 to `max`
   * bytes up to a `"`, which is left; or -1.
   */
  plain(max: number): number {
    const { data } = this;
    let next = this.at;
    while (next < data.byteLength && next - this.at <= max) {
      const byte = data[next] as number;
      if (byte === QUOTE) return next > this.at ? next : -1;
      if (byte < 0x20 || byte > 0x7e || byte === BACKSLASH) return -1;
      next++;
    }
    return -1;
  }

  /** A word of `a`-`z` and `-`, of 1 to `max` bytes, up to a `"`, which is left; as text, or null. */
  word(max: number): string | null {
    const { data } = this;
    let next = this.at;
    while (next < data.byteLength && next - this.at < max) {
      const byte = data[next] as number;
      if (byte === QUOTE) break;
      if (!((byte >= 0x61 && byte <= 0x7a) || byte === 0x2d)) return null;
      next++;
    }
    if (next === this.at || data[next] !== QUOTE) return null;
    const text = latin1(data, this.at, next);
    this.at = next;
    return text;
  }

  /** A UUID as `randomUUID` writes one, 36 lowercase hex digits and dashes; as text, or null. */
  uuid(): string | null {
    const { data, at } = this;
    if (at + 36 > data.byteLength) return null;
    for (let i = 0; i < 36; i++) {
      const byte = data[at + i] as number;
      const dash = i === 8 || i === 13 || i === 18 || i === 23;
      const hex = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
      if (dash ? byte !== 0x2d : !hex) return null;
    }
    this.at = at + 36;
    return latin1(data, at, at + 36);
  }
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function latin1(data: Uint8Array, start: number, end: number): string {
  return asBuffer(data).toString("latin1", start, end);
}

/** Whether `data` from `at` is `literal`. */
function same(data: Uint8Array, at: number, end: number, literal: Uint8Array): boolean {
  if (end - at !== literal.byteLength) return false;
  for (let i = 0; i < literal.byteLength; i++) if (data[at + i] !== literal[i]) return false;
  return true;
}

/** What is kept of a session's header. */
export interface DeepseekHarnessHeader {
  id: string;
  /** When the session was made, or null when that time cannot be right. */
  createdAt: number | null;
  /** The folder it began in, or null when it has none that can be used. */
  cwd: string | null;
  /** The ID of the session whose subagent it is, or null. */
  parentSession: string | null;
  /** Whether it is a subagent's session. */
  subagent: boolean;
}

/** The keys a header may have (session-persistence-jsonl/src/format.ts:96-98). */
const HEADER_KEYS = new Set([
  "type",
  "version",
  "id",
  "createdAt",
  "cwd",
  "parentSession",
  "isSeeded",
  "origin",
  "delegationDepth",
  "agentPreset",
]);

const CONTROL = /\p{Cc}/u;

const isCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The header, from a log's first line without its newline, or null when it
 * is not one of format 4 that DeepSeek Harness itself would read
 * (format.ts:158-187). Its first bytes are checked before it is parsed. Of
 * it, the ID, the time, the folder and the parent are kept; whether it was
 * forked, how deep it is delegated and its preset are dropped with the
 * parsed line.
 */
export function readHeader(
  line: Uint8Array,
  now: number,
  platform: NodeJS.Platform,
): DeepseekHarnessHeader | null {
  if (!new Cursor(line).expect(HEADER_START)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Of(line, 0, line.byteLength));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const header = parsed as Record<string, unknown>;
  if (!Object.keys(header).every((key) => HEADER_KEYS.has(key))) return null;
  const { id, createdAt, cwd, parentSession, origin } = header;
  if (header.type !== "session" || header.version !== 4) return null;
  if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX) return null;
  if (!isCount(createdAt) || !isCount(header.delegationDepth)) return null;
  if (typeof header.isSeeded !== "boolean") return null;
  if (cwd !== undefined && typeof cwd !== "string") return null;
  if (parentSession !== undefined && typeof parentSession !== "string") return null;
  if (origin !== undefined && origin !== "subagent") return null;
  if (header.agentPreset !== undefined && typeof header.agentPreset !== "string") return null;
  const folder =
    typeof cwd === "string" &&
    cwd.length <= CWD_MAX &&
    !CONTROL.test(cwd) &&
    pathsOf(platform).isAbsolute(cwd)
      ? cwd
      : null;
  return {
    id,
    createdAt: plausibleTime(createdAt, now),
    cwd: folder,
    parentSession:
      typeof parentSession === "string" && parentSession.length <= ID_MAX ? parentSession : null,
    subagent: origin === "subagent",
  };
}

/** One event line, as far as it was read. */
export interface ReadEvent {
  /**
   * Its number, or null when the line is not an event this can read, or is
   * in the chat import's order and its end was not read.
   */
  seq: number | null;
  line: DeepseekHarnessLine;
  /** For a title line of a session shown: its title, or null for none of its own. */
  title?: string | null;
}

const UNSURE: DeepseekHarnessLine = { kind: "unsure" };
const OTHER: DeepseekHarnessLine = { kind: "other" };

/** The kind of a line, as where it ends and starts, or null for a line that is not an event. */
interface Envelope {
  typeStart: number;
  typeEnd: number;
  /** Its number, or null for a line in the chat import's order whose end was not read. */
  seq: number | null;
  time: number | null;
  /** Where `data`'s value begins. */
  dataAt: number;
}

/**
 * The number and time a line in the chat import's order ends with,
 * `,"seq":<n>,"time":<n>}`, from its last `,"seq":`; or null. They are taken
 * only when they end the whole line, `length` bytes, so only when it is all
 * in `head`.
 */
function endOf(head: Uint8Array, length: number): { seq: number; time: number } | null {
  const at = asBuffer(head).lastIndexOf(SEQ_KEY);
  if (at < 0) return null;
  const cursor = new Cursor(head, at + SEQ_KEY.byteLength);
  const seq = cursor.digits();
  if (seq === null || !cursor.expect(TIME)) return null;
  const time = cursor.digits();
  if (time === null || !cursor.expect(CLOSE) || cursor.at !== length) return null;
  return { seq, time };
}

function envelopeOf(head: Uint8Array, length: number, now: number): Envelope | null {
  const cursor = new Cursor(head);
  if (!cursor.expect(TYPE_START)) return null;
  const typeStart = cursor.at;
  const typeEnd = cursor.plain(TYPE_MAX);
  if (typeEnd < 0) return null;
  cursor.at = typeEnd;
  if (cursor.expect(DATA_FIRST)) {
    // The chat import's order: its data first, and its number and time last.
    const end = endOf(head, length);
    return {
      typeStart,
      typeEnd,
      seq: end?.seq ?? null,
      time: end === null ? null : plausibleTime(end.time, now),
      dataAt: cursor.at,
    };
  }
  if (!cursor.expect(SEQ)) return null;
  const seq = cursor.digits();
  if (seq === null || !cursor.expect(TIME)) return null;
  const time = cursor.digits();
  if (time === null || !cursor.expect(DATA)) return null;
  return { typeStart, typeEnd, seq, time: plausibleTime(time, now), dataAt: cursor.at };
}

/** `{"turn":<n>` and, for a call or a result, `,"step":<n>`. */
function turnAndStep(cursor: Cursor, step: boolean): boolean {
  if (!cursor.expect(TURN) || cursor.digits() === null) return false;
  return !step || (cursor.expect(STEP) && cursor.digits() !== null);
}

function turnEnd(cursor: Cursor, time: number | null): DeepseekHarnessLine {
  if (!turnAndStep(cursor, false) || !cursor.expect(REASON)) return UNSURE;
  const kind = cursor.word(32);
  if (kind === null) return UNSURE;
  const end = ENDS.get(kind) ?? "other";
  if (end !== "aborted") return { kind: "turn-end", end, time };
  // An aborted turn's own reason follows: `disposed` when DeepSeek Harness closed the session.
  cursor.at += 1;
  if (!cursor.expect(REASON)) return UNSURE;
  const why = cursor.word(32);
  if (why === null) return UNSURE;
  return { kind: "turn-end", end: why === "disposed" ? "disposed" : "aborted", time };
}

/** A call's ID after `"callId":"`, up to its `"`, which is left; as text, or null. */
function callIdOf(cursor: Cursor, head: Uint8Array): string | null {
  const end = cursor.plain(CALL_ID_MAX);
  if (end < 0) return null;
  const id = latin1(head, cursor.at, end);
  cursor.at = end;
  return id;
}

function toolCall(cursor: Cursor, head: Uint8Array, time: number | null): DeepseekHarnessLine {
  if (!turnAndStep(cursor, true) || !cursor.expect(CALL_ID)) return UNSURE;
  const end = cursor.plain(CALL_ID_MAX);
  if (end < 0) return UNSURE;
  const idStart = cursor.at;
  cursor.at = end;
  if (!cursor.expect(NAME)) return UNSURE;
  for (const tool of QUESTION_TOOLS) {
    const at = cursor.at;
    if (cursor.expect(tool) && cursor.expect(ARGUMENTS)) {
      return { kind: "question-asked", callId: latin1(head, idStart, end), time };
    }
    cursor.at = at;
  }
  return OTHER;
}

function toolResult(cursor: Cursor, head: Uint8Array): DeepseekHarnessLine {
  if (!turnAndStep(cursor, true) || !cursor.expect(RESULT))
    return { kind: "tool-result", callId: null };
  return { kind: "tool-result", callId: callIdOf(cursor, head) };
}

/**
 * A title line's own title, or null for none: one its model wrote
 * (`provider`) or one marked as the person's (`user`), at most 1 KiB as
 * written, on a line of at most 4 KiB. The title is passed over to the first
 * `","messageSeqs":[`, which can only be where it ends, then the numbers to
 * `]`, then the kind of its source is compared as bytes
 * (session-title/src/index.ts:422-426, :627-635, :810-814). Only then is the
 * title decoded. A `fallback` title, the first words of the person's first
 * prompt, is never decoded.
 */
function titleOf(line: Uint8Array, length: number, at: number): string | null {
  if (length > TITLE_LINE_MAX || line.byteLength < length) return null;
  const cursor = new Cursor(line, at);
  if (!cursor.expect(TITLE)) return null;
  const start = cursor.at;
  let end = -1;
  for (let i = start; i + TITLE_END.byteLength <= line.byteLength; i++) {
    if (line[i] === QUOTE && same(line, i, i + TITLE_END.byteLength, TITLE_END)) {
      end = i;
      break;
    }
  }
  if (end < 0 || end - start > TITLE_MAX) return null;
  cursor.at = end + TITLE_END.byteLength;
  while (cursor.at < line.byteLength) {
    const byte = line[cursor.at] as number;
    if (!((byte >= 0x30 && byte <= 0x39) || byte === 0x2c)) break;
    cursor.at++;
  }
  if (!cursor.expect(SOURCE)) return null;
  const kind = cursor.word(16);
  if (kind !== "provider" && kind !== "user") return null;
  try {
    const text: unknown = JSON.parse(`"${utf8Of(line, start, end)}"`);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

function utf8Of(data: Uint8Array, start: number, end: number): string {
  return asBuffer(data).toString("utf8", start, end);
}

/**
 * Whether a line's first bytes say it is a title, in either order, which is
 * then read up to `TITLE_LINE_MAX`.
 */
export function isTitleLine(head: Uint8Array): boolean {
  const cursor = new Cursor(head);
  return (
    cursor.expect(TYPE_START) &&
    cursor.expect(TYPES.title) &&
    (cursor.sees(SEQ) || cursor.sees(DATA_FIRST))
  );
}

/**
 * One event line, from its bytes without its newline: `line` holds at least
 * its first `LINE_HEAD_BYTES`, or all of it when it is shorter, and for a
 * title line of a session shown up to `TITLE_LINE_MAX`. `length` is the
 * whole line's. With `titles` false, as for a subagent's log, a title line
 * is one more line of no kind.
 */
export function readEvent(
  line: Uint8Array,
  length: number,
  now: number,
  titles: boolean,
): ReadEvent {
  const head = line.subarray(0, Math.min(line.byteLength, LINE_HEAD_BYTES));
  const envelope = envelopeOf(head, length, now);
  if (envelope === null) return { seq: null, line: UNSURE };
  const { typeStart, typeEnd, seq, time, dataAt } = envelope;
  const is = (type: Uint8Array) => same(head, typeStart, typeEnd, type);
  const cursor = new Cursor(head, dataAt);
  if (is(TYPES.turnStart)) {
    return { seq, line: turnAndStep(cursor, false) ? { kind: "turn-start", time } : UNSURE };
  }
  if (is(TYPES.turnEnd)) return { seq, line: turnEnd(cursor, time) };
  if (is(TYPES.approvalAsked) || is(TYPES.approvalDecided)) {
    const decided = is(TYPES.approvalDecided);
    if (!cursor.expect(ID)) return { seq, line: UNSURE };
    const id = cursor.uuid();
    if (id === null) return { seq, line: UNSURE };
    if (decided) {
      return { seq, line: cursor.expect(OUTCOME) ? { kind: "approval-decided", id } : UNSURE };
    }
    return {
      seq,
      line: head[cursor.at] === QUOTE ? { kind: "approval-asked", id, time } : UNSURE,
    };
  }
  if (is(TYPES.toolCall)) return { seq, line: toolCall(cursor, head, time) };
  if (is(TYPES.toolResult)) return { seq, line: toolResult(cursor, head) };
  if (is(TYPES.endSeed)) {
    return { seq, line: { kind: "end-seed", inherited: cursor.expect(INHERITED), time } };
  }
  if (is(TYPES.title) && titles) return { seq, line: OTHER, title: titleOf(line, length, dataAt) };
  return { seq, line: OTHER };
}
