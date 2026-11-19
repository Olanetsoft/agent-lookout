import {
  applyMuseRecord,
  copyMuseFold,
  startMuseFold,
  type MuseFold,
} from "../../../core/mapping/muse-code/museCodeFold.ts";
import type { MuseView } from "../../../core/mapping/muse-code/museCodeMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { judgeHeadLine, judgeLine, LINE_MAX, type JudgedLine } from "./records.ts";

/**
 * Reading a Muse Code session's log, `session.jsonl`, as bytes. Built from
 * Meta's documentation, its MIT-licensed Muse Code SDK and protocol schema at
 * 1.4.24 and its cookbook, and from open-source readers of Muse Code's files,
 * and not yet checked on a computer running it. See docs/adapters/muse-code.md.
 *
 * Muse Code appends one line for each record of a session, and a resume
 * appends to the same file (`cb:audit/README.md`). Its last line can be
 * partial while it is written. So:
 *
 * - The file is opened, read-only, without following a link at its name and
 *   without waiting on a pipe, only when its `lstat` size, modified time or
 *   identity changed, and only when the open file is the one that `lstat`
 *   found. Its write time is the later of the `lstat`'s and the open file's.
 * - Its first `HEAD_BYTES` are read once for each identity, again whenever
 *   the file is read from its end again, and again on a change while the
 *   file is shorter and no metadata record was found, for the workspace
 *   folder and that record's time (`judgeHeadLine`).
 * - Two kinds of whole line decide where the status comes from: a `started`
 *   of a run on the session's own stream, the anchor, and a line that would
 *   decide and cannot be read. The newest of them in the file decides.
 * - The first time, the end is read backwards, `PIECE_BYTES` at a time, line
 *   by line from the last line break, looking through at most the last
 *   `REACH_BYTES` and the byte before them, to the newest of those lines.
 *   When it is an anchor, the lines from it to the last line break are read
 *   again onwards and folded (`museCodeFold.ts`).
 * - After that, while the file keeps its identity, is no shorter than when
 *   it was last read, grew by `REACH_BYTES` or less, and the byte before the
 *   end of the last whole line read is a line break, only the whole lines
 *   added are read and folded. Otherwise it is read from its end again.
 *
 * So what is kept is always what a first read of the same file gives. At most
 * one piece, one line's first `LINE_MAX` bytes and the first `HEAD_BYTES` are
 * held at once. Nothing here writes, renames, deletes or locks anything.
 */

/** The file's start read for its metadata record. */
export const HEAD_BYTES = 64 * 1024;

/** How much is read at a time, backwards or onwards. */
export const PIECE_BYTES = 256 * 1024;

/** The most of a file's end looked through, and of what was added read onwards. */
export const REACH_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/** The newest line that decides where the status comes from, and where it begins. */
export interface Mark {
  sort: "anchor" | "unreadable";
  start: number;
  /** For an unreadable line, whether its `schema_version` was a whole number above 1. */
  newer: boolean;
}

/** What is kept of a file's lines between polls: no bytes. */
export interface Tail {
  /** Just past the last whole line read, or null when no line break was found to go on from. */
  end: number | null;
  /** The newest mark, or null when none was found. */
  mark: Mark | null;
  /** The fold from the newest mark, when it is an anchor. */
  fold: MuseFold | null;
}

/** What a log shows: a view the mapping reads (`MuseView`), or none when it holds no turn. */
export type LogView =
  | Exclude<MuseView, { state: "unsure" }>
  | { state: "unsure"; why: "unreadable" | "newer" | "crowded" }
  | { state: "none" };

/**
 * What a kept tail says of a file of `size` bytes: too far when its newest
 * mark begins more than `REACH_BYTES` before the end, or there is none and
 * the file is longer than the reach, as its first line then begins more than
 * that before the end; none when there is none in a file no longer; unsure
 * when the newest mark is a line that cannot be read, or its fold holds too
 * many questions and approvals; else its fold.
 */
export function viewOf(tail: Tail, size: number): LogView {
  const { mark, fold } = tail;
  if (mark === null) return size > REACH_BYTES ? { state: "too-far" } : { state: "none" };
  if (mark.start < size - REACH_BYTES) return { state: "too-far" };
  if (mark.sort === "unreadable")
    return { state: "unsure", why: mark.newer ? "newer" : "unreadable" };
  if (fold === null || fold.crowded) return { state: "unsure", why: "crowded" };
  return { state: "ok", fold };
}

class Changed extends Error {}

async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = await file.read(position, length);
  if (data.byteLength !== length) throw new Changed("The file shrank while it was read.");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** The tail after one more judged line, beginning at `start`. It may change `tail.fold` in place. */
function foldLine(tail: Tail, judged: JudgedLine, start: number): Tail {
  if (judged.sort === "passed") return tail;
  if (judged.sort === "unreadable") {
    return { ...tail, mark: { sort: "unreadable", start, newer: judged.newer }, fold: null };
  }
  const { record } = judged;
  if (record.sort === "started") {
    return { ...tail, mark: { sort: "anchor", start, newer: false }, fold: startMuseFold(record) };
  }
  if (tail.mark?.sort !== "anchor" || tail.fold === null) return tail;
  return { ...tail, fold: applyMuseRecord(tail.fold, record) };
}

/**
 * Folds the whole lines from `from` to `to`, onwards, a piece at a time, onto
 * `tail`, holding one piece and one line's first `LINE_MAX` bytes. Its fold is
 * copied first, so the kept one stands if the read fails. `end` is just past
 * the last line break.
 */
async function foldOnwards(
  file: OpenFile,
  from: number,
  to: number,
  tail: Tail,
  folderName: Buffer,
): Promise<Tail> {
  let next: Tail = { ...tail, fold: tail.fold === null ? null : copyMuseFold(tail.fold) };
  const head = Buffer.alloc(Math.min(LINE_MAX, Math.max(0, to - from)));
  let held = 0;
  let lineStart = from;
  for (let at = from; at < to;) {
    const piece = await readExactly(file, at, Math.min(PIECE_BYTES, to - at));
    let cursor = 0;
    for (;;) {
      const newline = piece.indexOf(NEWLINE, cursor);
      const upTo = newline < 0 ? piece.byteLength : newline;
      const take = Math.min(upTo - cursor, head.byteLength - held);
      if (take > 0) {
        piece.copy(head, held, cursor, cursor + take);
        held += take;
      }
      if (newline < 0) break;
      const lineEnd = at + newline;
      const line = head.subarray(0, held);
      next = foldLine(
        next,
        judgeLine(line, lineEnd - lineStart <= LINE_MAX, folderName),
        lineStart,
      );
      lineStart = lineEnd + 1;
      held = 0;
      cursor = newline + 1;
    }
    at += piece.byteLength;
  }
  return { ...next, end: lineStart };
}

/**
 * Reads a file's end backwards, from its last line break to its newest mark,
 * then folds from that mark onwards when it is an anchor. It holds one piece
 * and one line's first `LINE_MAX` bytes at once.
 */
export async function readFromEnd(file: OpenFile, size: number, folderName: Buffer): Promise<Tail> {
  // The last bytes looked through, and the byte before them, so a line that
  // starts `REACH_BYTES` from the end is found whole, as reading onwards finds it.
  const floor = Math.max(0, size - REACH_BYTES - 1);
  const reach = size - REACH_BYTES;
  let piece: Buffer = Buffer.alloc(0);
  let pieceStart = size;

  async function earlier(): Promise<boolean> {
    const want = Math.min(PIECE_BYTES, pieceStart - floor);
    if (want <= 0) return false;
    // The piece in hand is let go before the next is read, so no two are held at once.
    piece = Buffer.alloc(0);
    piece = await readExactly(file, pieceStart - want, want);
    pieceStart -= want;
    return true;
  }

  /** The position of the newest line break before `before`, reading earlier as needed, or -1 when none is in reach. */
  async function newlineBefore(before: number): Promise<number> {
    let from = before - 1;
    for (;;) {
      if (from >= pieceStart && from < pieceStart + piece.byteLength) {
        const found = piece.lastIndexOf(NEWLINE, from - pieceStart);
        if (found >= 0) return pieceStart + found;
        from = pieceStart - 1;
      }
      if (from < floor || !(await earlier())) return -1;
    }
  }

  const last = await newlineBefore(size);
  // No whole line: an empty file, or one still being written, holds no mark.
  if (last < 0) return { end: floor === 0 ? 0 : null, mark: null, fold: null };
  const end = last + 1;
  let lineEnd = last;
  for (;;) {
    const before = await newlineBefore(lineEnd);
    const start = before >= 0 ? before + 1 : floor === 0 ? 0 : -1;
    // Before what is read: no mark in reach.
    if (start < 0 || start < reach) return { end, mark: null, fold: null };
    const length = lineEnd - start;
    const take = Math.min(LINE_MAX, length);
    // A line in the piece in hand is judged there; any other's first bytes are read alone.
    const inPiece = start >= pieceStart && start + take <= pieceStart + piece.byteLength;
    const line = inPiece
      ? piece.subarray(start - pieceStart, start - pieceStart + take)
      : await readExactly(file, start, take);
    const judged = judgeLine(line, length <= LINE_MAX, folderName);
    const marked = foldLine({ end, mark: null, fold: null }, judged, start);
    if (marked.mark?.sort === "unreadable") return { end, mark: marked.mark, fold: null };
    if (marked.mark?.sort === "anchor") {
      piece = Buffer.alloc(0);
      return foldOnwards(file, start, end, { end, mark: null, fold: null }, folderName);
    }
    if (start === 0) return { end, mark: null, fold: null };
    lineEnd = start - 1;
  }
}

/**
 * Folds what was added since `known` was read, or null when the file does not
 * go on from there: shorter, grown by more than `REACH_BYTES`, or with no line
 * break before what was added.
 */
export async function readOnwards(
  file: OpenFile,
  size: number,
  known: Tail,
  folderName: Buffer,
): Promise<Tail | null> {
  const { end } = known;
  if (end === null || size < end || size - end > REACH_BYTES) return null;
  if (end > 0 && (await readExactly(file, end - 1, 1))[0] !== NEWLINE) return null;
  return foldOnwards(file, end, size, known, folderName);
}

/** What the file's first bytes gave: its metadata record's folder and time, and how many bytes were read. */
interface Head {
  found: boolean;
  cwd: string | null;
  at: number | null;
  read: number;
}

/**
 * The metadata record in a file's first `HEAD_BYTES`: the first whole line
 * that `judgeHeadLine` takes. Nothing else of them is kept.
 */
async function headOf(
  file: OpenFile,
  size: number,
  folderName: Buffer,
  platform: NodeJS.Platform,
): Promise<Head> {
  const want = Math.min(HEAD_BYTES, size);
  const bytes = await readExactly(file, 0, want);
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(NEWLINE, start);
    if (newline < 0) break;
    const record = judgeHeadLine(bytes.subarray(start, newline), folderName, platform);
    if (record !== null) return { found: true, cwd: record.cwd, at: record.at, read: want };
    start = newline + 1;
  }
  return { found: false, cwd: null, at: null, read: want };
}

/** A session's log as a poll reads it. */
export interface MuseLog {
  view: LogView;
  /** Its modified time as it was opened for this, never before its `lstat`'s, or the `lstat`'s when it was not opened. */
  writtenAt: number;
  /**
   * The open file's identity, size and time its lines were read at, which can be later than its
   * `lstat`'s, or this poll's `lstat` when the file could not be read again after that changed.
   */
  info: FileInfo;
  /** The workspace folder its metadata record names, or null. */
  cwd: string | null;
  /** Its metadata record's time, or null. */
  metadataAt: number | null;
}

/** A log as the poll's `lstat` found it. */
export interface LogRef {
  path: string;
  /** The session folder's name, which the session's own records name as their stream's ID. */
  id: string;
  info: FileInfo;
}

interface Known {
  /** The open file's size, time and identity as it was last read. */
  info: FileInfo;
  head: Head;
  tail: Tail;
}

export interface MuseLogReader {
  /** What a log shows, given its `lstat`, opened only when that changed. */
  read(ref: LogRef): Promise<MuseLog>;
  /** Forgets every log not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
  /** How many logs it keeps, for the tests that check none is kept once it has gone. */
  readonly kept: number;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

class Replaced extends Error {}

/** A reader of Muse Code's session logs, which keeps what it read of each until it changes. */
export function createMuseLogReader(io: ReadOnlyIo, platform: NodeJS.Platform): MuseLogReader {
  const remembered = new Map<string, Known>();

  function answer(known: Known, writtenAt: number, info: FileInfo = known.info): MuseLog {
    return {
      view: viewOf(known.tail, known.info.size),
      writtenAt,
      info,
      cwd: known.head.cwd,
      metadataAt: known.head.at,
    };
  }

  async function readFile(ref: LogRef, known: Known | undefined): Promise<Known> {
    const file = await io.openRegular(ref.path);
    try {
      const { info } = file;
      // Another file than the one its `lstat` found, as when a link was put at its folder since: tried again next poll.
      if (info.kind !== "file" || info.ino !== ref.info.ino) throw new Replaced("Replaced.");
      const folderName = Buffer.from(ref.id);
      const same = known !== undefined && known.info.ino === info.ino;
      // A file shorter than when it was last read, even by a half-written line
      // cut off again, is read from its end: a first read of it may reach further back.
      const onwards =
        same && info.size >= known.info.size
          ? await readOnwards(file, info.size, known.tail, folderName)
          : null;
      const tail = onwards ?? (await readFromEnd(file, info.size, folderName));
      // The start is read again for a new file, one read from its end again, and one short of a metadata record.
      const head =
        same &&
        onwards !== null &&
        (known.head.found || known.head.read >= HEAD_BYTES || known.head.read >= info.size)
          ? known.head
          : await headOf(file, info.size, folderName, platform);
      return { info, head, tail };
    } finally {
      await file.close().catch(() => {});
    }
  }

  return {
    async read(ref) {
      const known = remembered.get(ref.path);
      if (known !== undefined && sameFile(known.info, ref.info)) {
        return answer(known, ref.info.mtimeMs);
      }
      try {
        const next = await readFile(ref, known);
        remembered.set(ref.path, next);
        return answer(next, Math.max(ref.info.mtimeMs, next.info.mtimeMs));
      } catch {
        // Gone since its `lstat`, replaced, refused, or a read error: what it
        // showed stands, and it is tried again on the next poll.
        if (known === undefined) {
          return {
            view: { state: "none" },
            writtenAt: ref.info.mtimeMs,
            info: ref.info,
            cwd: null,
            metadataAt: null,
          };
        }
        // This poll's `lstat` stands for what was read, so a write since an answer is never taken for one read before it.
        return answer(known, ref.info.mtimeMs, ref.info);
      }
    },
    keepOnly(paths) {
      for (const file of remembered.keys()) if (!paths.has(file)) remembered.delete(file);
    },
    get kept() {
      return remembered.size;
    },
  };
}
