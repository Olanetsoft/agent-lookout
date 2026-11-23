import {
  applyCopilotRecord,
  copyCopilotFold,
  startCopilotFold,
  type CopilotFold,
} from "../../../core/mapping/copilot-cli/copilotCliFold.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { judgeLine, LINE_MAX } from "./records.ts";

/**
 * Reading a Copilot CLI session's event log, `events.jsonl`, as bytes. Built
 * from GitHub's docs, the MIT Copilot SDK v2.0.1 and open-source readers,
 * never checked on a computer running Copilot CLI. See
 * docs/adapters/copilot-cli.md.
 *
 * Copilot appends one line for each event, and a resume appends to the same
 * file. With `COPILOT_SESSION_EVENT_LOG_ROTATION_BYTES` set, or when it
 * repairs a damaged log, it puts a new `events.jsonl` in place of the old
 * one, which starts again from a checkpoint. Its last line can be partial
 * while it is written. So:
 *
 * - The file is opened, read-only, without following a link at its name and
 *   without waiting on a pipe, only when its `lstat` size, modified time or
 *   identity changed, and only when the open file is the one that `lstat`
 *   found. Its write time is the later of the `lstat`'s and the open file's.
 * - The first time, and whenever it is replaced, shrinks, grows by more than
 *   `READ_CAP`, or does not go on from the last line break read, it is read
 *   from its start: all of it up to `READ_CAP`, and past that its first
 *   `HEAD_BYTES` and its last `READ_CAP`, with the lines between them taken
 *   as a gap (`copilotCliFold.ts`).
 * - After that, only the whole lines added are read, from where the last
 *   whole line ended. A partial last line is held back until it ends.
 *
 * At most one piece of `PIECE_BYTES` and one line's first `LINE_MAX` bytes
 * are held at once. Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a log read whole, and of its end read when it is longer. */
export const READ_CAP = 8 * 1024 * 1024;

/** The start of a log longer than `READ_CAP` read, for its `session.start`. */
export const HEAD_BYTES = 64 * 1024;

/** How much is read at a time. */
export const PIECE_BYTES = 256 * 1024;

const NEWLINE = 0x0a;

class Changed extends Error {}
class Replaced extends Error {}

async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = await file.read(position, length);
  if (data.byteLength !== length) throw new Changed("The file shrank while it was read.");
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Where the first line that begins at or after `from` begins, before `to`, or `to` when none does. */
async function lineStartFrom(file: OpenFile, from: number, to: number): Promise<number> {
  if (from === 0) return 0;
  if ((await readExactly(file, from - 1, 1))[0] === NEWLINE) return from;
  for (let at = from; at < to;) {
    const piece = await readExactly(file, at, Math.min(PIECE_BYTES, to - at));
    const newline = piece.indexOf(NEWLINE);
    if (newline >= 0) return at + newline + 1;
    at += piece.byteLength;
  }
  return to;
}

/**
 * Folds the whole lines from `from`, the start of a line, to `to`, a piece at
 * a time, onto `fold`, which it changes, holding one piece and one line's
 * first `LINE_MAX` bytes. Gives where the last whole line ended.
 */
async function foldLines(
  file: OpenFile,
  from: number,
  to: number,
  fold: CopilotFold,
  folderName: Buffer,
  platform: NodeJS.Platform,
): Promise<number> {
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
      const judged = judgeLine(
        head.subarray(0, held),
        lineEnd - lineStart <= LINE_MAX,
        folderName,
        platform,
      );
      if (judged.sort === "record") applyCopilotRecord(fold, judged.record);
      lineStart = lineEnd + 1;
      held = 0;
      cursor = newline + 1;
    }
    at += piece.byteLength;
  }
  return lineStart;
}

/** What is kept of a log between polls: no bytes. */
interface Known {
  /** The open file's size, time and identity as it was last read. */
  info: FileInfo;
  /** Just past the last whole line read. */
  offset: number;
  fold: CopilotFold;
}

/** Reads a log from its start, by the rule for a first read. */
async function readFromStart(
  file: OpenFile,
  size: number,
  folderName: Buffer,
  platform: NodeJS.Platform,
): Promise<{ offset: number; fold: CopilotFold }> {
  const fold = startCopilotFold();
  if (size <= READ_CAP) {
    return { offset: await foldLines(file, 0, size, fold, folderName, platform), fold };
  }
  const tailStart = await lineStartFrom(file, size - READ_CAP, size);
  const headEnd = await foldLines(
    file,
    0,
    Math.min(HEAD_BYTES, tailStart),
    fold,
    folderName,
    platform,
  );
  if (headEnd < tailStart) applyCopilotRecord(fold, { sort: "gap" });
  return { offset: await foldLines(file, tailStart, size, fold, folderName, platform), fold };
}

/** A session's log as a poll reads it. */
export interface CopilotLog {
  /** What it says, or null when it has never been read. */
  fold: CopilotFold | null;
  /** Its modified time as it was opened for this, never before its `lstat`'s, or the `lstat`'s when it was not opened. */
  writtenAt: number;
  /** False when the file changed since what it shows was read and could not be read again. */
  current: boolean;
}

/** A log as the poll's `lstat` found it. */
export interface LogRef {
  path: string;
  /** The session folder's name, which the session's own `session.start` names as its `sessionId`. */
  id: string;
  info: FileInfo;
}

export interface EventsReader {
  /** What a log says, given its `lstat`, opened only when that changed. */
  read(ref: LogRef): Promise<CopilotLog>;
  /** Forgets every log not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
  /** How many logs it keeps, for the tests that check none is kept once it has gone. */
  readonly kept: number;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** A reader of Copilot CLI's event logs, which keeps what it read of each until it changes. */
export function createEventsReader(io: ReadOnlyIo, platform: NodeJS.Platform): EventsReader {
  const remembered = new Map<string, Known>();

  async function readFile(ref: LogRef, known: Known | undefined): Promise<Known> {
    const file = await io.openRegular(ref.path);
    try {
      const { info } = file;
      // Another file than the one its `lstat` found: tried again next poll.
      if (info.kind !== "file" || info.ino !== ref.info.ino) throw new Replaced("Replaced.");
      const folderName = Buffer.from(ref.id);
      const goesOn =
        known !== undefined &&
        known.info.ino === info.ino &&
        info.size >= known.info.size &&
        info.size - known.offset <= READ_CAP &&
        (known.offset === 0 || (await readExactly(file, known.offset - 1, 1))[0] === NEWLINE);
      if (goesOn) {
        const fold = copyCopilotFold(known.fold);
        const offset = await foldLines(file, known.offset, info.size, fold, folderName, platform);
        return { info, offset, fold };
      }
      return { info, ...(await readFromStart(file, info.size, folderName, platform)) };
    } finally {
      await file.close().catch(() => {});
    }
  }

  return {
    async read(ref) {
      const known = remembered.get(ref.path);
      if (known !== undefined && sameFile(known.info, ref.info)) {
        return { fold: known.fold, writtenAt: ref.info.mtimeMs, current: true };
      }
      try {
        const next = await readFile(ref, known);
        remembered.set(ref.path, next);
        return {
          fold: next.fold,
          writtenAt: Math.max(ref.info.mtimeMs, next.info.mtimeMs),
          current: true,
        };
      } catch {
        // Gone since its `lstat`, replaced, refused, or a read error: what it
        // showed stands, and it is tried again on the next poll.
        return { fold: known?.fold ?? null, writtenAt: ref.info.mtimeMs, current: false };
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
