import type {
  UnrealAgentInput,
  UnrealAgentItem,
  UnrealAgentLine,
  UnrealAgentOutcome,
} from "../../../core/mapping/unreal-agent/unrealAgentReplay.ts";
import { folderOf } from "../kimi-code/sessionIndex.ts";
import { INSTANT } from "../pi/sessionFile.ts";

/**
 * Reading the lines of an Unreal Agent session's file, as bytes. Built from
 * Unreal Agent's source at v0.3.1 and not yet checked on a computer running
 * it.
 *
 * Each line is one record, `{"type":…,"data":…}`, written by Go's
 * `encoding/json/v2`, which writes a struct's fields in the order they are
 * declared and every `"` inside a string as `\"` (`codec.go:230-243`). So
 * each line is compared, from its start, with the bytes Unreal Agent writes
 * for its kind, and a field is found only where the shape puts it, never by
 * searching. A string that may hold text is passed over to its closing `"`,
 * minding `\`, and never turned into text.
 *
 * Only these are turned into text: the session's ID, times, the IDs of turns
 * and commands, all checked byte by byte against what they can hold first,
 * and the folder a shell command runs in, decoded once with JSON's own rules
 * (`folderOfShellLine`). The words Unreal Agent uses for kinds, modes and
 * statuses are compared as bytes. No other part of a line is decoded.
 */

/** The most of a line kept while it is read. A longer line keeps this and its last bytes. */
export const LINE_KEEP_BYTES = 1024 * 1024;

/** The most of a longer line's end kept, for the bytes that say whether its reply failed. */
export const LINE_END_KEEP_BYTES = 32;

/** The longest ID passed over: of an input, a tool call or a reply. */
export const MAX_ID_BYTES = 4 * 1024;

/** The longest folder token read from a shell command's line. */
export const MAX_DIRECTORY_TOKEN_BYTES = 16 * 1024;

/** The most commands one tool call's status may wait for. */
export const MAX_WAITING_FOR = 64;

/** The format of session file this reads (`formatVersion`, codec.go:15). */
export const FORMAT_VERSION = 2;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** One line while it is read: its first bytes, and its last ones. */
export interface KeptLine {
  /** Its first bytes, at most `LINE_KEEP_BYTES`, without its newline. */
  head: Buffer;
  /** Its last bytes, at most `LINE_END_KEEP_BYTES`, without its newline. */
  end: Buffer;
  /** Whether it was longer than `head`. */
  cut: boolean;
}

/** A line, as the replay takes it, and for a shell command's line where its state begins. */
export type ReadLine = UnrealAgentLine & { shellStateAt?: number };

function bytes(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

function charset(...ranges: string[]): Uint8Array {
  const table = new Uint8Array(256);
  for (const range of ranges) {
    if (range.length === 3 && range[1] === "-") {
      for (let c = range.charCodeAt(0); c <= range.charCodeAt(2); c++) table[c] = 1;
    } else {
      for (const ch of range) table[ch.charCodeAt(0)] = 1;
    }
  }
  return table;
}

const DIGITS = charset("0-9");
const HEX_ID = charset("0-9", "a-f", "-");
const WORD = charset("a-z", "_");
const SESSION_ID = charset("a-z", "A-Z", "0-9", "-");
const TIME = charset("0-9", "TZ:.+-");

/**
 * A place in a line's kept bytes. Each step moves on and says whether the
 * bytes were as expected. None makes a string, except `token`.
 */
class Cursor {
  at = 0;
  constructor(private readonly data: Buffer) {}

  /** The bytes at the cursor are `literal`. */
  expect(literal: Buffer): boolean {
    const { data, at } = this;
    if (at + literal.byteLength > data.byteLength) return false;
    for (let i = 0; i < literal.byteLength; i++) if (data[at + i] !== literal[i]) return false;
    this.at = at + literal.byteLength;
    return true;
  }

  /** A run of digits, as a number, of at most `max` digits. */
  digits(max: number): number | null {
    const { data } = this;
    let next = this.at;
    let value = 0;
    while (next < data.byteLength && DIGITS[data[next] as number] === 1) {
      value = value * 10 + ((data[next] as number) - 0x30);
      next++;
      if (next - this.at > max) return null;
    }
    if (next === this.at) return null;
    this.at = next;
    return value;
  }

  /** Which word, if any, is at the cursor with a `"` after it. The `"` is left. */
  oneOf(words: readonly Buffer[]): number {
    for (const [index, word] of words.entries()) {
      const { at } = this;
      if (this.expect(word)) {
        if (this.data[this.at] === QUOTE) return index;
        this.at = at;
      }
    }
    return -1;
  }

  /** A run of bytes of a set, of `min` to `max` bytes. */
  skipCharset(set: Uint8Array, min: number, max: number): boolean {
    const { data } = this;
    let next = this.at;
    while (next < data.byteLength && set[data[next] as number] === 1) {
      next++;
      if (next - this.at > max) return false;
    }
    if (next - this.at < min) return false;
    this.at = next;
    return true;
  }

  /**
   * The rest of a JSON string whose `"` was just passed, up to its closing
   * `"`, which is left: the first `"` not after a `\` that is itself
   * escaped. False past `max` bytes, or past the bytes kept.
   */
  skipString(max: number): boolean {
    const { data } = this;
    const limit = Math.min(data.byteLength, this.at + max);
    let next = this.at;
    while (next < limit) {
      const byte = data[next];
      if (byte === QUOTE) {
        this.at = next;
        return true;
      }
      next += byte === BACKSLASH ? 2 : 1;
    }
    return false;
  }

  /** A run of bytes of a set, as text, of `min` to `max` bytes. */
  token(set: Uint8Array, min: number, max: number): string | null {
    const from = this.at;
    if (!this.skipCharset(set, min, max)) return null;
    return this.data.toString("latin1", from, this.at);
  }

  /** A UUID as Go's `uuid` package writes one: 36 lowercase hex digits and dashes. */
  uuid(): string | null {
    const from = this.at;
    const { data } = this;
    if (from + 36 > data.byteLength) return null;
    for (let i = 0; i < 36; i++) {
      const byte = data[from + i] as number;
      const dash = i === 8 || i === 13 || i === 18 || i === 23;
      if (dash ? byte !== 0x2d : HEX_ID[byte] !== 1 || byte === 0x2d) return null;
    }
    this.at = from + 36;
    return data.toString("latin1", from, from + 36);
  }

  /** A time as Go writes one, in UTC, in epoch milliseconds. */
  time(): number | null {
    const text = this.token(TIME, 20, 35);
    if (text === null || !INSTANT.test(text)) return null;
    const at = Date.parse(text);
    return Number.isNaN(at) ? null : at;
  }

  atEnd(): boolean {
    return this.at === this.data.byteLength;
  }

  peek(): number | undefined {
    return this.data[this.at];
  }
}

/** A session file's name: an ID of letters, digits and dashes (store.go:470-484), and 255 bytes at most in all. */
export const SESSION_FILE_NAME = /^[A-Za-z0-9-]{1,241}\.session\.jsonl$/;

const SESSION_FILE_ENDING = ".session.jsonl";

/** Whether a name in the sessions folder is a session file's. Anything else is never looked up. */
export function isSessionFileName(name: string): boolean {
  return SESSION_FILE_NAME.test(name);
}

/** The session's ID in a session file's name. */
export function idOfFileName(name: string): string {
  return name.slice(0, -SESSION_FILE_ENDING.length);
}

const HEADER_START = bytes('{"type":"session","data":{"Version":');
const HEADER_SESSION = bytes(',"Session":{"ID":"');
const HEADER_CREATED = bytes('","CreatedAt":"');
const HEADER_END = bytes('"}}}');

export type HeaderRead =
  { state: "ok"; id: string; createdAt: number } | { state: "newer" } | { state: "broken" };

/**
 * The first line (codec.go:25-33, session.go:17-20):
 * `{"type":"session","data":{"Version":2,"Session":{"ID":"<id>","CreatedAt":"<time>"}}}`.
 * A version above 2 is a newer Unreal Agent's.
 */
export function readHeader(line: Buffer): HeaderRead {
  const at = new Cursor(line);
  if (!at.expect(HEADER_START)) return { state: "broken" };
  const version = at.digits(9);
  if (version === null) return { state: "broken" };
  if (version > FORMAT_VERSION) return { state: "newer" };
  if (version !== FORMAT_VERSION || !at.expect(HEADER_SESSION)) return { state: "broken" };
  const id = at.token(SESSION_ID, 1, 241);
  if (id === null || !at.expect(HEADER_CREATED)) return { state: "broken" };
  const createdAt = at.time();
  if (createdAt === null || !at.expect(HEADER_END) || !at.atEnd()) return { state: "broken" };
  return { state: "ok", id, createdAt };
}

const ITEM_START = bytes('{"type":"item","data":{"Item":{"Sequence":');
const ITEM_RECORDED = bytes(',"RecordedAt":"');
const ITEM_KIND = bytes('","Kind":"');
const ITEM_DATA = bytes('","Data":{');
const OPERATION_START = bytes('{"type":"operation","data":{"Operation":{');

/** Item kinds (sessionstore.go:23-29). */
const ITEM_KINDS = ["fork", "input", "turn", "model_response", "tool_call_status"].map(bytes);

/**
 * One line after the first: an item, an operation, or a line not read.
 */
export function readLine(line: KeptLine): ReadLine {
  if (line.head.subarray(0, ITEM_START.byteLength).equals(ITEM_START)) return readItem(line);
  if (line.head.subarray(0, OPERATION_START.byteLength).equals(OPERATION_START)) {
    return readOperation(line.head);
  }
  return { kind: "unread" };
}

/**
 * An item (codec.go:35-38, sessionstore.go:33-38):
 * `{"type":"item","data":{"Item":{"Sequence":<n>,"RecordedAt":"<time>","Kind":"<kind>","Data":{…`.
 * Its number, time and kind come before its data, which holds no text before
 * the fields read.
 */
function readItem(line: KeptLine): UnrealAgentLine {
  const at = new Cursor(line.head);
  at.expect(ITEM_START);
  const sequence = at.digits(15);
  if (sequence === null || !at.expect(ITEM_RECORDED)) return { kind: "unread" };
  const recorded = at.time();
  if (recorded === null || !at.expect(ITEM_KIND)) return { kind: "unread" };
  const kind = at.oneOf(ITEM_KINDS);
  const item: UnrealAgentItem =
    kind < 0 || !at.expect(ITEM_DATA)
      ? { kind: "unread" }
      : kind === 0
        ? { kind: "fork" }
        : kind === 1
          ? readInput(at)
          : kind === 2
            ? readTurn(at)
            : kind === 3
              ? readReply(at, line)
              : readStatus(at);
  return { kind: "item", sequence, at: recorded, item };
}

const UNREAD: UnrealAgentItem = { kind: "unread" };

const INPUT_ID = bytes('"ID":"');
const INPUT_KIND = bytes('","Kind":"');
const EXTERNAL = bytes('external"');
const CONTROL_MODE = bytes('control","Payload":{"Mode":"');
/** Control modes (inbox.go:51-56). */
const MODES: readonly UnrealAgentInput[] = ["hard", "when_idle", "heartbeat", "settings"];
const MODE_WORDS = MODES.map(bytes);

/**
 * An input (inbox.go:24-28): `{"ID":"<id>","Kind":"external","Payload":…`, a
 * message whose text is in its payload and never looked at, or
 * `{"ID":"<id>","Kind":"control","Payload":{"Mode":"<mode>","Reason":…`,
 * whose reason comes after its mode and is never reached. Any other kind,
 * such as `crash`, or mode is not read.
 */
function readInput(at: Cursor): UnrealAgentItem {
  if (!at.expect(INPUT_ID) || !at.skipString(MAX_ID_BYTES) || !at.expect(INPUT_KIND)) {
    return UNREAD;
  }
  if (at.expect(EXTERNAL)) return { kind: "input", input: "external" };
  if (!at.expect(CONTROL_MODE)) return UNREAD;
  const mode = at.oneOf(MODE_WORDS);
  return mode < 0 ? UNREAD : { kind: "input", input: MODES[mode] as UnrealAgentInput };
}

const TURN_ID = bytes('"ID":"');
const TURN_PREVIOUS = bytes('","PreviousTurnID":"');
const TURN_TYPE = bytes('","Type":"');
const TURN_TYPES = ["regular", "compaction"] as const;
const TURN_TYPE_WORDS = TURN_TYPES.map(bytes);
const TURN_END = bytes('"}}}}');

/** A turn (session.go:22-26): `{"ID":"<uuid>","PreviousTurnID":"<uuid or empty>","Type":"<type>"}`. */
function readTurn(at: Cursor): UnrealAgentItem {
  if (!at.expect(TURN_ID)) return UNREAD;
  const id = at.uuid();
  if (id === null || !at.expect(TURN_PREVIOUS) || !at.skipCharset(HEX_ID, 0, 36)) return UNREAD;
  if (!at.expect(TURN_TYPE)) return UNREAD;
  const type = at.oneOf(TURN_TYPE_WORDS);
  if (type < 0 || !at.expect(TURN_END) || !at.atEnd()) return UNREAD;
  return { kind: "turn", id, type: TURN_TYPES[type] as "regular" | "compaction" };
}

const REPLY_TURN = bytes('"TurnID":"');
const REPLY_ID = bytes('","Response":{"ID":"');
const REPLY_STOP = bytes('","Stop":"');
/** Stop reasons (model.go:122-126), and none. */
const STOPS = ["complete", "refused", "max_output_tokens", ""].map(bytes);
/** How a reply's line ends with no failure: its last field, `Failure`, is null (model.go:128-134). */
const NO_FAILURE_END = bytes(',"Failure":null}}}}}');
/** How it ends with one: the failure's message, a string, closes it (model.go:162-165). */
const FAILURE_END = bytes('"}}}}}}');

/**
 * A reply (sessionstore.go:51-54, model.go:128-134):
 * `{"TurnID":"<uuid>","Response":{"ID":"<id>","Stop":"<stop>",…,"Failure":null}`.
 * Its output, which holds the model's text, reasoning and tool calls, and its
 * counts come between its stop and its failure and are never looked at.
 * Whether it failed is told from the line's last bytes alone: the failure is
 * its last field, and nothing follows a reply in its line (codec.go:35-38).
 */
function readReply(at: Cursor, line: KeptLine): UnrealAgentItem {
  if (!at.expect(REPLY_TURN)) return UNREAD;
  const turnId = at.uuid();
  if (turnId === null || !at.expect(REPLY_ID) || !at.skipString(MAX_ID_BYTES)) return UNREAD;
  if (!at.expect(REPLY_STOP)) return UNREAD;
  let stop = at.oneOf(STOPS);
  if (stop < 0) {
    // A stop of a newer Unreal Agent's.
    if (!at.skipCharset(WORD, 1, 32)) return UNREAD;
    stop = -1;
  }
  if (at.peek() !== QUOTE) return UNREAD;
  let failed: boolean;
  if (endsWith(line.end, NO_FAILURE_END)) failed = false;
  else if (endsWith(line.end, FAILURE_END)) failed = true;
  else return UNREAD;
  let outcome: UnrealAgentOutcome;
  if (failed || stop === 1 || stop === 2) outcome = "failed";
  else if (stop === 0) outcome = "complete";
  else outcome = "unclear";
  return { kind: "reply", turnId, outcome };
}

function endsWith(data: Buffer, literal: Buffer): boolean {
  if (data.byteLength < literal.byteLength) return false;
  return data.subarray(data.byteLength - literal.byteLength).equals(literal);
}

const STATUS_TURN = bytes('"TurnID":"');
const STATUS_CALL = bytes('","CallID":"');
const STATUS_ERROR = bytes('","Status":{"Error":"');
const STATUS_NO_WAIT = bytes('"}}}');
const STATUS_WAITING = bytes('","WaitingFor":[');
const STATUS_OPERATIONS = bytes(']}}},"Operations":[{');
const MAX_OUTPUT = bytes('"MaxOutputLength":');
const COMMA_BYTES = bytes(",");
const OPERATION_ID = bytes('"ID":"');
const OPERATION_TYPE = bytes('","Type":"');
const OPERATION_VERSION = bytes('","Version":');
const OPERATION_STATUS = bytes(',"Status":"');
const QUOTE_BYTES = bytes('"');
/** The first status a tool call's commands have, and the ones that end them (operation.go:21-29). */
const CALL_STATUSES = ["ready", "completed", "failed", "canceled"].map(bytes);

/**
 * A tool call's status (sessionstore.go:56-61, tool.go:13-17), whose
 * commands follow it in its line (store.go:189-198):
 * `{"TurnID":…,"CallID":…,"Status":{"Error":"<error>"[,"ErrorTruncated":true][,"WaitingFor":[…]]}},"Operations":[…]`.
 *
 * - An error that is not empty: the call failed at once, and a turn follows.
 *   The error is never read on.
 * - Waiting for nothing: not written at v0.3.1 (state.go:237-239).
 * - Waiting for commands, with the first command's status `ready`: the first
 *   status (loop.go:813-861). With an ending status: the second, written once
 *   all of them ended (863-900).
 */
function readStatus(at: Cursor): UnrealAgentItem {
  if (!at.expect(STATUS_TURN) || !at.skipCharset(HEX_ID, 1, 36)) return UNREAD;
  if (!at.expect(STATUS_CALL) || !at.skipString(MAX_ID_BYTES) || !at.expect(STATUS_ERROR)) {
    return UNREAD;
  }
  if (at.peek() !== QUOTE) return { kind: "status-done" };
  if (at.expect(STATUS_NO_WAIT)) return { kind: "status-done" };
  if (!at.expect(STATUS_WAITING)) return UNREAD;
  const ids: string[] = [];
  do {
    if (ids.length >= MAX_WAITING_FOR || !at.expect(QUOTE_BYTES)) return UNREAD;
    const id = at.uuid();
    if (id === null || !at.expect(QUOTE_BYTES)) return UNREAD;
    ids.push(id);
  } while (at.expect(COMMA_BYTES));
  if (!at.expect(STATUS_OPERATIONS)) return UNREAD;
  if (at.expect(MAX_OUTPUT) && (!at.skipCharset(DIGITS, 1, 16) || !at.expect(COMMA_BYTES))) {
    return UNREAD;
  }
  if (!at.expect(OPERATION_ID) || !at.skipCharset(HEX_ID, 1, 36)) return UNREAD;
  if (!at.expect(OPERATION_TYPE) || !at.skipCharset(WORD, 1, 32)) return UNREAD;
  if (!at.expect(OPERATION_VERSION) || !at.skipCharset(DIGITS, 1, 10)) return UNREAD;
  if (!at.expect(OPERATION_STATUS)) return UNREAD;
  const status = at.oneOf(CALL_STATUSES);
  if (status < 0) return UNREAD;
  return status === 0 ? { kind: "status-created", ids } : { kind: "status-completed", ids };
}

/** Command statuses (operation.go:21-29), the last of them none. */
const OPERATION_STATUSES = [
  "ready",
  "awaiting",
  "canceling",
  "completed",
  "failed",
  "canceled",
  "",
].map(bytes);
const TERMINAL = new Set([3, 4, 5]);
const SHELL = [bytes("shell")];
/** The shell command's version whose state this reads (shell.go:15-17). */
const SHELL_VERSION = 3;

/**
 * A command's newest state (store.go:207-229, operation.go:39-47):
 * `{"type":"operation","data":{"Operation":{["MaxOutputLength":<n>,]"ID":"<uuid>","Type":"<type>","Version":<n>,"Status":"<status>",…`.
 * Its state, which holds the command and its output, comes after.
 */
function readOperation(head: Buffer): ReadLine {
  const at = new Cursor(head);
  at.expect(OPERATION_START);
  if (at.expect(MAX_OUTPUT) && (!at.skipCharset(DIGITS, 1, 16) || !at.expect(COMMA_BYTES))) {
    return { kind: "unread" };
  }
  if (!at.expect(OPERATION_ID)) return { kind: "unread" };
  const id = at.uuid();
  if (id === null || !at.expect(OPERATION_TYPE)) return { kind: "unread" };
  const shell = at.oneOf(SHELL) === 0;
  if (!shell && !at.skipCharset(WORD, 1, 32)) return { kind: "unread" };
  if (!at.expect(OPERATION_VERSION)) return { kind: "unread" };
  const version = at.digits(10);
  if (version === null || !at.expect(OPERATION_STATUS)) return { kind: "unread" };
  const status = at.oneOf(OPERATION_STATUSES);
  if (status < 0 || !at.expect(QUOTE_BYTES)) return { kind: "unread" };
  const line: ReadLine = { kind: "operation", id, terminal: TERMINAL.has(status) };
  if (shell && version === SHELL_VERSION) line.shellStateAt = at.at;
  return line;
}

const STATE_COMMAND = bytes(',"State":{"Input":{"Command":"');
const STATE_SHELL = bytes('","Shell":"');
const STATE_DIRECTORY = bytes('","Directory":"');
const STATE_BASE = bytes('"},"BaseDirectory":"');

/**
 * The folder a shell command runs in, from its line's state, which begins at
 * `stateAt` (shell.go:36-52):
 * `,"State":{"Input":{"Command":"<command>","Shell":"<shell>","Directory":"<folder>"},"BaseDirectory":…`.
 * The command and the shell are passed over as bytes, and the folder is the
 * one part decoded, with JSON's own rules. It must be a folder this system
 * could have, as every adapter's folder must (`folderOf`). Null when any step fails, as for
 * two records written into one line.
 */
export function folderOfShellLine(
  head: Buffer,
  stateAt: number,
  platform: NodeJS.Platform,
): string | null {
  const at = new Cursor(head);
  at.at = stateAt;
  if (!at.expect(STATE_COMMAND) || !at.skipString(head.byteLength)) return null;
  if (!at.expect(STATE_SHELL) || !at.skipString(MAX_ID_BYTES)) return null;
  if (!at.expect(STATE_DIRECTORY)) return null;
  const from = at.at;
  if (!at.skipString(MAX_DIRECTORY_TOKEN_BYTES)) return null;
  const to = at.at;
  if (!at.expect(STATE_BASE)) return null;
  let value: unknown;
  try {
    value = JSON.parse(`"${head.toString("utf8", from, to)}"`);
  } catch {
    return null;
  }
  return folderOf(value, platform);
}
