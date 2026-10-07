import path from "node:path";

import { sessionName } from "../../../core/text.ts";
import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading the title agy gives a conversation, from
 * `<agy folder>/annotations/<conversation id>.pbtxt`, a file of a few bytes in
 * protocol buffer text format, such as `title:"List Directory Contents"` in
 * agy 1.3.1. Only its `title` is read: any other field is passed over.
 *
 * The file is looked at with `lstat` on each poll for each conversation
 * listed, and read only when it changed, and only when it is an ordinary file
 * of at most 4 KiB.
 */

/** Where the titles are, in the agy folder. */
export const ANNOTATIONS_DIR = "annotations";

/** The largest annotation file read. agy's hold a title and little else. */
export const ANNOTATION_LIMIT_BYTES = 4 * 1024;

/** A `title` field at the start of a line: `title: "…"` or `title:"…"`, the string with its escapes. */
const TITLE_FIELD = /^[ \t]*title[ \t]*:[ \t]*"((?:[^"\\\n]|\\.)*)"[ \t]*$/m;

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

/**
 * A text-format string's bytes, from its escapes: `\n` and the like, `\"`,
 * three octal digits and `\x` with hexadecimal ones, in which a letter
 * outside ASCII is written byte by byte, then read as UTF-8. Null when an
 * escape is not one of these.
 */
export function unescapeTextFormat(body: string): string | null {
  // By code point, so a letter made of two code units is kept whole. Escapes are ASCII.
  const chars = Array.from(body);
  const bytes: number[] = [];
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** The title an annotation file holds, cleaned and cut as any session's name is, or null. */
export function readTitle(content: string): string | null {
  const field = TITLE_FIELD.exec(content);
  if (field === null) return null;
  const title = unescapeTextFormat(field[1]);
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
