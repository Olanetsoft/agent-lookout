import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { lstat, lutimes, mkdir, open, readdir, unlink } from "node:fs/promises";

/**
 * Everything the history does to the file system, in its own folder and
 * nowhere else. Tests of the keeper replace it with a folder held in memory.
 *
 * No method follows a link at the file's own name: a link, a pipe, a device or
 * a folder where a history file should be is never read, written or deleted.
 */
export interface HistoryFs {
  /** Makes the folder, and each folder above it that is not there, with mode 700. */
  makeFolder(dir: string): Promise<void>;
  /** The names in a folder. Rejects, with the error's `code`, when it cannot list it. */
  list(dir: string): Promise<string[]>;
  /** What is at a path, without following a link. `file` is an ordinary file. */
  lstat(file: string): Promise<PathInfo>;
  /** The same at once, for the lock as Agent Lookout starts writing. */
  lstatNow(file: string): PathInfo;
  /** The text of an ordinary file of at most `maxBytes`. Rejects for anything else. */
  readRegular(file: string, maxBytes: number): Promise<string>;
  /** The same at once, for the lock. */
  readRegularNow(file: string, maxBytes: number): string;
  /** Adds to the end of an ordinary file, making it with mode 600 when it is not there. */
  append(file: string, text: string): Promise<void>;
  /** The same at once, for the last write as Agent Lookout stops. */
  appendNow(file: string, text: string): void;
  /** Makes a file that is not there yet, with mode 600. Rejects with `EEXIST` when something is. */
  create(file: string, text: string): Promise<void>;
  /** The same at once, for the lock. */
  createNow(file: string, text: string): void;
  /** Sets when a file was last modified. */
  touch(file: string, at: number): Promise<void>;
  /** Deletes a file. One that is not there is no error. */
  remove(file: string): Promise<void>;
  /** The same at once, as Agent Lookout stops. */
  removeNow(file: string): void;
}

/** What is at a path. */
export interface PathInfo {
  kind: "file" | "other";
  size: number;
  mtimeMs: number;
}

function infoOf(info: Stats): PathInfo {
  return { kind: info.isFile() ? "file" : "other", size: info.size, mtimeMs: info.mtimeMs };
}

/** A file's mode: read and written by its owner, and by nobody else. */
export const FILE_MODE = 0o600;

/** The folder's mode: listed and entered by its owner, and by nobody else. */
export const FOLDER_MODE = 0o700;

// `O_NOFOLLOW` makes an open fail when the name is a link, and `O_NONBLOCK`
// makes it return at once for a named pipe, which would otherwise wait for a
// writer for ever. Neither exists on Windows, where they are left out.
const NO_FOLLOW = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const READ = constants.O_RDONLY | NO_FOLLOW;
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

function notOrdinary(): Error {
  return new Error("Not an ordinary file.");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Reads an ordinary file whole, as the Claude Code adapter's `readRegularFile`
 * reads a registry file: opened without following a link and without waiting
 * on a pipe, and checked on the open file, not on its name, so nothing can be
 * swapped in between. A file larger than `maxBytes` is not read at all.
 */
async function readRegular(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, READ);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notOrdinary();
    if (info.size > maxBytes) throw new Error("Too large to be a history file.");
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } finally {
    await handle.close();
  }
}

function readRegularNow(file: string, maxBytes: number): string {
  const fd = openSync(file, READ);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw notOrdinary();
    if (info.size > maxBytes) throw new Error("Too large to be a history file.");
    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const read = readSync(fd, buffer, filled, buffer.byteLength - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return buffer.toString("utf8", 0, filled);
  } finally {
    closeSync(fd);
  }
}

function writeNow(file: string, flags: number, text: string): void {
  const fd = openSync(file, flags, FILE_MODE);
  try {
    if (!fstatSync(fd).isFile()) throw notOrdinary();
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

async function writeTo(file: string, flags: number, text: string): Promise<void> {
  const handle = await open(file, flags, FILE_MODE);
  try {
    if (!(await handle.stat()).isFile()) throw notOrdinary();
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

export const nodeHistoryFs: HistoryFs = {
  async makeFolder(dir) {
    await mkdir(dir, { recursive: true, mode: FOLDER_MODE });
  },
  list: (dir) => readdir(dir),
  lstat: async (file) => infoOf(await lstat(file)),
  lstatNow: (file) => infoOf(lstatSync(file)),
  readRegular,
  readRegularNow,
  append: (file, text) => writeTo(file, APPEND, text),
  appendNow: (file, text) => writeNow(file, APPEND, text),
  create: (file, text) => writeTo(file, CREATE, text),
  createNow: (file, text) => writeNow(file, CREATE, text),
  async touch(file, at) {
    const when = new Date(at);
    await lutimes(file, when, when);
  },
  async remove(file) {
    try {
      await unlink(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  },
  removeNow(file) {
    try {
      unlinkSync(file);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  },
};
