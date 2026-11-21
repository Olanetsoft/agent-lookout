import { constants, type BigIntStats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";

import { openWithoutFollowing } from "./noFollow.ts";

/** What is at a path, without its contents. */
export interface FileInfo {
  /** `file` for an ordinary file, `directory`, or `other` for a link, a pipe, a device or a socket. */
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  /** The file's identity on its disk, so a file replaced under the same name is noticed: `inoOf`. */
  ino: number;
  /**
   * The user who owns it, its permission bits and how many names it has, as
   * the system gives them. Only the Autohand Code adapter asks, to read only
   * what Autohand Code itself would. On Windows the first two mean little. A
   * stand-in may leave them out.
   */
  uid?: number;
  mode?: number;
  nlink?: number;
}

/** An ordinary file, open to read. */
export interface OpenFile {
  /** Taken from the open file, not from its name, so nothing can be swapped in between. */
  info: FileInfo;
  /** Up to `length` bytes from `position`. Fewer when the file ends first. */
  read(position: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Everything Agent Lookout does to the file system where another program keeps
 * its files: the Codex adapter in `~/.codex`, the Gemini CLI adapter in
 * `~/.gemini/tmp` and, on a Mac, `~/.cache/.gemini/tmp`, the status-file
 * adapter in the folder of status files, and the branch finder in each
 * session's repository.
 * Every method reads: there is none that writes, creates, renames, locks or
 * deletes. Tests replace it with a stand-in that counts the calls.
 */
export interface ReadOnlyIo {
  /** The names in a folder. Rejects, with the error's `code`, when it cannot list it. */
  readdir(dir: string): Promise<string[]>;
  /** Follows a link. Used for the Codex folder itself, which may be one. */
  stat(target: string): Promise<FileInfo>;
  /** Does not follow a link. Used to see whether a session file changed before reading it. */
  lstat(target: string): Promise<FileInfo>;
  /** Opens an ordinary file to read. Rejects for a link, a pipe, a device or a folder. */
  openRegular(file: string): Promise<OpenFile>;
  /**
   * The path with every link followed and each name in the case the disk
   * gives it, asked of the system, which reads nothing in the folder. Used for
   * the case of a Gemini CLI project's folder on Windows. A stand-in may leave it out.
   */
  realpath?(target: string): Promise<string>;
}

/**
 * A file's ID on its disk as a number. Node's ordinary stats give it as a
 * number, which keeps only 53 bits, and an NTFS file ID often has more, so two
 * files could get the same one (nodejs/node#12115). It is read whole, as a
 * bigint, and the bits above the 53 are folded into the rest. An ID below
 * 2^53, as on macOS and Linux, is left as it is.
 */
export function inoOf(ino: bigint): number {
  return Number(BigInt.asUintN(53, ino ^ (ino >> 53n)));
}

const NS_PER_SECOND = 1_000_000_000n;

/** A time in nanoseconds as milliseconds, worked out as Node's ordinary stats work out `mtimeMs`. */
export function msOf(ns: bigint): number {
  let seconds = ns / NS_PER_SECOND;
  let nanoseconds = ns % NS_PER_SECOND;
  if (nanoseconds < 0n) {
    seconds -= 1n;
    nanoseconds += NS_PER_SECOND;
  }
  return Number(seconds) * 1e3 + Number(nanoseconds) / 1e6;
}

function infoOf(stats: BigIntStats): FileInfo {
  return {
    kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    size: Number(stats.size),
    mtimeMs: msOf(stats.mtimeNs),
    ino: inoOf(stats.ino),
    uid: Number(stats.uid),
    mode: Number(stats.mode),
    nlink: Number(stats.nlink),
  };
}

/**
 * Opens a file only if it is an ordinary file, as the Claude Code adapter's
 * `readRegularFile` does, but for reading in ranges and with no size limit of
 * its own: a Codex session file can be large, and each caller bounds what it reads.
 *
 * - It is opened without following a link at its name, and without waiting
 *   on a named pipe, which would take the whole poll with it: `noFollow.ts`.
 * - The check is made on the open file, not on the name.
 */
export async function openRegularFile(file: string): Promise<OpenFile> {
  const handle = await openWithoutFollowing(file, constants.O_RDONLY);
  let info: FileInfo;
  try {
    info = infoOf(await handle.stat({ bigint: true }));
    if (info.kind !== "file") throw new Error("Not an ordinary file.");
  } catch (error) {
    await handle.close();
    throw error;
  }
  return {
    info,
    async read(position, length) {
      const buffer = Buffer.alloc(Math.max(0, length));
      let filled = 0;
      while (filled < buffer.byteLength) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.byteLength - filled,
          position + filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return buffer.subarray(0, filled);
    },
    close: () => handle.close(),
  };
}

export const nodeIo: ReadOnlyIo = {
  readdir: (dir) => readdir(dir),
  stat: async (target) => infoOf(await stat(target, { bigint: true })),
  lstat: async (target) => infoOf(await lstat(target, { bigint: true })),
  openRegular: openRegularFile,
  realpath: (target) => realpath(target),
};

/** Whether a file-system error means the thing is not there at all. */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether a file-system error means the system would not let this user look, whatever is there. */
export function isRefused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}
