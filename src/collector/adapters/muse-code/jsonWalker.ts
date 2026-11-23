/**
 * A strict JSON tokenizer over the bytes of one line, which finds the values
 * at a few paths and steps over everything else, never turning a string into
 * text. Built for Muse Code's session logs, whose lines hold prompts,
 * questions, answers, commands and outputs unredacted. The Copilot CLI
 * adapter walks Copilot CLI's event logs with it too
 * (`../copilot-cli/records.ts`), so a change here changes both.
 *
 * Muse Code writes each record as one line, with its keys in the order of
 * Meta's export in its cookbook
 * (`04_muse_code/01_append_only_audit_log/artifacts/approval_slice.json`),
 * compact in Meta's hand-authored transcript and spaced after each colon and
 * comma in one reader's files, with the deciding field of an approval request
 * as its last key, so the Autohand Code adapter's readers, which rely on
 * pretty-printed JSON, do not fit. This one:
 *
 * - steps through objects, arrays, strings (an escape is `\` and one of
 *   `"\/bfnrt`, or `\u` and four hex digits), numbers, `true`, `false`,
 *   `null` and whitespace, to a depth of 32;
 * - compares each key, between its quotes, byte for byte with the keys of the
 *   paths wanted, and never matches a key that holds an escape;
 * - gives each wanted value as where its bytes are, and for an array whether
 *   it holds nothing, and steps over the rest;
 * - stops when the caller says it has what it needs, at the line's end, or at
 *   the end of the bytes it was given, when the line is longer than them.
 *
 * A syntax error, a depth past 32, or a wanted path met twice, before it
 * stops, is an error.
 */

/** A value at a wanted path, as where its bytes are in the line. */
export type Token =
  /** A string: its bytes between its quotes, and whether they hold an escape. */
  | { type: "string"; start: number; end: number; escaped: boolean }
  /** A number: its bytes. */
  | { type: "number"; start: number; end: number }
  /** An array: whether it holds nothing. The Copilot CLI adapter asks this of a reply's tool requests. */
  | { type: "array"; empty: boolean }
  | { type: "true" | "false" | "null" | "object" };

/** A path wanted: a key, and either the value read there or the keys wanted in the object there. */
export interface WantedKey {
  key: Buffer;
  /** Set for a value read: the number the caller knows it by. */
  leaf?: number;
  /** Set for an object gone into. */
  children?: readonly WantedKey[];
}

/** How a walk ended. */
export type WalkEnd =
  /** The caller had what it needed. */
  | "stopped"
  /** The whole line was walked. */
  | "end"
  /** The bytes given ended inside the line, which is longer than them. */
  | "cut"
  /** A syntax error, a depth past 32, or a wanted path met twice. */
  | "error";

/** The deepest nesting of objects and arrays walked. */
export const MAX_DEPTH = 32;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;
const MINUS = 0x2d;
const PLUS = 0x2b;
const DOT = 0x2e;
const ZERO = 0x30;

const TRUE = Buffer.from("true");
const FALSE = Buffer.from("false");
const NULL = Buffer.from("null");

/** The bytes after `\` that make a short escape. */
const SHORT_ESCAPES = new Set([...'"\\/bfnrt'].map((char) => char.charCodeAt(0)));

class Stop extends Error {}
class Bad extends Error {}
class Cut extends Error {}

const isSpace = (byte: number | undefined) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
const isDigit = (byte: number | undefined) => byte !== undefined && byte >= ZERO && byte <= 0x39;
const isHex = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= ZERO && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66));

/**
 * Walks `line`, the first bytes of one line without its line break, giving
 * `visit` each value at a path of `wanted`, in the order they come. `whole`
 * says whether `line` is the whole line, so that bytes ending early are a
 * syntax error and not a line cut short. `visit` returns true once it has
 * what it needs, which stops the walk there: nothing after is looked at.
 */
export function walkLine(
  line: Buffer,
  whole: boolean,
  wanted: readonly WantedKey[],
  visit: (leaf: number, token: Token) => boolean,
): WalkEnd {
  const length = line.byteLength;
  /** Past the bytes given: an error for a whole line, else a line cut short. */
  const past = (at: number) => {
    if (at >= length) throw whole ? new Bad() : new Cut();
  };
  const spaces = (from: number) => {
    let at = from;
    while (at < length && isSpace(line[at])) at += 1;
    return at;
  };

  /** Where a string whose opening quote is at `at` ends, past its closing quote, and whether it holds an escape. */
  function string(at: number): { end: number; escaped: boolean } {
    let cursor = at + 1;
    let escaped = false;
    for (;;) {
      past(cursor);
      const byte = line[cursor] as number;
      if (byte === QUOTE) return { end: cursor + 1, escaped };
      // A control character is never inside a JSON string.
      if (byte < 0x20) throw new Bad();
      if (byte !== BACKSLASH) {
        cursor += 1;
        continue;
      }
      escaped = true;
      past(cursor + 1);
      const next = line[cursor + 1] as number;
      if (SHORT_ESCAPES.has(next)) {
        cursor += 2;
        continue;
      }
      if (next !== 0x75) throw new Bad();
      for (let digit = 2; digit < 6; digit += 1) {
        past(cursor + digit);
        if (!isHex(line[cursor + digit])) throw new Bad();
      }
      cursor += 6;
    }
  }

  /** Where a number that begins at `at` ends. */
  function number(at: number): number {
    let cursor = at;
    const digits = () => {
      const from = cursor;
      while (cursor < length && isDigit(line[cursor])) cursor += 1;
      if (cursor === from) {
        past(cursor);
        throw new Bad();
      }
    };
    if (line[cursor] === MINUS) cursor += 1;
    past(cursor);
    if (line[cursor] === ZERO) cursor += 1;
    else digits();
    if (cursor < length && line[cursor] === DOT) {
      cursor += 1;
      digits();
    }
    if (cursor < length && (line[cursor] === 0x65 || line[cursor] === 0x45)) {
      cursor += 1;
      past(cursor);
      if (line[cursor] === PLUS || line[cursor] === MINUS) cursor += 1;
      digits();
    }
    // A number that runs to the end of a line cut short may go on past it.
    if (cursor >= length && !whole) throw new Cut();
    return cursor;
  }

  function literal(at: number, word: Buffer): number {
    for (let index = 0; index < word.byteLength; index += 1) {
      past(at + index);
      if (line[at + index] !== word[index]) throw new Bad();
    }
    return at + word.byteLength;
  }

  /** Where the value at `at` ends, going into an object whose keys are `children`, and its token. */
  function value(
    at: number,
    depth: number,
    children: readonly WantedKey[] | null,
  ): [number, Token] {
    past(at);
    const byte = line[at];
    if (byte === QUOTE) {
      const { end, escaped } = string(at);
      return [end, { type: "string", start: at + 1, end: end - 1, escaped }];
    }
    if (byte === OPEN_BRACE) return [object(at, depth + 1, children ?? []), { type: "object" }];
    if (byte === OPEN_BRACKET) {
      const inside = spaces(at + 1);
      const empty = inside < length && line[inside] === CLOSE_BRACKET;
      return [array(at, depth + 1), { type: "array", empty }];
    }
    if (byte === 0x74) return [literal(at, TRUE), { type: "true" }];
    if (byte === 0x66) return [literal(at, FALSE), { type: "false" }];
    if (byte === 0x6e) return [literal(at, NULL), { type: "null" }];
    if (byte === MINUS || isDigit(byte)) {
      const end = number(at);
      return [end, { type: "number", start: at, end }];
    }
    throw new Bad();
  }

  function array(at: number, depth: number): number {
    if (depth > MAX_DEPTH) throw new Bad();
    let cursor = spaces(at + 1);
    past(cursor);
    if (line[cursor] === CLOSE_BRACKET) return cursor + 1;
    for (;;) {
      [cursor] = value(cursor, depth, null);
      cursor = spaces(cursor);
      past(cursor);
      if (line[cursor] === CLOSE_BRACKET) return cursor + 1;
      if (line[cursor] !== COMMA) throw new Bad();
      cursor = spaces(cursor + 1);
    }
  }

  /** The wanted key a key's bytes, between its quotes, are, or null. */
  function wantedAt(start: number, end: number, keys: readonly WantedKey[]): WantedKey | null {
    for (const key of keys) {
      if (
        key.key.byteLength === end - start &&
        line.compare(key.key, 0, key.key.byteLength, start, end) === 0
      ) {
        return key;
      }
    }
    return null;
  }

  function object(at: number, depth: number, keys: readonly WantedKey[]): number {
    if (depth > MAX_DEPTH) throw new Bad();
    const met = new Set<WantedKey>();
    let cursor = spaces(at + 1);
    past(cursor);
    if (line[cursor] === CLOSE_BRACE) return cursor + 1;
    for (;;) {
      past(cursor);
      if (line[cursor] !== QUOTE) throw new Bad();
      const { end: keyEnd, escaped } = string(cursor);
      const wantedKey =
        escaped || keys.length === 0 ? null : wantedAt(cursor + 1, keyEnd - 1, keys);
      cursor = spaces(keyEnd);
      past(cursor);
      if (line[cursor] !== COLON) throw new Bad();
      cursor = spaces(cursor + 1);
      if (wantedKey !== null) {
        if (met.has(wantedKey)) throw new Bad();
        met.add(wantedKey);
      }
      const [end, token] = value(cursor, depth, wantedKey?.children ?? null);
      cursor = end;
      if (wantedKey?.leaf !== undefined && visit(wantedKey.leaf, token)) throw new Stop();
      cursor = spaces(cursor);
      past(cursor);
      if (line[cursor] === CLOSE_BRACE) return cursor + 1;
      if (line[cursor] !== COMMA) throw new Bad();
      cursor = spaces(cursor + 1);
    }
  }

  try {
    const start = spaces(0);
    const [end] = value(start, 0, wanted);
    const after = spaces(end);
    if (after < length) return "error";
    return whole ? "end" : "cut";
  } catch (error) {
    if (error instanceof Stop) return "stopped";
    if (error instanceof Cut) return "cut";
    if (error instanceof Bad) return "error";
    throw error;
  }
}
