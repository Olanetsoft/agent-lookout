import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading a Kiro CLI log, a V3 `messages.jsonl` or a V2 `<uuid>.jsonl`, one
 * complete line at a time and always in file order. Built from Kiro's
 * documentation and open-source readers of its files, and not yet checked on a
 * computer running Kiro CLI.
 *
 * Each log is JSON Lines. A line is taken only once its newline is written: the
 * bytes after the last newline are a line still being written, and are left for
 * the next read. The first read goes back from the end, at most 8 MiB, to the
 * newest line that starts what the status needs (`floor`), and then takes the
 * lines from there to the end in file order. Later reads take only the lines
 * added since. A file that shrank, was replaced by another file, or was
 * rewritten so that the end last read no longer follows a newline, is read
 * afresh from its end: whether Kiro only appends to its V3 log is not settled.
 *
 * Only the files the adapter names are opened, without following a link, and
 * nothing is written, locked or deleted.
 */

/** The most of a log's end read on the first read, and the most read at once after it. */
export const TAIL_LIMIT_BYTES = 8 * 1024 * 1024;

/** A log is read back from its end in pieces of this size. */
const CHUNK_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

/** How one kind of log's lines are read, and what is kept of them. */
export interface LineReading<R, S> {
  /** What one line is, or null for a line that is blank. Never throws. */
  row(line: string): R | null;
  /** Whether a row is as far back as a read from the end needs to go: it and the rows after it are taken. */
  floor(row: R): boolean;
  /** What a read starts from: `whole` when it starts at the file's start. */
  start(whole: boolean): S;
  /** One row more, in file order. */
  fold(state: S, row: R): S;
}

/** What is kept of one log between polls. */
interface Kept<S> {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the complete lines read so far end. */
  offset: number;
  state: S;
}

function bytes(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a file that shrank while it was read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = bytes(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

/**
 * Reads back from the end, collecting rows newest first, until a floor row,
 * the file's start or the limit. Returns the state of the rows taken, in file
 * order, and where the complete lines end.
 */
async function readFromEnd<R, S>(
  file: OpenFile,
  size: number,
  reading: LineReading<R, S>,
): Promise<{ state: S; offset: number }> {
  let position = size;
  let budget = TAIL_LIMIT_BYTES;
  let fragment: Buffer = Buffer.alloc(0);
  let end: number | null = null;
  const rows: R[] = [];
  let floored = false;

  /** Takes one complete line, the newest first. True once the floor is reached. */
  const take = (line: string): boolean => {
    const row = reading.row(line);
    if (row === null) return false;
    rows.push(row);
    return reading.floor(row);
  };

  let whole = false;
  outer: while (position > 0 && budget > 0) {
    const length = Math.min(CHUNK_BYTES, position, budget);
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
      if (take(buffer.toString("utf8", newline + 1, cut))) {
        floored = true;
        break outer;
      }
      cut = newline;
      newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    }

    if (start === 0) {
      floored = take(buffer.toString("utf8", 0, cut));
      whole = true;
      break;
    }
    fragment = buffer.subarray(0, cut);
  }
  // The start was reached with no complete line at all.
  if (position === 0 && end === null) whole = true;

  let state = reading.start(whole && !floored);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    state = reading.fold(state, rows[index] as R);
  }
  return { state, offset: end ?? 0 };
}

export interface LineLog<S> {
  /**
   * What a log says, read only as far as it changed since the last call. `info`
   * is this poll's `lstat` of it. Throws when it cannot be read: the caller
   * then keeps nothing of it for this poll.
   */
  read(file: string, info: FileInfo): Promise<S>;
  /** Forgets every log not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

/** A reader of one kind of log, which keeps what it read of each file until it changes. */
export function createLineLog<R, S>(io: ReadOnlyIo, reading: LineReading<R, S>): LineLog<S> {
  const kept = new Map<string, Kept<S>>();

  async function readFresh(file: string): Promise<Kept<S>> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const { state, offset } = await readFromEnd(handle, info.size, reading);
      return { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, offset, state };
    } finally {
      await handle.close();
    }
  }

  /** Takes only the lines added since the last read, or null when the file must be read afresh. */
  async function readOnward(
    file: string,
    before: Kept<S>,
    info: FileInfo,
  ): Promise<Kept<S> | null> {
    const { offset } = before;
    if (info.ino !== before.ino || info.size <= before.size || info.size < offset) return null;
    if (info.size - offset > TAIL_LIMIT_BYTES) return null;

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      // A file that grew past the limit since its `lstat` is read afresh from its end.
      if (opened.ino !== before.ino || opened.size < offset) return null;
      if (opened.size - offset > TAIL_LIMIT_BYTES) return null;
      // One byte more than the new lines, so the newline before them can be
      // checked. Without it the file was rewritten and the offset means nothing.
      const from = offset > 0 ? offset - 1 : 0;
      const read = await readExactly(handle, from, opened.size - from);
      if (offset > 0 && read[0] !== NEWLINE) return null;
      const added = offset > 0 ? read.subarray(1) : read;

      let { state } = before;
      let start = 0;
      let newline = added.indexOf(NEWLINE);
      while (newline !== -1) {
        const row = reading.row(added.toString("utf8", start, newline));
        if (row !== null) state = reading.fold(state, row);
        start = newline + 1;
        newline = added.indexOf(NEWLINE, start);
      }
      return {
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        offset: offset + start,
        state,
      };
    } finally {
      await handle.close();
    }
  }

  return {
    async read(file, info) {
      const before = kept.get(file);
      if (
        before &&
        before.ino === info.ino &&
        before.size === info.size &&
        before.mtimeMs === info.mtimeMs
      ) {
        return before.state;
      }
      const next = (before && (await readOnward(file, before, info))) || (await readFresh(file));
      kept.set(file, next);
      return next.state;
    },
    keepOnly(files) {
      for (const file of kept.keys()) {
        if (!files.has(file)) kept.delete(file);
      }
    },
  };
}
