import {
  applyDeepseekHarnessLine,
  copyDeepseekHarnessTurn,
  startDeepseekHarnessTurn,
  type DeepseekHarnessTurn,
} from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import {
  isTitleLine,
  LINE_HEAD_BYTES,
  readEvent,
  readHeader,
  TITLE_LINE_MAX,
  type DeepseekHarnessHeader,
} from "./lines.ts";
import type { LogRef } from "./logFiles.ts";
import {
  frameAt,
  FRAME_TEXT_MAX,
  isTooLarge,
  startsFrame,
  type ZstdDecoder,
} from "./zstdFrames.ts";

/**
 * Reading a DeepSeek Harness log. Built from DeepSeek Harness's source at
 * dsh-v0.2.2-rc.3 and not yet checked on a computer running it.
 *
 * DeepSeek Harness makes a log whole, with its first line, in a temporary
 * file (session-persistence-jsonl/src/index.ts:1361-1371), and publishes it by
 * a link (:1298-1305, a move on Windows, :1339-1341). After that it only adds
 * to it, a batch of lines at a time, in one frame when it is compressed
 * (:1385-1394, :1414-1440). It cuts the log back when an append fails
 * (:1442-1451) and when it repairs a torn end (:1454-1462), and a migration
 * publishes a new file (generation.ts:817-834). So:
 *
 * - A log's first line is read once for each file, and again only when the
 *   log is read from its start: at most `HEADER_MAX_BYTES`,
 *   `HEADER_FIRST_BYTES` first. Nothing else of a subagent's log whose session
 *   is not shown is read.
 * - For a session shown, and its subagents', the log is then read on from
 *   there, and after that only what was added. A log longer than
 *   `READ_MAX_COMPRESSED` compressed, or `READ_MAX_PLAIN` not, is not read past
 *   its first line, so what is shown never depends on when it was read.
 * - It is read from its start again when it is another file, grew shorter,
 *   or did not go on as it was written: the byte before what was added is
 *   not a newline, what was added does not begin a frame, or a line's number
 *   is not the one after the last. When that happens again on the read from
 *   its start, or a frame is not one DeepSeek Harness writes or cannot be
 *   undone, the log is stuck until it is another file or grows shorter.
 * - A last line or frame still being written is left, and read once it is
 *   whole: DeepSeek Harness's repair cuts the log back to exactly there.
 * - A compressed frame is undone alone, at most `FRAME_TEXT_MAX` of it. One
 *   that would give more is passed over, and the session's turn is not known
 *   until the next begins or ends. What comes out of a frame is whole lines,
 *   or nothing, as at the end of a stream (generation.ts:747-765).
 *
 * One log is read at a time, and one frame at a time. A file is opened
 * without following a link, read-only, and only when its size, time or
 * identity changed, and is read only when it is the file this poll's `lstat`
 * found. What is kept of it is its identity, size and time, where its first
 * line ends and how far it was read, the next line's number, the header, the
 * turn's state and a title of at most 1 KiB. No byte of it is kept. Nothing
 * here writes, renames, deletes or locks anything.
 */

/** The first read of a log's start, for its first line. */
export const HEADER_FIRST_BYTES = 4 * 1024;

/** The most of a log's start read for its first line. A longer first line leaves the session out. */
export const HEADER_MAX_BYTES = 64 * 1024;

/** The longest compressed log read past its first line. */
export const READ_MAX_COMPRESSED = 16 * 1024 * 1024;

/** The longest uncompressed log read past its first line. */
export const READ_MAX_PLAIN = 64 * 1024 * 1024;

/** How much of an uncompressed log is read at a time. */
export const PIECE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/** What a log says. */
export interface DeepseekHarnessLog {
  header: DeepseekHarnessHeader;
  turn: DeepseekHarnessTurn;
  /** The newest title of its own, or null. Never read for a subagent's log. */
  title: string | null;
  /**
   * `ok` once read on; `too-long` past the most read; `stuck` when it did not
   * go on as DeepSeek Harness writes; `unread` when only its first line was read.
   */
  mark: "ok" | "too-long" | "stuck" | "unread";
  /** The log's modified time as it was opened for what was read. */
  writtenAt: number;
}

/** What a look at a log's first line gave. */
export type HeaderRead =
  | { state: "ok"; header: DeepseekHarnessHeader }
  /** Not whole yet: looked at again on the next poll. */
  | { state: "later" }
  /** Not a header DeepSeek Harness would read: the session is not shown. */
  | { state: "bad" };

interface Cached {
  /** What the file was as last read: its identity, size and time. */
  info: FileInfo;
  header: DeepseekHarnessHeader | null;
  headerEnd: number;
  /** How far it was read, or null when only its first line was. */
  readTo: number | null;
  /** The next line's number, or null to take the next line's as it is. */
  nextSeq: number | null;
  turn: DeepseekHarnessTurn;
  title: string | null;
  titles: boolean;
  mark: DeepseekHarnessLog["mark"];
  writtenAt: number;
}

export interface DeepseekHarnessLogReader {
  /** Whether a log's first line still has to be looked at: a log not seen before, another file, or one grown shorter than was read. */
  needsHeader(ref: LogRef): boolean;
  /** A log's first line, looked at once for each file, and again when it grew shorter than was read. */
  header(ref: LogRef, now: number): Promise<HeaderRead>;
  /**
   * A log read on past its first line, opened only when it changed, or null
   * when its first line is not known or is not a header. With `titles`, its
   * own titles are read too.
   */
  readOn(ref: LogRef, titles: boolean, now: number): Promise<DeepseekHarnessLog | null>;
  /** What was last known of a log, for one a newer format has since been written beside. */
  last(path: string): DeepseekHarnessLog | null;
  /** Forgets every log not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a file that shrank while it was read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = asBuffer(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

/** The log went on in a way DeepSeek Harness does not write it: read it from its start. */
class Reread extends Error {}

/** The log is not one this can read on: stuck until it is another file or grows shorter. */
class Stuck extends Error {}

/** A line of an uncompressed log being gathered: its first bytes, and its length. */
class LineGatherer {
  private parts: Buffer[] = [];
  private kept = 0;
  private limit = LINE_HEAD_BYTES;
  private decided = false;
  length = 0;

  constructor(private readonly titles: boolean) {}

  add(part: Buffer) {
    this.length += part.byteLength;
    let rest = part;
    while (rest.byteLength > 0 && this.kept < this.limit) {
      const taken = rest.subarray(0, this.limit - this.kept);
      this.parts.push(taken);
      this.kept += taken.byteLength;
      rest = rest.subarray(taken.byteLength);
      // Once its first bytes are in, a title line of a session shown is kept up to its most, from this part too.
      if (!this.decided && this.kept >= LINE_HEAD_BYTES) this.decide();
    }
  }

  private decide() {
    this.decided = true;
    if (this.titles && isTitleLine(this.head())) {
      this.limit = TITLE_LINE_MAX;
    }
  }

  head(): Buffer {
    return this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
  }

  take(): { line: Buffer; length: number } {
    const line = { line: this.head(), length: this.length };
    this.parts = [];
    this.kept = 0;
    this.length = 0;
    this.limit = LINE_HEAD_BYTES;
    this.decided = false;
    return line;
  }
}

/** A read in progress, applied to copies, so a read that fails leaves what was known. */
interface Reading {
  turn: DeepseekHarnessTurn;
  title: string | null;
  nextSeq: number | null;
}

export function createDeepseekHarnessLogReader(
  io: ReadOnlyIo,
  zstd: ZstdDecoder | null,
  platform: NodeJS.Platform,
): DeepseekHarnessLogReader {
  const cache = new Map<string, Cached>();

  function logOf(cached: Cached): DeepseekHarnessLog | null {
    if (cached.header === null) return null;
    return {
      header: cached.header,
      turn: cached.turn,
      title: cached.title,
      mark: cached.mark,
      writtenAt: cached.writtenAt,
    };
  }

  /** Whether the file at a path is still the one cached, and has not grown shorter than was read. */
  function stillOf(cached: Cached | undefined, info: FileInfo): cached is Cached {
    return (
      cached !== undefined &&
      cached.info.ino === info.ino &&
      info.size >= (cached.readTo ?? cached.headerEnd)
    );
  }

  /** The first line of a log, from its open file, as bytes and where it ends; or why there is none. */
  async function firstLine(
    handle: OpenFile,
    compressed: boolean,
  ): Promise<{ line: Uint8Array; end: number } | "later" | "bad"> {
    const size = handle.info.size;
    let length = Math.min(size, HEADER_FIRST_BYTES);
    for (;;) {
      const start = await readExactly(handle, 0, length);
      if (!compressed) {
        const newline = start.indexOf(NEWLINE);
        if (newline >= 0) return { line: start.subarray(0, newline), end: newline + 1 };
      } else {
        const at = frameAt(start, 0);
        if (at.kind === "foreign" || zstd === null) return "bad";
        if (at.kind === "frame") {
          let text: Buffer;
          try {
            text = await zstd.frame(start.subarray(0, at.end), HEADER_MAX_BYTES);
          } catch {
            return "bad";
          }
          // The first frame is exactly the first line (index.ts:78-82).
          if (text.byteLength === 0 || text.indexOf(NEWLINE) !== text.byteLength - 1) return "bad";
          return { line: text.subarray(0, -1), end: at.end };
        }
      }
      if (length >= Math.min(size, HEADER_MAX_BYTES)) {
        return size > HEADER_MAX_BYTES ? "bad" : "later";
      }
      length = Math.min(size, HEADER_MAX_BYTES);
    }
  }

  async function probe(ref: LogRef, handle: OpenFile, now: number): Promise<Cached | "later"> {
    const info = handle.info;
    const found = await firstLine(handle, ref.zstd);
    if (found === "later") return "later";
    const header = found === "bad" ? null : readHeader(found.line, now, platform);
    return {
      info,
      header,
      headerEnd: found === "bad" ? 0 : found.end,
      readTo: null,
      nextSeq: 0,
      turn: startDeepseekHarnessTurn(header?.createdAt ?? null),
      title: null,
      titles: false,
      mark: "unread",
      writtenAt: info.mtimeMs,
    };
  }

  /** Applies one line to a read in progress. */
  function take(
    reading: Reading,
    header: DeepseekHarnessHeader,
    line: Uint8Array,
    length: number,
    titles: boolean,
    now: number,
  ) {
    const event = readEvent(line, length, now, titles);
    if (event.seq !== null) {
      // DeepSeek Harness numbers lines from 0 with no gap (core/session/src/index.ts:790-792).
      if (reading.nextSeq !== null && event.seq !== reading.nextSeq) throw new Reread();
      reading.nextSeq = event.seq + 1;
    } else if (reading.nextSeq !== null) {
      reading.nextSeq += 1;
    }
    reading.turn = applyDeepseekHarnessLine(reading.turn, event.line, header.createdAt);
    if (event.title !== undefined) reading.title = event.title;
  }

  /** Reads compressed frames from `from` to the end, and gives where the last whole one ends. */
  async function framesFrom(
    handle: OpenFile,
    from: number,
    reading: Reading,
    header: DeepseekHarnessHeader,
    titles: boolean,
    now: number,
  ): Promise<number> {
    if (zstd === null) throw new Stuck();
    const size = handle.info.size;
    if (size <= from) return from;
    const data = await readExactly(handle, from, size - from);
    let at = 0;
    while (at < data.byteLength) {
      const frame = frameAt(data, at);
      if (frame.kind === "torn") break;
      if (frame.kind === "foreign") throw new Stuck();
      let text: Buffer | null = null;
      if (frame.contentSize === null || frame.contentSize <= FRAME_TEXT_MAX) {
        try {
          text = await zstd.frame(data.subarray(at, frame.end), FRAME_TEXT_MAX);
        } catch (error) {
          if (!isTooLarge(error)) throw new Stuck();
        }
      }
      if (text === null) {
        // Passed over: the turn is not known until the next begins or ends, and the next line's number is taken.
        reading.turn = { state: "unsure" };
        reading.nextSeq = null;
      } else {
        // An empty frame holds no line: Node.js's stream ends with one, as a migration writes it.
        if (text.byteLength > 0 && text[text.byteLength - 1] !== NEWLINE) throw new Stuck();
        let start = 0;
        while (start < text.byteLength) {
          const end = text.indexOf(NEWLINE, start);
          const length = end - start;
          const head = text.subarray(start, start + Math.min(length, LINE_HEAD_BYTES));
          const line =
            titles && isTitleLine(head)
              ? text.subarray(start, start + Math.min(length, TITLE_LINE_MAX))
              : head;
          take(reading, header, line, length, titles, now);
          start = end + 1;
        }
      }
      at = frame.end;
    }
    return from + at;
  }

  /** Reads uncompressed lines from `from`, the byte after a newline, and gives where the last whole one ends. */
  async function linesFrom(
    handle: OpenFile,
    from: number,
    reading: Reading,
    header: DeepseekHarnessHeader,
    titles: boolean,
    now: number,
  ): Promise<number> {
    const size = handle.info.size;
    if ((await readExactly(handle, from - 1, 1))[0] !== NEWLINE) throw new Reread();
    const gatherer = new LineGatherer(titles);
    let end = from;
    for (let position = from; position < size;) {
      const length = Math.min(PIECE_BYTES, size - position);
      const piece = await readExactly(handle, position, length);
      let start = 0;
      for (;;) {
        const newline = piece.indexOf(NEWLINE, start);
        if (newline < 0) break;
        gatherer.add(piece.subarray(start, newline));
        const line = gatherer.take();
        take(reading, header, line.line, line.length, titles, now);
        start = newline + 1;
        end = position + start;
      }
      gatherer.add(piece.subarray(start));
      position += length;
    }
    return end;
  }

  /** Reads on from where `cached` stands, into copies; throws `Reread` or `Stuck`. */
  async function readFrom(
    handle: OpenFile,
    cached: Cached & { header: DeepseekHarnessHeader },
    from: number,
    titles: boolean,
    now: number,
    compressed: boolean,
  ): Promise<Cached> {
    const reading: Reading = {
      turn: copyDeepseekHarnessTurn(cached.turn),
      title: cached.title,
      nextSeq: cached.nextSeq,
    };
    if (
      compressed &&
      handle.info.size > from &&
      !startsFrame(await readExactly(handle, from, 4), 0)
    ) {
      throw new Reread();
    }
    const readTo = compressed
      ? await framesFrom(handle, from, reading, cached.header, titles, now)
      : await linesFrom(handle, from, reading, cached.header, titles, now);
    return {
      ...cached,
      info: handle.info,
      readTo,
      nextSeq: reading.nextSeq,
      turn: reading.turn,
      title: reading.title,
      titles,
      mark: "ok",
      writtenAt: handle.info.mtimeMs,
    };
  }

  /** A log read from its start: its first line, then on. */
  async function fromStart(
    ref: LogRef,
    handle: OpenFile,
    titles: boolean,
    now: number,
  ): Promise<Cached | "later"> {
    const probed = await probe(ref, handle, now);
    if (probed === "later" || probed.header === null) return probed;
    const header = probed.header;
    const limit = ref.zstd ? READ_MAX_COMPRESSED : READ_MAX_PLAIN;
    if (handle.info.size > limit) return { ...probed, titles, mark: "too-long" };
    try {
      return await readFrom(handle, { ...probed, header }, probed.headerEnd, titles, now, ref.zstd);
    } catch (error) {
      if (error instanceof Reread || error instanceof Stuck) {
        return { ...probed, readTo: probed.headerEnd, titles, mark: "stuck" };
      }
      throw error;
    }
  }

  async function readOnce(
    ref: LogRef,
    known: Cached,
    titles: boolean,
    now: number,
  ): Promise<Cached | "later"> {
    const handle = await io.openRegular(ref.path);
    try {
      const opened = handle.info;
      // Not the file this poll's lstat found, as through a link put at a folder's name since: what was read stands until the next poll.
      if (opened.ino !== ref.info.ino) throw new Error("The file was replaced.");
      // Another file than was read, or shorter than was read: from its start.
      if (!stillOf(known, opened) || known.header === null)
        return await fromStart(ref, handle, titles, now);
      const header = known.header;
      // Too long or stuck: what a read from its start keeps, its first line alone, nothing of earlier reads.
      const settledAs = (mark: "too-long" | "stuck"): Cached => ({
        ...known,
        info: opened,
        readTo: mark === "stuck" ? known.headerEnd : null,
        nextSeq: 0,
        turn: startDeepseekHarnessTurn(header.createdAt),
        title: null,
        titles,
        mark,
        writtenAt: opened.mtimeMs,
      });
      const limit = ref.zstd ? READ_MAX_COMPRESSED : READ_MAX_PLAIN;
      if (opened.size > limit) return settledAs("too-long");
      const stuck = () => settledAs("stuck");
      // Read only for its first line, or for a subagent's turns and now for a session's titles: from its first line on.
      if (known.readTo === null || (titles && !known.titles)) {
        const start: Cached & { header: DeepseekHarnessHeader } = {
          ...known,
          header,
          readTo: null,
          nextSeq: 0,
          turn: startDeepseekHarnessTurn(header.createdAt),
          title: null,
        };
        try {
          return await readFrom(handle, start, known.headerEnd, titles, now, ref.zstd);
        } catch (error) {
          if (error instanceof Reread || error instanceof Stuck) return stuck();
          throw error;
        }
      }
      try {
        return await readFrom(handle, { ...known, header }, known.readTo, titles, now, ref.zstd);
      } catch (error) {
        if (error instanceof Stuck) return stuck();
        if (error instanceof Reread) return await fromStart(ref, handle, titles, now);
        throw error;
      }
    } finally {
      await handle.close();
    }
  }

  return {
    needsHeader(ref) {
      return !stillOf(cache.get(ref.path), ref.info);
    },

    async header(ref, now) {
      const known = cache.get(ref.path);
      if (stillOf(known, ref.info)) {
        return known.header === null ? { state: "bad" } : { state: "ok", header: known.header };
      }
      try {
        const handle = await io.openRegular(ref.path);
        try {
          // Not the file this poll's lstat found, as through a link put at a folder's name since: looked at again on the next poll.
          if (handle.info.ino !== ref.info.ino) throw new Error("The file was replaced.");
          const probed = await probe(ref, handle, now);
          if (probed === "later") {
            cache.delete(ref.path);
            return { state: "later" };
          }
          cache.set(ref.path, probed);
          return probed.header === null ? { state: "bad" } : { state: "ok", header: probed.header };
        } finally {
          await handle.close();
        }
      } catch {
        // Gone or replaced since its lstat, or a read that failed: tried again on the next poll.
        cache.delete(ref.path);
        return { state: "later" };
      }
    },

    async readOn(ref, titles, now) {
      const known = cache.get(ref.path);
      if (known === undefined || known.header === null) return null;
      const info = ref.info;
      const unchanged =
        known.info.ino === info.ino &&
        known.info.size === info.size &&
        known.info.mtimeMs === info.mtimeMs &&
        known.mark !== "unread" &&
        (!titles || known.titles);
      // Stuck, or too long, until it is another file or grows shorter.
      const settled =
        (known.mark === "stuck" || known.mark === "too-long") &&
        known.info.ino === info.ino &&
        info.size >= known.info.size;
      if (unchanged || settled) return logOf(known);
      try {
        const next = await readOnce(ref, known, titles, now);
        if (next === "later") {
          cache.delete(ref.path);
          return null;
        }
        cache.set(ref.path, next);
        return logOf(next);
      } catch {
        // Gone or replaced since its lstat, or a read that failed: what was read of it stands.
        return logOf(known);
      }
    },

    last(path) {
      const known = cache.get(path);
      return known === undefined ? null : logOf(known);
    },

    keepOnly(paths) {
      for (const file of cache.keys()) if (!paths.has(file)) cache.delete(file);
    },
  };
}
