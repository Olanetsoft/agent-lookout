import { isUtf8 } from "node:buffer";
import path from "node:path";

/**
 * Judging the lines of an fx session's log, as bytes. Built from fx's source
 * at v0.0.17 and not yet checked on a computer running it.
 *
 * Every line fx writes is one JSON object on one line, in one fixed form
 * (`schema.zig` and `log.zig`):
 *
 *   {"v":1,"seq":7,"ts":1727400000000,"kind":"turn_committed","turn":2,"crc":"1a2b3c4d"}
 *
 * The header comes first, always in this order, with no space and no leading
 * zero. Then come the fields of its kind, then the checksum of every byte
 * before `,"crc":"`, CRC32C, as 8 lowercase hex digits. A line counts only
 * when its length, its frame, its checksum and its header all pass, as fx's
 * own reader judges it, and its `seq` is one more than the line before it.
 *
 * Nothing here turns a line into text, with one exception: the folder in the
 * first line, `workspace`, which is decoded once. Every byte of every other
 * line it judges is fed to the checksum, which reads bytes as numbers, and
 * only its header and, for the lines that end a turn, the fields after it are
 * compared, as bytes. A prompt, a reply, a tool's output or a title is in a
 * line's `data` or `value`, and is never looked at. fx writes a line break
 * inside a string as `\n`, so no text can start a line, and a piece of a line
 * fails the checksum.
 */

/** The longest line fx writes, its newline included (`max_line_bytes`). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

const CRC_FIELD = bytes(',"crc":"');
const CRC_END = bytes('"}\n');
/** `,"crc":"`, 8 hex digits and `"}` with the newline. A line is at least this long. */
export const MIN_LINE_BYTES = CRC_FIELD.byteLength + 8 + CRC_END.byteLength;

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;

/** The newest format of line this reads. A higher `v` is a newer fx's. */
export const LOG_VERSION = 1;

/** The longest name of a kind fx allows. */
const MAX_KIND_BYTES = 32;

/** The longest folder kept. A longer one is not a folder. */
const MAX_CWD_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

function bytes(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

/** CRC32C (Castagnoli, polynomial 0x82F63B78, reflected), one byte at a time. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC32C of the bytes from `start` to `end`. */
export function crc32c(data: Uint8Array, start = 0, end = data.byteLength): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Whether the bytes at `at` are `literal`. */
function has(data: Uint8Array, at: number, end: number, literal: Uint8Array): boolean {
  if (at + literal.byteLength > end) return false;
  for (let i = 0; i < literal.byteLength; i++) if (data[at + i] !== literal[i]) return false;
  return true;
}

/**
 * A run of decimal digits at `at`, as fx writes a number: at least one, no
 * leading zero, and no larger than `max`. Null for anything else.
 */
function number(
  data: Uint8Array,
  at: number,
  end: number,
  max = Number.MAX_SAFE_INTEGER,
): { value: number; next: number } | null {
  let next = at;
  let value = 0;
  while (next < end && data[next] >= 0x30 && data[next] <= 0x39) {
    value = value * 10 + (data[next] - 0x30);
    if (value > max) return null;
    next++;
  }
  if (next === at) return null;
  if (next - at > 1 && data[at] === 0x30) return null;
  return { value, next };
}

/** The value of a lowercase hex digit, as fx writes a checksum, or -1. */
function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

/** Whether a byte is a hex digit of either case, as JSON allows after `\u`. */
function isHex(byte: number): boolean {
  return hexDigit(byte) >= 0 || (byte >= 0x41 && byte <= 0x46);
}

const V = bytes('{"v":');
const SEQ = bytes(',"seq":');
const TS = bytes(',"ts":');
const KIND = bytes(',"kind":"');

/** The header of a line, and where its kind's fields are. */
interface Frame {
  v: number;
  seq: number;
  ts: number;
  kindStart: number;
  kindEnd: number;
  /** Where the kind's fields begin: just past the header. */
  bodyStart: number;
  /** Where they end: at `,"crc":"`. */
  bodyEnd: number;
}

/**
 * The header of one whole line, from `start` to just past its newline, when
 * the line counts by fx's rules: its length, its frame, its checksum, its
 * header, and a `,` or nothing after the header. Null when it does not.
 *
 * A number past what JavaScript holds exactly is taken as a line that does
 * not count. fx writes none: its numbers are counts and times in milliseconds.
 */
function frameOf(data: Uint8Array, start: number, end: number): Frame | null {
  const length = end - start;
  if (length < MIN_LINE_BYTES || length > MAX_LINE_BYTES) return null;
  const bodyEnd = end - MIN_LINE_BYTES;
  if (!has(data, bodyEnd, end, CRC_FIELD)) return null;
  if (!has(data, end - CRC_END.byteLength, end, CRC_END)) return null;
  let stored = 0;
  for (let i = bodyEnd + CRC_FIELD.byteLength; i < end - CRC_END.byteLength; i++) {
    const digit = hexDigit(data[i]);
    if (digit < 0) return null;
    stored = stored * 16 + digit;
  }
  if (crc32c(data, start, bodyEnd) !== stored) return null;

  if (!has(data, start, bodyEnd, V)) return null;
  const v = number(data, start + V.byteLength, bodyEnd, 0xffffffff);
  if (v === null || !has(data, v.next, bodyEnd, SEQ)) return null;
  const seq = number(data, v.next + SEQ.byteLength, bodyEnd);
  if (seq === null || !has(data, seq.next, bodyEnd, TS)) return null;
  const ts = number(data, seq.next + TS.byteLength, bodyEnd);
  if (ts === null || !has(data, ts.next, bodyEnd, KIND)) return null;
  const kindStart = ts.next + KIND.byteLength;
  let kindEnd = kindStart;
  while (
    kindEnd < bodyEnd &&
    ((data[kindEnd] >= 0x61 && data[kindEnd] <= 0x7a) || data[kindEnd] === 0x5f)
  ) {
    kindEnd++;
  }
  if (kindEnd >= bodyEnd || data[kindEnd] !== QUOTE) return null;
  if (v.value === 0 || seq.value === 0) return null;
  if (kindEnd === kindStart || kindEnd - kindStart > MAX_KIND_BYTES) return null;
  const bodyStart = kindEnd + 1;
  if (bodyStart < bodyEnd && data[bodyStart] !== COMMA) return null;
  return { v: v.value, seq: seq.value, ts: ts.value, kindStart, kindEnd, bodyStart, bodyEnd };
}

/**
 * What a line that counts says for a session's status:
 *
 * open     `turn_started`, or an `item`, which fx writes only inside an open turn
 * ended    `turn_committed`, or `turn_interrupted`, with whether it failed
 * closed   `closed`, which fx writes as it lets a session go
 * neutral  a setting, a snapshot, a compaction or a subagent's start or end
 * created  `session_created`, which only the first line may be
 * odd      a kind fx 0.0.17 does not write, or a turn line of another shape
 * newer    a line of a newer format than this reads
 */
export type LineSort = "open" | "ended" | "closed" | "neutral" | "created" | "odd" | "newer";

export interface CountedLine {
  seq: number;
  ts: number;
  sort: LineSort;
  /** For `ended`: whether the turn ended as failed. */
  failed: boolean;
}

const KINDS: [
  Buffer,
  "open" | "turn" | "ended-turn" | "interrupted" | "closed" | "neutral" | "created",
][] = [
  [bytes("session_created"), "created"],
  [bytes("turn_started"), "turn"],
  [bytes("item"), "open"],
  [bytes("compacted"), "neutral"],
  [bytes("turn_committed"), "ended-turn"],
  [bytes("turn_interrupted"), "interrupted"],
  [bytes("set"), "neutral"],
  [bytes("child_spawned"), "neutral"],
  [bytes("child_finished"), "neutral"],
  [bytes("snapshot"), "neutral"],
  [bytes("closed"), "closed"],
];

const TURN = bytes(',"turn":');
const REASON = bytes(',"reason":"');
const REASONS = ["cancel", "failed", "closed", "crash"].map((reason) => ({
  failed: reason === "failed",
  bytes: bytes(`${reason}"`),
}));

function kindOf(data: Uint8Array, frame: Frame) {
  const length = frame.kindEnd - frame.kindStart;
  for (const [name, kind] of KINDS) {
    if (name.byteLength === length && has(data, frame.kindStart, frame.kindEnd, name)) return kind;
  }
  return null;
}

/** The end of `,"turn":<number>` at `at`, or null. */
function turnField(data: Uint8Array, at: number, end: number): number | null {
  if (!has(data, at, end, TURN)) return null;
  return number(data, at + TURN.byteLength, end)?.next ?? null;
}

/**
 * Judges one whole line, from `start` to just past its newline: null when it
 * does not count, else its `seq`, its `ts` and what it says. Only the header
 * and the fields of a turn line are compared, as bytes.
 */
export function judgeLine(data: Uint8Array, start: number, end: number): CountedLine | null {
  const frame = frameOf(data, start, end);
  if (frame === null) return null;
  const line = (sort: LineSort, failed = false): CountedLine => ({
    seq: frame.seq,
    ts: frame.ts,
    sort,
    failed,
  });
  if (frame.v > LOG_VERSION) return line("newer");
  const { bodyStart, bodyEnd } = frame;
  const kind = kindOf(data, frame);
  switch (kind) {
    case "open":
    case "neutral":
    case "created":
      return line(kind);
    case "closed":
      return line(bodyStart === bodyEnd ? "closed" : "odd");
    case "turn":
      return line(turnField(data, bodyStart, bodyEnd) === bodyEnd ? "open" : "odd");
    case "ended-turn":
      return line(turnField(data, bodyStart, bodyEnd) === bodyEnd ? "ended" : "odd");
    case "interrupted": {
      const at = turnField(data, bodyStart, bodyEnd);
      if (at === null || !has(data, at, bodyEnd, REASON)) return line("odd");
      const from = at + REASON.byteLength;
      for (const reason of REASONS) {
        if (from + reason.bytes.byteLength === bodyEnd && has(data, from, bodyEnd, reason.bytes)) {
          return line("ended", reason.failed);
        }
      }
      return line("odd");
    }
    default:
      return line("odd");
  }
}

/** Whether a name is a session's id as fx allows one (`validId` in `schema.zig`). */
export function isSessionId(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 255 &&
    !name.startsWith(".") &&
    name !== "index.jsonl" &&
    name !== "index.lock" &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

/** The end of an id at `at`, of fx's letters, closed by a quote, or null. */
function idField(data: Uint8Array, at: number, end: number): number | null {
  let next = at;
  while (next < end && next - at <= 255) {
    const byte = data[next];
    const letter =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x2d;
    if (!letter) break;
    next++;
  }
  const length = next - at;
  if (length === 0 || length > 255 || data[at] === 0x2e || data[next] !== QUOTE) return null;
  return next + 1;
}

/**
 * The end of a JSON string at `at`, by JSON's rules, read as bytes: a quote,
 * then any byte but a quote, a backslash or a control byte, or a backslash
 * and what may follow one, then a quote. Null for anything else.
 */
function stringToken(data: Uint8Array, at: number, end: number): number | null {
  if (at >= end || data[at] !== QUOTE) return null;
  let next = at + 1;
  while (next < end) {
    const byte = data[next];
    if (byte === QUOTE) return next + 1;
    if (byte < 0x20) return null;
    if (byte !== BACKSLASH) {
      next++;
      continue;
    }
    const escaped = data[next + 1];
    if (escaped === 0x75) {
      for (let i = next + 2; i < next + 6; i++) {
        if (i >= end || !isHex(data[i])) return null;
      }
      next += 6;
    } else if ([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(escaped)) {
      next += 2;
    } else {
      return null;
    }
  }
  return null;
}

/** The name of the field at `at`, as `,"name":`, as bytes, and where its value begins, or null. */
function fieldAt(
  data: Uint8Array,
  at: number,
  end: number,
): { name: Buffer; value: number } | null {
  if (at + 1 >= end || data[at] !== COMMA || data[at + 1] !== QUOTE) return null;
  let next = at + 2;
  while (next < end && data[next] !== QUOTE && data[next] !== BACKSLASH) next++;
  if (next >= end || data[next] !== QUOTE || data[next + 1] !== COLON) return null;
  return { name: Buffer.from(data.subarray(at + 2, next)), value: next + 2 };
}

/** The fields of fx 0.0.17's first line, in the order it writes them. */
const CREATED_FIELDS = ["id", "workspace", "role", "host", "parent", "forked_from"].map(bytes);

const ROOT = bytes('"root"');
const CHILD = bytes('"child"');
const FORK_ID = bytes('{"id":"');
const FORK_SEQ = bytes(',"seq":');

/** What is kept of a session's first line. */
export interface FirstLine {
  id: string;
  /** The session's folder: an absolute path, or null when it is not one. */
  cwd: string | null;
  /** The line's `ts`: when the session was made. */
  ts: number;
  /** Whether fx made the session for a subagent. */
  child: boolean;
  /** The `seq` of the last line copied from the session it was forked from, or 0. */
  forkSeq: number;
}

/**
 * The folder in a first line's `workspace`, by the rule every adapter keeps
 * for a folder: not empty, not too long, no control character, and absolute.
 * This is the one place a line is turned into text.
 */
function folderOf(token: Uint8Array): string | null {
  if (!isUtf8(token)) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  return path.posix.isAbsolute(value) ? value : null;
}

/**
 * What a log's first line says, from its bytes up to just past its newline,
 * for the session in the folder `folderName`: "newer" when a newer fx wrote
 * it, with a higher `v` or a field 0.0.17 does not write, and null when it is
 * not a session's first line, or not this folder's.
 *
 * The line is `session_created` with `seq` 1 and these fields, in this order
 * (`appendBody` in `schema.zig`): `id`, which must be the folder's name,
 * `workspace`, `role`, `host`, then `parent` and `forked_from` when there are
 * any. `host` is checked and dropped. Of `forked_from`, only its `seq` is
 * kept: the session's lines up to it were copied from the other session.
 */
export function readFirstLine(
  data: Uint8Array,
  end: number,
  folderName: string,
): FirstLine | "newer" | null {
  const frame = frameOf(data, 0, end);
  if (frame === null) return null;
  if (frame.v > LOG_VERSION) return "newer";
  if (frame.seq !== 1 || kindOf(data, frame) !== "created") return null;
  const { bodyEnd } = frame;
  let at = frame.bodyStart;

  /**
   * The value of the field `index` of `CREATED_FIELDS` at `at`, or why not:
   * "newer" for a field 0.0.17 does not write, "missing" for another of its
   * fields or nothing, as for an optional one left out.
   */
  function field(index: number): number | "newer" | "missing" {
    const found = fieldAt(data, at, bodyEnd);
    if (found === null) return "missing";
    if (found.name.equals(CREATED_FIELDS[index])) return found.value;
    return CREATED_FIELDS.some((known) => known.equals(found.name)) ? "missing" : "newer";
  }

  const id = field(0);
  if (typeof id !== "number") return id === "newer" ? "newer" : null;
  const name = Buffer.from(`"${folderName}"`, "latin1");
  if (!isSessionId(folderName) || !has(data, id, bodyEnd, name)) return null;
  at = id + name.byteLength;

  const workspace = field(1);
  if (typeof workspace !== "number") return workspace === "newer" ? "newer" : null;
  const tokenEnd = stringToken(data, workspace, bodyEnd);
  if (tokenEnd === null) return null;
  const cwd = folderOf(data.subarray(workspace, tokenEnd));
  at = tokenEnd;

  const role = field(2);
  if (typeof role !== "number") return role === "newer" ? "newer" : null;
  const child = has(data, role, bodyEnd, CHILD);
  if (!child && !has(data, role, bodyEnd, ROOT)) return null;
  at = role + (child ? CHILD : ROOT).byteLength;

  const host = field(3);
  if (typeof host !== "number") return host === "newer" ? "newer" : null;
  let hostEnd = host + 1;
  while (
    hostEnd < bodyEnd &&
    ((data[hostEnd] >= 0x61 && data[hostEnd] <= 0x7a) || data[hostEnd] === 0x5f)
  ) {
    hostEnd++;
  }
  const hostLength = hostEnd - host - 1;
  if (
    data[host] !== QUOTE ||
    data[hostEnd] !== QUOTE ||
    hostLength < 1 ||
    hostLength > MAX_KIND_BYTES
  ) {
    return null;
  }
  at = hostEnd + 1;

  const parent = field(4);
  if (parent === "newer") return "newer";
  if (typeof parent === "number") {
    if (data[parent] !== QUOTE) return null;
    const parentEnd = idField(data, parent + 1, bodyEnd);
    if (parentEnd === null) return null;
    at = parentEnd;
  }

  let forkSeq = 0;
  const forked = field(5);
  if (forked === "newer") return "newer";
  if (typeof forked === "number") {
    if (!has(data, forked, bodyEnd, FORK_ID)) return null;
    const forkIdEnd = idField(data, forked + FORK_ID.byteLength, bodyEnd);
    if (forkIdEnd === null || !has(data, forkIdEnd, bodyEnd, FORK_SEQ)) return null;
    const seq = number(data, forkIdEnd + FORK_SEQ.byteLength, bodyEnd);
    if (seq === null || data[seq.next] !== 0x7d) return null;
    forkSeq = seq.value;
    at = seq.next + 1;
  }

  if (at !== bodyEnd) {
    const extra = fieldAt(data, at, bodyEnd);
    if (extra === null || CREATED_FIELDS.some((known) => known.equals(extra.name))) return null;
    return "newer";
  }
  return { id: folderName, cwd, ts: frame.ts, child, forkSeq };
}

/** Where the first newline is in these bytes, or -1. */
export function firstNewline(data: Uint8Array): number {
  return data.indexOf(NEWLINE);
}
