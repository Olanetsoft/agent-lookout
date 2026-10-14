import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { envelopeOf, type Envelope } from "./envelope.ts";

/**
 * Reading a Vibe session's journal segment, for the newest public state in it.
 *
 * Between two saves of a session whole, Vibe records what happens in the
 * segment the manifest names, `journal/<16 digits>.jsonl`, one record a line,
 * each added with one write (harness/.../vibe/_storage.py at 2.26.1). A line is
 * JSON with sorted keys, so the record's `payload` comes first and its `type`
 * last:
 *
 * `{"payload":{…},"previous_record_sha256":…,"record_sha256":"…","recovery_journal_record_version":1,"sequence":N,"type":"<type>"}`
 *
 * The status and the title change only through `projection_delta` records,
 * whose payload is `{"delta":[<steps>],"watermark":N}`. The steps add or
 * replace entries of the conversation first, then, when anything else
 * changed, end with `{"op":"set_envelope","state":{<public state>}}`: the
 * whole public state with its history left out. A rename and a title Vibe
 * makes are recorded this way, with no save after them, so the newest state
 * is often here and not in the generation (`stores.ts`).
 *
 * So the reader:
 *
 * - tells each line's type by its end, `,"type":"<type>"}`, and parses no line;
 * - for a `projection_delta`, takes only what lies between the last
 *   `{"op":"set_envelope","state":` and the last `}],"watermark":`, and
 *   parses that alone. A `"` inside a JSON string is always escaped, so the
 *   two can only be the record's own structure. The entries before them,
 *   which hold what was said, run and read, are never parsed or kept;
 * - takes a `projection_advanced` record, a whole state that only some older
 *   builds wrote, as a state it does not read.
 *
 * Every read is bounded. The first read of a segment looks back from its end
 * through at most 8 MiB for the newest line that sets the state, and can read
 * the state from a line longer than that, whose start it never reaches. After
 * that, only what was added is read, at most 8 MiB at a time. A last line with
 * no newline yet is one Vibe is still writing, or one it will cut off: it is
 * left for the next read.
 */

/** The most of a segment's end looked through at once. A single line can be far longer. */
export const TAIL_LIMIT_BYTES = 8 * 1024 * 1024;

/** The tail is read backwards in pieces of this size. */
const TAIL_CHUNK_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

const ENVELOPE_START = Buffer.from('{"op":"set_envelope","state":');
const ENVELOPE_END = Buffer.from('}],"watermark":');

/** A record's type, from the end of its line. */
const RECORD_TYPE = /,"type":"([a-z_]{1,64})"\}$/;

/** The end of a line that holds its type. */
const TYPE_TAIL_BYTES = 96;

/**
 * The newest public state a segment holds:
 *
 * - `state`, with what is kept of it;
 * - `unread`: the newest record that sets the state is one this adapter does
 *   not read, or could not read. The session's status is not known;
 * - `none`: the whole segment was read and sets no state. The generation's
 *   state is the newest;
 * - `beyond`: none was found in what was read of a long segment. Not known.
 */
export type Newest =
  | { kind: "state"; envelope: Envelope }
  | { kind: "unread" }
  | { kind: "none" }
  | { kind: "beyond" };

/** A record's type, read from the end of its line. Null when the line does not end as a record does. */
export function recordTypeOf(line: Uint8Array): string | null {
  const bytes = Buffer.from(line.buffer, line.byteOffset, line.byteLength);
  const tail = bytes.toString("utf8", Math.max(0, bytes.byteLength - TYPE_TAIL_BYTES));
  return RECORD_TYPE.exec(tail)?.[1] ?? null;
}

/**
 * What one line says of the session's public state: a state, a state not
 * read, or null when the line sets none. `whole` is false for a line whose
 * start was not read: when the state does not begin in what was read, it may
 * begin before, and it is not known.
 */
export function readJournalLine(line: Uint8Array, whole = true): Newest | null {
  const type = recordTypeOf(line);
  if (type === "projection_advanced") return { kind: "unread" };
  if (type !== "projection_delta") return null;
  const bytes = Buffer.from(line.buffer, line.byteOffset, line.byteLength);
  const start = bytes.lastIndexOf(ENVELOPE_START);
  if (start === -1) return whole ? null : { kind: "beyond" };
  const from = start + ENVELOPE_START.byteLength;
  const end = bytes.lastIndexOf(ENVELOPE_END);
  if (end < from) return { kind: "unread" };
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8", from, end));
  } catch {
    return { kind: "unread" };
  }
  const envelope = envelopeOf(value);
  return envelope === null ? { kind: "unread" } : { kind: "state", envelope };
}

function bytesOf(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a segment that shrank while it was read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = bytesOf(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

interface Tail {
  newest: Newest;
  /** Where the complete lines end. Null when no line end was found within the limit. */
  end: number | null;
}

/**
 * Reads backwards from the end until a line sets the state, the start of the
 * segment is reached, or the limit has been read. The bytes after the last
 * newline are a line still being written, and are left alone.
 */
async function scanTail(file: OpenFile, size: number): Promise<Tail> {
  let position = size;
  let budget = TAIL_LIMIT_BYTES;
  /** The bytes from `position` to the first newline after it: not yet known to be a whole line. */
  let fragment: Buffer = Buffer.alloc(0);
  let end: number | null = null;

  while (position > 0 && budget > 0) {
    const length = Math.min(TAIL_CHUNK_BYTES, position, budget);
    const start = position - length;
    const chunk = await readExactly(file, start, length);
    budget -= length;
    position = start;
    const buffer = fragment.byteLength > 0 ? Buffer.concat([chunk, fragment]) : chunk;

    let cut = buffer.byteLength;
    if (end === null) {
      const last = buffer.lastIndexOf(NEWLINE);
      if (last === -1) {
        fragment = buffer;
        continue;
      }
      end = start + last + 1;
      cut = last;
    }

    let newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    while (newline !== -1) {
      const found = readJournalLine(buffer.subarray(newline + 1, cut));
      if (found !== null) return { newest: found, end };
      cut = newline;
      newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    }

    if (start === 0) {
      // The whole segment has been read: its first line is whole too.
      const found = cut > 0 ? readJournalLine(buffer.subarray(0, cut)) : null;
      return { newest: found ?? { kind: "none" }, end };
    }
    fragment = buffer.subarray(0, cut);
  }

  if (position === 0) {
    // The start was reached with no complete line at all.
    return { newest: { kind: "none" }, end: end ?? 0 };
  }
  // The limit was reached. The end of the line it stopped inside may still
  // hold the state, which comes last on a line.
  if (end !== null && fragment.byteLength > 0) {
    const found = readJournalLine(fragment, false);
    if (found !== null) return { newest: found, end };
  }
  return { newest: { kind: "beyond" }, end };
}

/** What is cached for one segment between polls. */
interface Cached {
  ino: number;
  size: number;
  mtimeMs: number;
  newest: Newest;
  /** Where the lines read so far end, always at a line's start. Null when not known. */
  offset: number | null;
}

export interface JournalReader {
  /**
   * The newest public state in a segment, read only as far as it grew since
   * the last call. `info` is what a `lstat` of it said this poll. Throws when
   * it cannot be read; the caller keeps what it had.
   */
  read(file: string, info: FileInfo): Promise<Newest>;
  /** Forgets every segment not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createJournalReader(io: ReadOnlyIo): JournalReader {
  const cache = new Map<string, Cached>();

  async function readFresh(file: string): Promise<Cached> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const tail = await scanTail(handle, info.size);
      return {
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        newest: tail.newest,
        offset: tail.end,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads only what was added since the last read. Returns null when the
   * segment has to be read afresh: it is another file, it shrank, it was
   * rewritten in place, or too much was added at once.
   */
  async function readOnward(file: string, cached: Cached, info: FileInfo): Promise<Cached | null> {
    const offset = cached.offset;
    if (offset === null) return null;
    if (info.ino !== cached.ino || info.size <= cached.size || info.size < offset) return null;
    if (info.size - offset > TAIL_LIMIT_BYTES) return null;

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      if (opened.ino !== cached.ino || opened.size < offset) return null;
      // It can have grown since the look: still no more than the limit is read.
      if (opened.size - offset > TAIL_LIMIT_BYTES) return null;
      // One byte more than the new lines, so the newline before them can be checked.
      // If it is not there, the segment was rewritten and the offset means nothing.
      const from = offset > 0 ? offset - 1 : 0;
      const read = await readExactly(handle, from, opened.size - from);
      if (offset > 0 && read[0] !== NEWLINE) return null;
      const added = offset > 0 ? read.subarray(1) : read;

      let newest = cached.newest;
      let start = 0;
      let newline = added.indexOf(NEWLINE);
      while (newline !== -1) {
        const found = readJournalLine(added.subarray(start, newline));
        if (found !== null) newest = found;
        start = newline + 1;
        newline = added.indexOf(NEWLINE, start);
      }
      return {
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        newest,
        offset: offset + start,
      };
    } finally {
      await handle.close();
    }
  }

  return {
    async read(file, info) {
      const cached = cache.get(file);
      if (
        cached &&
        cached.ino === info.ino &&
        cached.size === info.size &&
        cached.mtimeMs === info.mtimeMs
      ) {
        return cached.newest;
      }
      const next = (cached && (await readOnward(file, cached, info))) || (await readFresh(file));
      cache.set(file, next);
      return next.newest;
    },
    keepOnly(files) {
      for (const file of cache.keys()) {
        if (!files.has(file)) cache.delete(file);
      }
    },
  };
}
