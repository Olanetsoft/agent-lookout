import path from "node:path";

import {
  applyUnrealAgentLine,
  copyUnrealAgentReplay,
  startUnrealAgentReplay,
  unrealAgentPhase,
  type UnrealAgentReplay,
} from "../../../core/mapping/unreal-agent/unrealAgentReplay.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { SessionFileRef } from "../pi/sessionFiles.ts";
import {
  folderOfShellLine,
  idOfFileName,
  LINE_END_KEEP_BYTES,
  LINE_KEEP_BYTES,
  readHeader,
  readLine,
  type KeptLine,
} from "./lines.ts";

/**
 * Reading an Unreal Agent session's file. Built from Unreal Agent's source at
 * v0.3.1 and not yet checked on a computer running it.
 *
 * Unreal Agent makes a session's file whole, with its first line, and renames
 * it into the sessions folder (store.go:386-411). After that it only adds to
 * it, one record a line, each with one write (413-433). So:
 *
 * - The first read takes the first line from the first `HEAD_BYTES`, and the
 *   lines in the last `FIRST_TAIL_BYTES`. Later reads take only what was
 *   added, up to `ONWARD_LIMIT_BYTES` at a time.
 * - Lines that do not reach the session's start can miss a command that
 *   still runs. So when they say the session waits, the whole file is read
 *   once, up to `FULL_READ_LIMIT_BYTES`, and only once for each time the file
 *   is read afresh, and not within `FULL_READ_MIN_INTERVAL_MS` of the last.
 * - Every append first cuts the file to the size its writer believes it has
 *   (store.go:423), so two programs that write one session cut each other's
 *   lines. A file that shrank, was replaced or was rewritten is read afresh.
 * - Bytes after the last newline are a line still being written, and are left
 *   until it ends (codec.go:88-94).
 * - Of a line longer than `LINE_KEEP_BYTES`, its first bytes and its last
 *   `LINE_END_KEEP_BYTES` are kept while it is read, and no more.
 * - Lines are applied only once every one was read, so a read that fails
 *   leaves what was known as it was.
 *
 * A file is opened without following a link, and only when its size, time or
 * identity changed, or a whole read is due. What is kept of it is its size,
 * time, identity, how far it was read, the replay of its lines and the folder.
 * No byte of a line is kept. Nothing here writes, renames, deletes or locks
 * anything.
 */

/** The most of a file's start read for its first line. */
export const HEAD_BYTES = 1024;

/** The most of a file's end read the first time. */
export const FIRST_TAIL_BYTES = 8 * 1024 * 1024;

/** The largest file read whole. */
export const FULL_READ_LIMIT_BYTES = 64 * 1024 * 1024;

/** The most read at once of what was added. More is read afresh. */
export const ONWARD_LIMIT_BYTES = 64 * 1024 * 1024;

/** How much is read at a time. */
export const PIECE_BYTES = 1024 * 1024;

/** The least time between two whole reads of one file. */
export const FULL_READ_MIN_INTERVAL_MS = 10 * 60 * 1000;

const NEWLINE = 0x0a;

/** What is kept of one session file. */
export interface UnrealAgentSessionFile {
  id: string;
  /** When Unreal Agent made the session, in epoch milliseconds. */
  createdAt: number;
  /** The folder of the newest shell command read, or null before one ran. */
  folder: string | null;
  replay: UnrealAgentReplay;
  /** Whether the file was too long to read whole when its lines did not reach its start. */
  tooLong: boolean;
}

export type UnrealAgentSessionRead =
  | { state: "ok"; file: UnrealAgentSessionFile }
  /** No first line yet, or no ordinary file at its name. */
  | { state: "none" }
  /** Not a session file this reads, or one whose first line names another session. */
  | { state: "broken" }
  /** Of a newer format than this reads. */
  | { state: "newer" };

const NONE: UnrealAgentSessionRead = { state: "none" };

interface Cached {
  info: FileInfo;
  read: UnrealAgentSessionRead;
  /** For a file that holds a session: where its first item begins and how far it was read. */
  reading?: {
    headerEnd: number;
    offset: number;
    fullReadDone: boolean;
    fullReadDue: boolean;
  };
}

export interface UnrealAgentSessionReader {
  /** What a session file says, given its `lstat` and the time, opened only when that changed or a whole read is due. */
  read(ref: SessionFileRef, now: number): Promise<UnrealAgentSessionRead>;
  /** Forgets every file not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function asBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a file that shrank while being read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = asBuffer(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

/** A line being gathered: its first bytes, up to the most kept, and its last ones. */
class LineGatherer {
  private parts: Buffer[] = [];
  private kept = 0;
  private cut = false;
  private last: Buffer = Buffer.alloc(0);

  add(part: Buffer) {
    if (part.byteLength === 0) return;
    const room = LINE_KEEP_BYTES - this.kept;
    if (part.byteLength <= room) {
      this.parts.push(part);
      this.kept += part.byteLength;
    } else {
      if (room > 0) this.parts.push(part.subarray(0, room));
      this.kept = LINE_KEEP_BYTES;
      this.cut = true;
    }
    this.last =
      part.byteLength >= LINE_END_KEEP_BYTES
        ? part.subarray(part.byteLength - LINE_END_KEEP_BYTES)
        : Buffer.concat([this.last, part]).subarray(-LINE_END_KEEP_BYTES);
  }

  take(): KeptLine {
    const head = this.parts.length === 1 ? (this.parts[0] as Buffer) : Buffer.concat(this.parts);
    const line: KeptLine = { head, end: Buffer.from(this.last), cut: this.cut };
    this.parts = [];
    this.kept = 0;
    this.cut = false;
    this.last = Buffer.alloc(0);
    return line;
  }
}

/**
 * Reads from `from` to `to` a piece at a time and hands over each line that
 * has its newline. With `dropFirst`, the bytes up to the first newline are
 * dropped: they end a line that began before. Returns where the lines handed
 * over end, the byte after the last newline, so what comes after is read
 * again next time, or 0 when no newline was found to drop to.
 */
async function eachLine(
  file: OpenFile,
  from: number,
  to: number,
  dropFirst: boolean,
  take: (line: KeptLine) => void,
): Promise<number> {
  const line = new LineGatherer();
  let dropping = dropFirst;
  let end = from;
  for (let position = from; position < to;) {
    const length = Math.min(PIECE_BYTES, to - position);
    const piece = await readExactly(file, position, length);
    let start = 0;
    for (;;) {
      const newline = piece.indexOf(NEWLINE, start);
      if (newline < 0) break;
      if (dropping) dropping = false;
      else {
        line.add(piece.subarray(start, newline));
        take(line.take());
      }
      start = newline + 1;
      end = position + start;
    }
    if (!dropping) line.add(piece.subarray(start));
    position += length;
  }
  // With no newline at all, nothing was read that ends where a line does.
  return dropping ? 0 : end;
}

/** One read's lines, applied to a replay, with the newest shell command's line kept until the read ends. */
interface Applied {
  replay: UnrealAgentReplay;
  end: number;
  /** The newest shell command's line read, and where its state begins. */
  shell: { head: Buffer; stateAt: number } | null;
}

/** The first item's number was not the one after the last read: the file was rewritten. */
class Rewritten extends Error {}

async function applyLines(
  file: OpenFile,
  replay: UnrealAgentReplay,
  from: number,
  to: number,
  dropFirst: boolean,
  expectSequence: number | null,
): Promise<Applied> {
  let shell: Applied["shell"] = null;
  let firstItem = true;
  const end = await eachLine(file, from, to, dropFirst, (kept) => {
    const line = readLine(kept);
    if (line.kind === "item" && firstItem) {
      firstItem = false;
      if (expectSequence !== null && line.sequence !== expectSequence) throw new Rewritten();
    }
    if (line.kind === "operation" && line.shellStateAt !== undefined) {
      shell = { head: kept.head, stateAt: line.shellStateAt };
    }
    applyUnrealAgentLine(replay, line);
  });
  return { replay, end, shell };
}

/** A reader of session files, which keeps what it read of each until it changes. */
export function createUnrealAgentSessionReader(
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): UnrealAgentSessionReader {
  const cache = new Map<string, Cached>();
  /** When each file was last read whole, kept while it is listed. */
  const fullReadAt = new Map<string, number>();

  function folderFrom(applied: Applied, before: string | null): string | null {
    if (applied.shell === null) return before;
    return folderOfShellLine(applied.shell.head, applied.shell.stateAt, platform) ?? before;
  }

  /** Whether a whole read of this file may be made now. A clock set back counts as time enough. */
  function fullReadAllowed(file: string, now: number): boolean {
    const last = fullReadAt.get(file);
    if (last === undefined) return true;
    const since = now - last;
    return since < 0 || since >= FULL_READ_MIN_INTERVAL_MS;
  }

  /**
   * Reads the file whole when its lines do not reach its start and say it
   * waits, as far as the budget allows: once for each time it is read
   * afresh, not within 10 minutes of the last, and only up to 64 MiB.
   */
  async function wholeIfNeeded(
    path: string,
    handle: OpenFile,
    cached: Cached & { read: { state: "ok" }; reading: NonNullable<Cached["reading"]> },
    now: number,
  ): Promise<Cached> {
    const { file } = cached.read;
    const { reading } = cached;
    if (file.replay.complete || unrealAgentPhase(file.replay).phase !== "unsure") {
      return { ...cached, reading: { ...reading, fullReadDue: false } };
    }
    if (handle.info.size > FULL_READ_LIMIT_BYTES) {
      return {
        ...cached,
        read: { state: "ok", file: { ...file, tooLong: true } },
        reading: { ...reading, fullReadDue: false },
      };
    }
    if (reading.fullReadDone) return cached;
    if (!fullReadAllowed(path, now))
      return { ...cached, reading: { ...reading, fullReadDue: true } };
    fullReadAt.set(path, now);
    const applied = await applyLines(
      handle,
      startUnrealAgentReplay(true),
      reading.headerEnd,
      handle.info.size,
      false,
      null,
    );
    return {
      info: cached.info,
      read: {
        state: "ok",
        file: { ...file, replay: applied.replay, folder: folderFrom(applied, file.folder) },
      },
      reading: { ...reading, offset: applied.end, fullReadDone: true, fullReadDue: false },
    };
  }

  async function fresh(ref: SessionFileRef, handle: OpenFile, now: number): Promise<Cached> {
    const info = handle.info;
    const head = await readExactly(handle, 0, Math.min(HEAD_BYTES, info.size));
    const newline = head.indexOf(NEWLINE);
    // Not listed until its first line is whole, and read again when it changes.
    if (newline < 0) return { info, read: NONE };
    const header = readHeader(head.subarray(0, newline));
    if (header.state === "newer") return { info, read: { state: "newer" } };
    // Unreal Agent reads only a file whose first line names the session of its name (store.go:292-298).
    if (header.state !== "ok" || header.id !== idOfFileName(path.basename(ref.path))) {
      return { info, read: { state: "broken" } };
    }
    const headerEnd = newline + 1;
    // The bytes up to the window's first newline are dropped: they end a line
    // that began before it. A window that reaches the first line's newline
    // holds every item.
    const windowStart = Math.max(headerEnd - 1, info.size - FIRST_TAIL_BYTES);
    const fromStart = windowStart === headerEnd - 1;
    const applied = await applyLines(
      handle,
      startUnrealAgentReplay(fromStart),
      windowStart,
      info.size,
      true,
      null,
    );
    const cached = {
      info,
      read: {
        state: "ok" as const,
        file: {
          id: header.id,
          createdAt: header.createdAt,
          folder: folderFrom(applied, null),
          replay: applied.replay,
          tooLong: false,
        },
      },
      reading: { headerEnd, offset: applied.end, fullReadDone: false, fullReadDue: false },
    };
    return wholeIfNeeded(ref.path, handle, cached, now);
  }

  /**
   * Reads only what was added, or null when the file has to be read afresh:
   * it is another file, did not grow, grew too much at once, or was rewritten,
   * as the byte before the added lines, or the number of the first item in
   * them, shows.
   */
  async function onward(
    ref: SessionFileRef,
    handle: OpenFile,
    known: Cached,
    now: number,
  ): Promise<Cached | null> {
    const { read, reading } = known;
    if (read.state !== "ok" || reading === undefined) return null;
    const opened = handle.info;
    if (opened.ino !== known.info.ino || opened.size <= known.info.size) return null;
    if (reading.offset < reading.headerEnd || opened.size - reading.offset > ONWARD_LIMIT_BYTES) {
      return null;
    }
    if ((await readExactly(handle, reading.offset - 1, 1))[0] !== NEWLINE) return null;
    const { file } = read;
    const replay = copyUnrealAgentReplay(file.replay);
    let applied: Applied;
    try {
      applied = await applyLines(
        handle,
        replay,
        reading.offset,
        opened.size,
        false,
        replay.lastSequence === null ? null : replay.lastSequence + 1,
      );
    } catch (error) {
      if (error instanceof Rewritten) return null;
      throw error;
    }
    const cached = {
      info: opened,
      read: {
        state: "ok" as const,
        file: { ...file, replay: applied.replay, folder: folderFrom(applied, file.folder) },
      },
      reading: { ...reading, offset: applied.end },
    };
    return wholeIfNeeded(ref.path, handle, cached, now);
  }

  async function readFile(ref: SessionFileRef, known: Cached | undefined, now: number) {
    const handle = await io.openRegular(ref.path);
    try {
      if (known !== undefined && sameFile(known.info, ref.info)) {
        // A whole read that was due, of a file that has not changed.
        if (
          known.read.state !== "ok" ||
          known.reading === undefined ||
          !sameFile(handle.info, known.info)
        ) {
          return known;
        }
        return await wholeIfNeeded(
          ref.path,
          handle,
          { ...known, read: known.read, reading: known.reading },
          now,
        );
      }
      return (
        (known !== undefined && (await onward(ref, handle, known, now))) ||
        (await fresh(ref, handle, now))
      );
    } finally {
      await handle.close();
    }
  }

  return {
    async read(ref, now) {
      const known = cache.get(ref.path);
      if (known && sameFile(known.info, ref.info)) {
        const due = known.reading?.fullReadDue === true && fullReadAllowed(ref.path, now);
        if (!due) return known.read;
      }
      try {
        const next = await readFile(ref, known, now);
        cache.set(ref.path, next);
        return next.read;
      } catch {
        // Gone since its `lstat`, or a read that failed: what was read of it
        // stands, and it is tried again on the next poll.
        return known?.read ?? NONE;
      }
    },
    keepOnly(paths) {
      for (const file of cache.keys()) if (!paths.has(file)) cache.delete(file);
      for (const file of fullReadAt.keys()) if (!paths.has(file)) fullReadAt.delete(file);
    },
  };
}
