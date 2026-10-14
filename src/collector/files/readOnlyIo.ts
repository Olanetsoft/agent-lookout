import { constants, type Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";

import { openWithoutFollowing } from "./noFollow.ts";

/** What is at a path, without its contents. */
export interface FileInfo {
  /** `file` for an ordinary file, `directory`, or `other` for a link, a pipe, a device or a socket. */
  kind: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
  /** The file's identity on its disk, so a file replaced under the same name is noticed. */
  ino: number;
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
 * `~/.gemini/tmp`, the status-file adapter in the folder of status files, and
 * the branch finder in each session's repository.
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

function infoOf(stats: Stats): FileInfo {
  return {
    kind: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other",
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ino: stats.ino,
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
    info = infoOf(await handle.stat());
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
  stat: async (target) => infoOf(await stat(target)),
  lstat: async (target) => infoOf(await lstat(target)),
  openRegular: openRegularFile,
  realpath: (target) => realpath(target),
};

/** Whether a file-system error means the thing is not there at all. */
export function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
