import path from "node:path";

import { INSTANT } from "../pi/sessionFile.ts";
import { decodeAtMost } from "../prime-agent/journals.ts";

/**
 * Finding a few fields in a file Autohand Code writes, as bytes, without
 * turning the rest of it into text. Built from Autohand Code's source at
 * v0.9.11 and not yet checked on a computer running it.
 *
 * Every writer of a heartbeat and of a session's `metadata.json` writes
 * `JSON.stringify(value, null, 2)` (`atomicWriteJson` in
 * `src/utils/atomicFile.ts:523-534`, the importer's `writeJson` in
 * `src/import/importers/BaseImporter.ts:216`, the web transfer in
 * `src/session/transfer/transfer-session-store.ts:66`). Such text has a line
 * break only between its parts, never inside a string, where JSON writes one
 * as `\n`, and it writes each key of the outer object on a line of its own
 * after exactly two spaces, and each key of an object inside it after four or
 * more. So a line break, two spaces and `"<key>": ` can only begin a key of the
 * outer object. A file written another way has no such bytes, and its fields
 * are then not known, never wrong.
 *
 * Each byte is checked as a number. Only two functions here turn bytes into
 * text, and nothing else in the adapter's folder does:
 *
 * - `asciiOf`, for bytes already checked against a short list, such as the
 *   digits and signs of a time;
 * - `literalOf`, for one JSON string, from its opening quote to the first
 *   quote no backslash escapes, given alone to `JSON.parse`. When that fails,
 *   the error and its words, which can hold the bytes, are dropped.
 */

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACE = 0x7b;

/** The longest time read: Autohand Code writes 24 bytes. */
const MAX_TIME_BYTES = 40;

/** The most digits of a process ID. */
const MAX_PID_DIGITS = 10;

/** The bytes that begin a key of the outer object: a line break, two spaces and the key in quotes. */
export function topKey(key: string): Buffer {
  return Buffer.from(`\n  "${key}": `);
}

/** The same, for a key whose value is a string: up to its opening quote, which is not included. */
export function topStringKey(key: string): Buffer {
  return Buffer.from(`\n  "${key}": "`);
}

/** Where the value after `anchor` begins, or -1 when the anchor is not wholly in `bytes`. */
export function valueAfter(bytes: Buffer, anchor: Buffer): number {
  const at = bytes.indexOf(anchor);
  return at < 0 ? -1 : at + anchor.byteLength;
}

/** Whether `word` is in `bytes` at `at`, byte for byte. */
export function bytesAt(bytes: Buffer, at: number, word: Buffer): boolean {
  if (at < 0 || at + word.byteLength > bytes.byteLength) return false;
  for (let index = 0; index < word.byteLength; index += 1) {
    if (bytes[at + index] !== word[index]) return false;
  }
  return true;
}

/** Which of `words` is in `bytes` at `at`, or -1. Each word ends with its closing quote. */
export function wordAt(bytes: Buffer, at: number, words: readonly Buffer[]): number {
  return words.findIndex((word) => bytesAt(bytes, at, word));
}

const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const isLetter = (byte: number) => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);

/** A byte of a session's ID as Autohand Code names its heartbeat: a letter, a digit, `_`, `.` or `-`. */
export function isIdByte(byte: number): boolean {
  return isLetter(byte) || isDigit(byte) || byte === 0x5f || byte === 0x2e || byte === 0x2d;
}

/** A byte of a time as `Date.toISOString()` writes one: a digit or one of `:.TZ+-`. */
function isTimeByte(byte: number): boolean {
  return (
    isDigit(byte) ||
    byte === 0x3a ||
    byte === 0x2e ||
    byte === 0x54 ||
    byte === 0x5a ||
    byte === 0x2b ||
    byte === 0x2d
  );
}

/**
 * The bytes of a string from `at`, just past its opening quote, to its closing
 * quote, when there are 1 to `max` of them and each is one `allowed` lets
 * through, or null. A quote that does not come in time leaves it null.
 */
export function runAt(
  bytes: Buffer,
  at: number,
  max: number,
  allowed: (byte: number) => boolean,
): Buffer | null {
  if (at < 0) return null;
  for (let end = at; end < bytes.byteLength && end - at <= max; end += 1) {
    const byte = bytes[end] ?? 0;
    if (byte === QUOTE) return end > at ? bytes.subarray(at, end) : null;
    if (!allowed(byte)) return null;
  }
  return null;
}

/**
 * A whole number of 1 to `maxDigits` digits at `at`, followed by a comma, or
 * null. It is worked out from the digits' values, not from text.
 */
export function wholeNumberAt(
  bytes: Buffer,
  at: number,
  maxDigits = MAX_PID_DIGITS,
): number | null {
  if (at < 0) return null;
  let value = 0;
  let end = at;
  while (end < bytes.byteLength && isDigit(bytes[end] ?? 0)) {
    if (end - at >= maxDigits) return null;
    value = value * 10 + ((bytes[end] ?? 0) - 0x30);
    end += 1;
  }
  return end > at && bytes[end] === COMMA ? value : null;
}

/** Checked bytes as text, when there are at most `max` of them. */
export function asciiOf(bytes: Buffer, max: number): string | null {
  return decodeAtMost(bytes, max);
}

/**
 * One JSON string, from the quote at `at` to the first quote no backslash
 * escapes, as text, when it is at most `max` bytes long between its quotes and
 * JSON reads it as one, or null. Nothing past its closing quote is looked at.
 */
export function literalOf(bytes: Buffer, at: number, max: number): string | null {
  if (at < 0 || bytes[at] !== QUOTE) return null;
  let end = at + 1;
  while (end < bytes.byteLength) {
    if (end - at - 1 > max) return null;
    const byte = bytes[end];
    if (byte === QUOTE) break;
    end += byte === BACKSLASH ? 2 : 1;
  }
  if (end >= bytes.byteLength || end - at - 1 > max) return null;
  const text = decodeAtMost(bytes.subarray(at, end + 1), max + 2);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "string" ? value : null;
  } catch {
    // The error's words can hold the bytes, so it is dropped unread.
    return null;
  }
}

/** A time in a string that begins at `at`, just past its opening quote, in epoch milliseconds, or null. */
export function timeAt(bytes: Buffer, at: number): number | null {
  const run = runAt(bytes, at, MAX_TIME_BYTES, isTimeByte);
  if (run === null) return null;
  const text = asciiOf(run, MAX_TIME_BYTES);
  if (text === null || !INSTANT.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** The time of a key of the outer object whose value is a string, or null. */
export function topTime(bytes: Buffer, key: string): number | null {
  return timeAt(bytes, valueAfter(bytes, topStringKey(key)));
}

/**
 * The folder in a string that begins with the quote at `at`, when it is at
 * most `max` bytes long, holds no control character and is a whole path on
 * this system's rules, or null.
 */
export function folderAt(
  bytes: Buffer,
  at: number,
  max: number,
  platform: NodeJS.Platform,
): string | null {
  const value = literalOf(bytes, at, max);
  if (value === null || value === "" || /\p{Cc}/u.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? value : null;
}

/**
 * Whether bytes are the whole of a JSON object as Autohand Code writes one:
 * `{` first and `}` last, with at most one line break after it. A file cut off
 * as it was written in place ends otherwise.
 */
export function isWholeObject(bytes: Buffer): boolean {
  if (bytes[0] !== OPEN_BRACE) return false;
  let end = bytes.byteLength - 1;
  if (bytes[end] === NEWLINE) end -= 1;
  return end > 0 && bytes[end] === CLOSE_BRACE;
}
