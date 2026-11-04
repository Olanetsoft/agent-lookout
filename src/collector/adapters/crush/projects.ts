import path from "node:path";

import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Crush's list of projects, `projects.json` in its data folder, which decides
 * which folders are read.
 *
 * Crush keeps a database in each project, and this file is the one place that
 * says where they are. It rewrites the file each time it starts in a folder, with
 * that folder first (`Register` in `internal/projects/projects.go`):
 *
 *     {"projects":[{"path":"…","data_dir":"…","last_accessed":"…"}]}
 *
 * A path taken from a file is what this adapter has to be careful of, so of each
 * entry only `path` is kept, and only when it is an absolute path with no `.` or
 * `..` in it and nothing unprintable. `crush --cwd <folder>` writes the folder as
 * it was typed, so a relative one is a real entry, and it is never opened: it says
 * nothing without the folder Crush was started in.
 *
 * `data_dir` is never taken. It can name any folder, through `--data-dir` or
 * `options.data_directory`, so nothing but `.crush` in a listed folder is read.
 *
 * - The file is opened without following a link, and read again only when its
 *   size, modified time or identity changes.
 * - A file over 1 MiB is not read.
 * - Only its first 20 folders, the newest, are taken.
 * - Crush writes the file in place, so a read can catch it half written. Such a
 *   read leaves the last list standing, and the next change is read.
 *
 * Built from Crush's source at v0.99.0, and not yet checked on a computer
 * running Crush.
 */

/** The file, in Crush's data folder. */
export const PROJECT_LIST_FILE = "projects.json";

/** The folder of a project Crush keeps its files in, and the database in it. */
export const DATA_FOLDER = ".crush";
export const DATABASE_FILE = "crush.db";

/** The most of the list read. An entry is about 200 bytes, so this holds some 5,000 projects. */
export const MAX_LIST_BYTES = 1024 * 1024;

/**
 * The most projects read, the newest first. As many as the page reads for one
 * source (`MAX_PARTS` in `src/dashboard/lib/api/readApi.ts`). Another machine
 * takes 20 parts in all, one of them for its status files, so past that each of
 * its sources is compared whole.
 */
export const MAX_PROJECTS = 20;

/** The longest folder kept. A longer one is not a folder. */
const MAX_FOLDER_LENGTH = 4096;

/** A control character or a mark that turns text around, which no folder kept may hold. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** The database of a listed project. A project's folder is a POSIX path: nothing is read on Windows. */
export function databaseOf(folder: string): string {
  return path.posix.join(folder, DATA_FOLDER, DATABASE_FILE);
}

/**
 * A project's folder as it is kept: an absolute path with no `.` or `..` in it,
 * not too long, and with nothing unprintable in it. Null otherwise, and for the
 * root, which is no project.
 */
export function projectFolderOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_FOLDER_LENGTH) return null;
  if (!path.posix.isAbsolute(value) || UNPRINTABLE.test(value)) return null;
  if (value.split("/").some((name) => name === "." || name === "..")) return null;
  const folder = path.posix.resolve(value);
  return folder === "/" ? null : folder;
}

/** The folders in the list's text, the newest first, at most 20, each once. Null when it is no such list. */
export function parseProjectList(text: string): string[] | null {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof list !== "object" || list === null) return null;
  const { projects } = list as { projects?: unknown };
  if (!Array.isArray(projects)) return null;
  const folders = new Set<string>();
  for (const project of projects) {
    if (folders.size >= MAX_PROJECTS) break;
    if (typeof project !== "object" || project === null) continue;
    const folder = projectFolderOf((project as { path?: unknown }).path);
    if (folder !== null) folders.add(folder);
  }
  return [...folders];
}

/**
 * What the list said:
 *
 * read        its folders
 * missing     there is no list
 * not-safe    a link or anything but an ordinary file is at its name, or at the data folder's
 * too-large   it is over 1 MiB, and was not read
 * unreadable  it could not be read, or is no such list, with no list read before it
 */
export type ListRead =
  | { state: "read"; folders: readonly string[] }
  | { state: "missing" | "not-safe" | "too-large" | "unreadable" };

export interface ListReader {
  /** The list's folders, read again only when it changed. Never throws. */
  read(): Promise<ListRead>;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export function createListReader(options: { dataFolder: string; io: ReadOnlyIo }): ListReader {
  const { dataFolder, io } = options;
  const file = path.join(dataFolder, PROJECT_LIST_FILE);
  let known: { info: FileInfo; folders: readonly string[] } | null = null;

  /** At most 1 MiB of the file, from what was opened, so nothing can be swapped in between. */
  async function textOf(): Promise<string | null> {
    const handle = await io.openRegular(file);
    try {
      if (handle.info.size > MAX_LIST_BYTES) return null;
      return Buffer.from(await handle.read(0, handle.info.size)).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  function stood(): ListRead {
    return known === null ? { state: "unreadable" } : { state: "read", folders: known.folders };
  }

  async function read(): Promise<ListRead> {
    let info: FileInfo;
    try {
      if ((await io.lstat(dataFolder)).kind !== "directory") {
        known = null;
        return { state: "not-safe" };
      }
      info = await io.lstat(file);
    } catch (error) {
      if (!isMissing(error)) return stood();
      known = null;
      return { state: "missing" };
    }
    if (info.kind !== "file") {
      known = null;
      return { state: "not-safe" };
    }
    if (info.size > MAX_LIST_BYTES) {
      known = null;
      return { state: "too-large" };
    }
    if (known !== null && sameFile(known.info, info)) return stood();
    const text = await textOf();
    if (text === null) return stood();
    const folders = parseProjectList(text);
    if (folders === null) return stood();
    known = { info, folders };
    return stood();
  }

  return {
    async read() {
      try {
        return await read();
      } catch {
        // Unreadable this time: what was read before stands, and it is tried again next poll.
        return stood();
      }
    },
  };
}
