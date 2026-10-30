import path from "node:path";

import { sessionName } from "../../../../core/text.ts";
import type { ReadOnlyIo } from "../../../files/readOnlyIo.ts";

/**
 * Reading the title agy gives a conversation, from
 * `<agy folder>/annotations/<conversation id>.pbtxt`, a file of a few bytes in
 * protocol buffer text format, such as `title:"List Directory Contents"` in
 * agy 1.3.1, or `title:"…" last_user_view_time:{seconds:… nanos:…}` on one line
 * in Antigravity 2.23.1. Only its `title` is read: any other field is passed
 * over without its value being kept.
 *
 * The file is looked at with `lstat` on each poll for each conversation
 * listed, and read only when it changed, and only when it is an ordinary file
 * of at most 4 KiB.
 */

/** Where the titles are, in the agy folder. */
export const ANNOTATIONS_DIR = "annotations";

/** The largest annotation file read. agy's hold a title and little else. */
export const ANNOTATION_LIMIT_BYTES = 4 * 1024;

/** The one field read. */
const TITLE = "title";

type Token =
  | { kind: "name"; text: string }
  | { kind: "string"; body: string }
  | { kind: "scalar" }
  | { kind: "mark"; text: string };

/** The text format's own white space. Other spaces, such as a no-break space, are not. */
const WHITE_SPACE = /[ \t\n\v\f\r]/;

/**
 * Marks: the brackets, `:`, `,`, `;` and `-`, and the characters of the name
 * of an extension or the type URL of an Any, in `[` and `]`.
 */
const MARKS = "{}<>[]:,;-./~!$&()*+=%";

/**
 * The tokens of a text-format message: names, strings with their escapes
 * still in them, other scalars with no value kept, and marks. White space and
 * `#` comments are dropped, and so is a byte order mark at the start. Null
 * when a character or a string is not text format, which includes a string
 * with an escape that is not one, even in a field that is not read.
 */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = text.startsWith("\uFEFF") ? 1 : 0;
  while (i < text.length) {
    const char = text[i];
    if (WHITE_SPACE.test(char)) {
      i += 1;
    } else if (char === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (char === '"' || char === "'") {
      const start = i + 1;
      i = start;
      while (text[i] !== char) {
        if (i >= text.length || text[i] === "\n") return null;
        if (text[i] === "\\") {
          if (i + 1 >= text.length || text[i + 1] === "\n") return null;
          i += 2;
        } else {
          i += 1;
        }
      }
      const body = text.slice(start, i);
      if (textFormatBytes(body) === null) return null;
      tokens.push({ kind: "string", body });
      i += 1;
    } else if (/[A-Za-z_]/.test(char)) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))![0];
      tokens.push({ kind: "name", text: name });
      i += name.length;
    } else if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      const number = /^(?:[eE][+-]|[0-9A-Za-z_.])+/.exec(text.slice(i))![0];
      tokens.push({ kind: "scalar" });
      i += number.length;
    } else if (MARKS.includes(char)) {
      tokens.push({ kind: "mark", text: char });
      i += 1;
    } else {
      return null;
    }
  }
  return tokens;
}

const CLOSING: Record<string, string> = { "{": "}", "<": ">", "[": "]" };

/**
 * The top-level `title` of a text-format message, as the bodies of its quoted
 * parts, in every form the format allows for a string field: on a line of its
 * own or among other fields, in single or double quotes, in one or several
 * quoted parts, with a `,` or `;` after it. Every other field is passed over,
 * and a message or list is skipped whole, so a `title` inside one is never
 * taken. Null when there is none, when it is not a string or is given twice,
 * or when the top level is not a list of fields: a field with no value, a
 * string or other single value with no `:` before it, which only a message
 * may leave out, or brackets that do not match. What is inside a message or a
 * list is skipped without its fields being checked.
 */
function topLevelTitle(text: string): string[] | null {
  const tokens = tokenize(text);
  if (tokens === null) return null;
  let at = 0;
  const isMark = (mark: string) => {
    const token = tokens[at];
    return token !== undefined && token.kind === "mark" && token.text === mark;
  };
  /** Moves past an open mark and everything up to its match. False when it has none. */
  const skipNested = (): boolean => {
    const open: string[] = [];
    do {
      const token = tokens[at];
      if (token === undefined) return false;
      at += 1;
      if (token.kind !== "mark") continue;
      if (token.text in CLOSING) open.push(CLOSING[token.text]);
      else if (token.text === open[open.length - 1]) open.pop();
      else if ("}>]".includes(token.text)) return false;
    } while (open.length > 0);
    return true;
  };

  let found: string[] | null = null;
  let seen = 0;
  while (at < tokens.length) {
    // The field's name, or an extension's or an Any's in brackets.
    const head = tokens[at];
    let name: string | null = null;
    if (head.kind === "name") {
      name = head.text;
      at += 1;
    } else if (head.kind === "mark" && head.text === "[") {
      if (!skipNested()) return null;
    } else {
      return null;
    }
    const colon = isMark(":");
    if (colon) at += 1;

    // Its value.
    const value = tokens[at];
    if (value === undefined) return null;
    if (value.kind === "mark" && value.text in CLOSING) {
      if (!skipNested()) return null;
      if (name === TITLE) return null;
    } else if (!colon) {
      return null;
    } else if (value.kind === "string") {
      const parts: string[] = [];
      for (let part = tokens[at]; part?.kind === "string"; part = tokens[at]) {
        parts.push(part.body);
        at += 1;
      }
      if (name === TITLE) {
        found = parts;
        seen += 1;
      }
    } else {
      if (isMark("-")) at += 1;
      const scalar = tokens[at];
      if (scalar === undefined || (scalar.kind !== "name" && scalar.kind !== "scalar")) return null;
      at += 1;
      if (name === TITLE) return null;
    }
    if (isMark(",") || isMark(";")) at += 1;
  }
  return seen === 1 ? found : null;
}

const SIMPLE_ESCAPES: Record<string, number> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  '"': 0x22,
  "'": 0x27,
  "\\": 0x5c,
  "?": 0x3f,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  v: 0x0b,
};

const HEAD_SURROGATES = [0xd800, 0xdbff];
const TRAIL_SURROGATES = [0xdc00, 0xdfff];
const within = (point: number, [low, high]: number[]) => point >= low && point <= high;

/**
 * The bytes of one quoted part of a text-format string, from its escapes:
 * `\n` and the like, `\"`, three octal digits and `\x` with hexadecimal ones,
 * in which a letter outside ASCII is written byte by byte, and `\u` and `\U`
 * with four or eight hexadecimal digits for a letter by its code point, a
 * letter outside the first plane being two `\u` in a row, a surrogate pair.
 * Null when an escape is not one of these.
 */
function textFormatBytes(body: string): number[] | null {
  // By code point, so a letter made of two code units is kept whole. Escapes are ASCII.
  const chars = Array.from(body);
  const bytes: number[] = [];
  const hexAt = (from: number, digits: number): number | null => {
    const hex = chars.slice(from, from + digits).join("");
    return new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex) ? parseInt(hex, 16) : null;
  };
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) return null;
    const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(""));
    if (octal !== null) {
      const value = parseInt(octal[0], 8);
      if (value > 0xff) return null;
      bytes.push(value);
      i += octal[0].length;
      continue;
    }
    if (next === "u" || next === "U") {
      const digits = next === "u" ? 4 : 8;
      let point = hexAt(i + 2, digits);
      if (point === null || point > 0x10ffff) return null;
      i += 1 + digits;
      if (next === "u" && within(point, HEAD_SURROGATES)) {
        const trail = chars[i + 1] === "\\" && chars[i + 2] === "u" ? hexAt(i + 3, 4) : null;
        if (trail === null || !within(trail, TRAIL_SURROGATES)) return null;
        point = 0x10000 + ((point - HEAD_SURROGATES[0]) << 10) + (trail - TRAIL_SURROGATES[0]);
        i += 6;
      } else if (within(point, [HEAD_SURROGATES[0], TRAIL_SURROGATES[1]])) {
        return null;
      }
      bytes.push(...Buffer.from(String.fromCodePoint(point), "utf8"));
      continue;
    }
    if (next === "x" || next === "X") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(chars.slice(i + 2, i + 4).join(""));
      if (hex === null) return null;
      bytes.push(parseInt(hex[0], 16));
      i += 1 + hex[0].length;
      continue;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple === undefined) return null;
    bytes.push(simple);
    i += 1;
  }
  return bytes;
}

/** Bytes read as UTF-8, or null when they are not UTF-8. */
function utf8(bytes: number[]): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/**
 * A text-format string from one quoted part, with its escapes undone and read
 * as UTF-8. Null when an escape is not one, or the bytes are not UTF-8.
 */
export function unescapeTextFormat(body: string): string | null {
  const bytes = textFormatBytes(body);
  return bytes === null ? null : utf8(bytes);
}

/**
 * The title an annotation file holds, cleaned and cut as any session's name
 * is, or null. A title in several quoted parts has each part's escapes undone
 * on its own, and the bytes joined, before they are read as UTF-8, as the
 * format says.
 */
export function readTitle(content: string): string | null {
  const parts = topLevelTitle(content);
  if (parts === null) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    const partBytes = textFormatBytes(part);
    if (partBytes === null) return null;
    bytes.push(...partBytes);
  }
  const title = utf8(bytes);
  return title === null ? null : (sessionName(title) ?? null);
}

interface Cached {
  ino: number;
  size: number;
  mtimeMs: number;
  title: string | null;
}

export interface TitleReader {
  /** The conversation's title, or null when it has none that could be read. Never throws. */
  read(conversationId: string): Promise<string | null>;
  /** Forgets every conversation not in this set. */
  keepOnly(ids: ReadonlySet<string>): void;
}

export function createTitleReader(options: { home: string; io: ReadOnlyIo }): TitleReader {
  const { io } = options;
  const dir = path.join(options.home, ANNOTATIONS_DIR);
  const cache = new Map<string, Cached>();

  async function read(id: string): Promise<string | null> {
    const file = path.join(dir, `${id}.pbtxt`);
    const info = await io.lstat(file);
    const known = cache.get(id);
    if (
      known &&
      known.ino === info.ino &&
      known.size === info.size &&
      known.mtimeMs === info.mtimeMs
    ) {
      return known.title;
    }
    let title: string | null = null;
    if (info.kind === "file" && info.size <= ANNOTATION_LIMIT_BYTES) {
      const handle = await io.openRegular(file);
      try {
        if (handle.info.size <= ANNOTATION_LIMIT_BYTES) {
          const data = await handle.read(0, handle.info.size);
          title = readTitle(Buffer.from(data).toString("utf8"));
        }
      } finally {
        await handle.close();
      }
    }
    cache.set(id, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, title });
    return title;
  }

  return {
    async read(id) {
      try {
        return await read(id);
      } catch {
        cache.delete(id);
        return null;
      }
    },
    keepOnly(ids) {
      for (const id of cache.keys()) {
        if (!ids.has(id)) cache.delete(id);
      }
    },
  };
}
