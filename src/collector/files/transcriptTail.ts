import type { FileInfo, ReadOnlyIo } from "./readOnlyIo.ts";

/**
 * How the end of a session's transcript is read: a Claude Code transcript,
 * for what a waiting session is asking and what a session last said, and a
 * Codex session file, for what its session last said.
 *
 * The file is opened with the same care as a registry file: a link is not
 * followed and a pipe or a device is not read (`openRegularFile` in
 * `readOnlyIo.ts`). A transcript can run to many megabytes, so only its last
 * 256 KB are read, by position, and not again while the file is unchanged.
 */

/** The most of a transcript's end that is read, in bytes. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** What is known of a transcript when its end was last read, so it is not read again unchanged. */
export interface TranscriptStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

export type TailRead =
  /** The file is as it was. Nothing was read. */
  | { unchanged: true; stamp: TranscriptStamp }
  | {
      unchanged: false;
      stamp: TranscriptStamp;
      /** The end of the file, decoded. */
      tail: string;
      /** Whether that is the whole file, so its first line is whole too. */
      fromStart: boolean;
    };

function stampOf(info: FileInfo): TranscriptStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

function sameStamp(a: TranscriptStamp, b: TranscriptStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Reads the end of a transcript: at most its last 256 KB, by position. When
 * the file is as `known` says, by its size, its modified time and its identity
 * on disk, nothing is read.
 *
 * Rejects for a file that is not there, and for a link, a pipe, a device or a
 * folder, which `openRegular` will not open.
 */
export async function readTranscriptTail(
  file: string,
  io: Pick<ReadOnlyIo, "openRegular">,
  known: TranscriptStamp | null,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<TailRead> {
  const open = await io.openRegular(file);
  try {
    const stamp = stampOf(open.info);
    if (known !== null && sameStamp(known, stamp)) return { unchanged: true, stamp };
    const start = Math.max(0, stamp.size - maxBytes);
    const bytes = await open.read(start, stamp.size - start);
    // A letter cut in two at the start is in the first line, which is not read.
    return {
      unchanged: false,
      stamp,
      tail: new TextDecoder("utf-8").decode(bytes),
      fromStart: start === 0,
    };
  } finally {
    await open.close();
  }
}
