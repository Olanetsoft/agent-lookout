import path from "node:path";

import type { FxTail } from "../../../core/mapping/fx/fxMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { judgeLine, readFirstLine, type CountedLine } from "./logLines.ts";

/**
 * Reading the little this adapter needs from an fx session's log,
 * `<id>/log.jsonl`. Built from fx's source at v0.0.17 and not yet checked on a
 * computer running it.
 *
 * fx only adds to a log, a batch of whole lines at a time, at its end. It cuts
 * a line it never finished off the end when it next opens the log to write,
 * and it never rewrites or renames one (`log.zig`). So:
 *
 * - The first line is read once for each file, from its first
 *   `MAX_HEAD_BYTES`, for the session's id, folder, start time, whether it is
 *   a subagent's, and where a fork's copied lines end (`logLines.ts`).
 * - The first time, the end is read backwards, `PIECE_BYTES` at a time, at
 *   most `MAX_TAIL_BYTES` in all, from the newest whole line to the newest
 *   that decides the session's last turn: a turn's start or piece, or its end.
 * - After that, only what was added is read, in one read from the byte before
 *   it, and folded line by line. A file that shrank, was replaced, or does not
 *   go on from the last line read with the next `seq`, is read from its end
 *   again.
 * - A line counts only when fx's own reader would count it. A bad last line
 *   with nothing after it is one fx was writing, and is left until it is
 *   whole or cut. Any other bad line, a gap in `seq`, or a line of a kind or a
 *   shape fx 0.0.17 does not write, after the newest line that decides the
 *   last turn, makes the session's status unknown. Before that line, it is
 *   passed over.
 *
 * Nothing is kept of a read but numbers, a few short strings and flags: no
 * bytes. Each file is opened only when its size, modified time or identity
 * changes, without following a link. Nothing here writes, renames, deletes or
 * locks anything.
 */

/** The most of a log's start read for its first line, which holds one folder. */
export const MAX_HEAD_BYTES = 16 * 1024;

/** How much of a log's end is read at a time, going backwards: fx's own block size. */
export const PIECE_BYTES = 64 * 1024;

/** The most of a log's end read for its last turn, and the most read of what was added at once. */
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** Why a log's status is unknown, for the card's words. */
export type UnknownWhy = "unknown-end" | "newer" | "too-far";

/** What one log says. */
export interface FxLog {
  id: string;
  cwd: string | null;
  /** The first line's `ts`. */
  createdAt: number;
  tail: FxTail;
  /** Why `tail` is unknown, or null. */
  why: UnknownWhy | null;
  /**
   * The newest `ts` of the first line and of each line read since the
   * session's own lines began, past the lines a fork copied.
   */
  newestTs: number;
}

export type LogRead =
  | { state: "ok"; log: FxLog }
  /** A subagent's session, which is not listed. */
  | { state: "child" }
  /** No ordinary file, or one that went or changed as it was opened. */
  | { state: "none" }
  /** Not a session's log this reads. */
  | { state: "broken" }
  /** A first line of a newer format than this reads. */
  | { state: "newer" };

/** A log to read, with what an `lstat` of it said this poll. */
export interface LogRef {
  id: string;
  path: string;
  info: FileInfo;
}

/** What a log's first line gave. */
interface Head {
  id: string;
  cwd: string | null;
  createdAt: number;
  forkSeq: number;
  /** Where the first line ends, just past its newline. */
  line1End: number;
}

/**
 * The fold of a log's lines, from its newest backwards on a first read and
 * then forwards over what is added.
 */
interface Fold {
  /** The newest line that decides the last turn, or null when it was not found. */
  deciding: FxTail | null;
  /** Why the lines read since that one leave the status unknown, or null. */
  odd: UnknownWhy | null;
  /** Whether `closed` came after the deciding line. */
  closedSince: boolean;
  newestTs: number;
}

/** Where a read can go on from: just past the last line that counted, and its `seq`. */
interface Onward {
  offset: number;
  lastSeq: number;
}

interface Known {
  info: FileInfo;
  /** What the first line said, or why there is none to keep. */
  head: Head | "child" | "broken" | "newer";
  fold: Fold | null;
  onward: Onward | null;
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** A file that shrank while it was read, or was replaced as it was opened. */
class Changed extends Error {}

async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = await file.read(position, length);
  if (data.byteLength !== length) throw new Changed("The file shrank while it was read.");
  return asBuffer(data);
}

/** What a fold says. */
function resultOf(fold: Fold): { tail: FxTail; why: UnknownWhy | null } {
  if (fold.odd !== null) return { tail: { turn: "unknown" }, why: fold.odd };
  if (fold.deciding === null) return { tail: { turn: "none" }, why: null };
  if (fold.deciding.turn === "open" && fold.closedSince) {
    // fx closes an open turn before it writes `closed`, so this is not fx's.
    return { tail: { turn: "unknown" }, why: "unknown-end" };
  }
  return { tail: fold.deciding, why: null };
}

/** The deciding value of a line that decides, or null for one that does not. */
function decides(line: CountedLine): FxTail | null {
  if (line.sort === "open") return { turn: "open" };
  if (line.sort === "ended") return { turn: "ended", failed: line.failed, at: line.ts };
  return null;
}

const NEWLINE = 0x0a;

/**
 * The bytes of a log's end, read backwards a piece at a time into one buffer
 * that grows towards the start, never past `floor` and never more than
 * `MAX_TAIL_BYTES` in all.
 */
function backwardsReader(file: OpenFile, size: number, floor: number) {
  let memory = Buffer.alloc(0);
  /** Where the bytes held start, in the file: they run from here to `size`. */
  let start = size;
  return {
    get start() {
      return start;
    },
    /** The held bytes, and where in them the file's `position` is. */
    view(position: number): { data: Buffer; index: number } {
      return { data: memory, index: memory.byteLength - (size - position) };
    },
    /** Reads one more piece before what is held. False when none is left, or the budget is spent. */
    async more(): Promise<boolean> {
      const held = size - start;
      const want = Math.min(PIECE_BYTES, start - floor, MAX_TAIL_BYTES - held);
      if (want <= 0) return false;
      const piece = await readExactly(file, start - want, want);
      if (memory.byteLength < held + want) {
        const grown = Buffer.alloc(
          Math.min(MAX_TAIL_BYTES, Math.max(held + want, 2 * memory.byteLength)),
        );
        memory.copy(grown, grown.byteLength - held, memory.byteLength - held);
        memory = grown;
      }
      piece.copy(memory, memory.byteLength - held - want);
      start -= want;
      return true;
    },
    /** Whether the budget is spent with bytes still unread before what is held. */
    spent(): boolean {
      return start > floor && size - start >= MAX_TAIL_BYTES;
    },
  };
}

/**
 * The newest line that decides the last turn, and everything that is kept to
 * go on from, by reading a log's end backwards. A read past the budget, or
 * past a line that does not count, gives "unknown".
 */
async function readBackwards(
  file: OpenFile,
  size: number,
  head: Head,
): Promise<{ fold: Fold; onward: Onward | null }> {
  const floor = head.line1End;
  const tail = backwardsReader(file, size, floor);
  const fold: Fold = { deciding: null, odd: null, closedSince: false, newestTs: head.createdAt };
  let onward: Onward | null = null;

  // Bytes after the last newline are a line fx is writing, and are passed over.
  let end = -1;
  for (;;) {
    const { data, index } = tail.view(tail.start);
    const found = data.lastIndexOf(NEWLINE);
    if (found >= index && found >= 0) {
      end = tail.start + (found - index) + 1;
      break;
    }
    if (!(await tail.more())) break;
  }
  if (end < 0) {
    if (tail.spent()) fold.odd = "too-far";
    return { fold, onward: tail.spent() ? null : { offset: floor, lastSeq: 1 } };
  }

  const trailing = end < size;
  /** The `seq` of the line read before, which is the next one in the file. */
  let newerSeq: number | null = null;
  let newest = true;
  let sawClosed = false;
  for (;;) {
    if (end <= floor) {
      // Back at the first line. The line after it must be the second.
      if (newerSeq !== null && newerSeq !== 2) fold.odd = "unknown-end";
      onward ??= { offset: floor, lastSeq: 1 };
      break;
    }
    // The start of the line that ends at `end`: just past the newline before it.
    let lineStart = -1;
    for (;;) {
      const { data, index } = tail.view(tail.start);
      const before = end - 2 - tail.start;
      const found = before >= 0 ? data.lastIndexOf(NEWLINE, index + before) : -1;
      if (found >= index) {
        lineStart = tail.start + (found - index) + 1;
        break;
      }
      if (tail.start <= floor) {
        lineStart = floor;
        break;
      }
      if (!(await tail.more())) break;
    }
    if (lineStart < 0) {
      fold.odd = "too-far";
      break;
    }

    const { data, index } = tail.view(lineStart);
    const line = judgeLine(data, index, index + (end - lineStart));
    if (line === null) {
      if (newest && !trailing) {
        // A last line fx was writing, or will cut: it never counted.
        newest = false;
        end = lineStart;
        continue;
      }
      fold.odd = "unknown-end";
      break;
    }
    newest = false;
    onward ??= { offset: end, lastSeq: line.seq };
    if (line.sort === "newer") {
      if (line.seq > head.forkSeq) fold.newestTs = Math.max(fold.newestTs, line.ts);
      fold.odd = "newer";
      break;
    }
    if (newerSeq !== null && line.seq + 1 !== newerSeq) {
      fold.odd = "unknown-end";
      break;
    }
    newerSeq = line.seq;
    // A fork's lines up to here are the other session's, copied as they were.
    if (line.seq <= head.forkSeq) break;
    fold.newestTs = Math.max(fold.newestTs, line.ts);
    if (line.sort === "odd" || line.sort === "created") {
      fold.odd = "unknown-end";
      break;
    }
    if (line.sort === "closed") sawClosed = true;
    const deciding = decides(line);
    if (deciding !== null) {
      // fx closes an open turn before it writes `closed`, so this is not fx's.
      if (deciding.turn === "open" && sawClosed) fold.odd = "unknown-end";
      else fold.deciding = deciding;
      break;
    }
    end = lineStart;
  }
  return { fold, onward };
}

/**
 * Folds the lines added since `onward`, read in one read from the byte before
 * them. Null when the file does not go on from there, so it must be read from
 * its end again.
 */
async function readOnwards(
  file: OpenFile,
  size: number,
  head: Head,
  fold: Fold,
  onward: Onward,
): Promise<{ fold: Fold; onward: Onward | null } | null> {
  const from = onward.offset - 1;
  const data = await readExactly(file, from, size - from);
  if (data[0] !== NEWLINE) return null;
  const next: Fold = { ...fold };
  let goesOn: Onward | null = { ...onward };
  let expected: number | null = onward.lastSeq + 1;
  let first = true;
  let at = 1;
  for (;;) {
    const newline = data.indexOf(NEWLINE, at);
    if (newline < 0) break;
    const end = newline + 1;
    const line = judgeLine(data, at, end);
    if (line === null && end === data.byteLength) break;
    if (line !== null && first && line.seq !== expected) return null;
    first = false;
    at = end;
    if (line === null) {
      next.odd = "unknown-end";
      expected = null;
      goesOn = null;
      continue;
    }
    // A gap in `seq` is damage, which a later line that decides passes over,
    // as the backward read never looks behind the line that decides.
    if (expected !== null && line.seq !== expected) next.odd = "unknown-end";
    expected = line.seq + 1;
    goesOn = { offset: from + end, lastSeq: line.seq };
    if (line.seq <= head.forkSeq) continue;
    next.newestTs = Math.max(next.newestTs, line.ts);
    if (line.sort === "newer") next.odd = "newer";
    else if (line.sort === "odd" || line.sort === "created") next.odd = "unknown-end";
    else if (line.sort === "closed") next.closedSince = true;
    else {
      const deciding = decides(line);
      if (deciding !== null) {
        next.deciding = deciding;
        next.odd = null;
        next.closedSince = false;
      }
    }
  }
  return { fold: next, onward: goesOn };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function readOf(known: Known): LogRead {
  const { head, fold } = known;
  if (head === "child" || head === "broken" || head === "newer") return { state: head };
  if (fold === null) return { state: "none" };
  const { tail, why } = resultOf(fold);
  return {
    state: "ok",
    log: {
      id: head.id,
      cwd: head.cwd,
      createdAt: head.createdAt,
      tail,
      why,
      newestTs: fold.newestTs,
    },
  };
}

export interface LogReader {
  /** What a log says, given its `lstat`, opened only when that changed. */
  read(ref: LogRef): Promise<LogRead>;
  /** Whether this id was found to be a subagent's session, which is never read again. */
  isChild(id: string): boolean;
  /** Forgets every log whose session is not among these ids. */
  keepOnly(ids: ReadonlySet<string>): void;
}

/** A reader of fx's logs, which keeps what it read of each until it changes. */
export function createLogReader(io: ReadOnlyIo): LogReader {
  const remembered = new Map<string, Known>();
  /** The ids of subagents' sessions, kept as long as their folder is. */
  const children = new Set<string>();

  async function readHead(
    file: OpenFile,
    id: string,
  ): Promise<Head | "broken" | "newer" | "child"> {
    const length = Math.min(file.info.size, MAX_HEAD_BYTES);
    const data = await readExactly(file, 0, length);
    const newline = data.indexOf(NEWLINE);
    // Half written, or a first line too long to be one fx writes.
    if (newline < 0) return "broken";
    const first = readFirstLine(data, newline + 1, id);
    if (first === null) return "broken";
    if (first === "newer") return "newer";
    if (first.child) return "child";
    return {
      id: first.id,
      cwd: first.cwd,
      createdAt: first.ts,
      forkSeq: first.forkSeq,
      line1End: newline + 1,
    };
  }

  async function readFile(ref: LogRef, known: Known | undefined): Promise<Known> {
    const file = await io.openRegular(ref.path);
    try {
      const { info } = file;
      // Replaced between its `lstat` and its opening: looked at again on the next poll.
      if (info.ino !== ref.info.ino) throw new Changed("The file was replaced.");
      const reread =
        known === undefined ||
        known.info.ino !== info.ino ||
        typeof known.head !== "object" ||
        info.size < known.head.line1End;
      const head = reread || known === undefined ? await readHead(file, ref.id) : known.head;
      if (typeof head !== "object") return { info, head, fold: null, onward: null };
      const { size } = info;
      // What was read stands while the file only grew from the last line read.
      if (!reread && known?.fold && known.onward) {
        const { offset } = known.onward;
        if (size >= offset && size - offset <= MAX_TAIL_BYTES) {
          const onwards = await readOnwards(file, size, head, known.fold, known.onward);
          if (onwards !== null) return { info, head, ...onwards };
        }
      }
      return { info, head, ...(await readBackwards(file, size, head)) };
    } finally {
      await file.close();
    }
  }

  return {
    async read(ref) {
      const known = remembered.get(ref.path);
      if (known && sameFile(known.info, ref.info)) return readOf(known);
      // A first line never changes in a file fx only adds to.
      if (known && known.info.ino === ref.info.ino && typeof known.head !== "object") {
        return readOf(known);
      }
      try {
        const read = await readFile(ref, known);
        remembered.set(ref.path, read);
        if (read.head === "child") children.add(ref.id);
        return readOf(read);
      } catch {
        // Gone since its `lstat`, or a read error: what was read of it stands, and
        // it is tried again on the next poll, since nothing here took note of it.
        return known ? readOf(known) : { state: "none" };
      }
    },
    isChild: (id) => children.has(id),
    keepOnly(ids) {
      for (const [file, known] of remembered) {
        if (!ids.has(path.basename(path.dirname(file)))) {
          remembered.delete(file);
          if (known.head === "child") children.delete(path.basename(path.dirname(file)));
        }
      }
      for (const id of children) if (!ids.has(id)) children.delete(id);
    },
  };
}
