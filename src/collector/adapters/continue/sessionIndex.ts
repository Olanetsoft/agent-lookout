import { fileURLToPath } from "node:url";

import { pathsOf } from "../../files/paths.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading `sessions.json`, the list Continue keeps of its sessions, in its
 * sessions folder. Built from Continue's source at v1.5.45 and not yet checked
 * on a computer running it.
 *
 * The file is one JSON array, oldest session first, of
 * `{ sessionId, title, dateCreated, workspaceDirectory, messageCount }`. `cn` and
 * Continue's editor extensions write it alike, through `HistoryManager.save` in
 * `core/util/history.ts`, after the session's own file, at every save.
 *
 * - The file is opened without following a link, and read again only when its
 *   size, modified time or identity changes.
 * - It is read whole, up to `MAX_INDEX_BYTES`. A longer one is left unread, and
 *   the card says so: one array cannot be read from its end.
 * - Only `sessionId`, `workspaceDirectory` and `dateCreated` are kept. `title` is
 *   dropped with the parsed file, never copied, kept or logged: an editor's title
 *   can be a line of the first prompt, word for word, and no field says when it
 *   is not. `messageCount` and anything Continue adds go the same way.
 * - An entry with a bad `sessionId` is skipped, as is one in Continue's old
 *   format, which has `session_id` instead. A bad `workspaceDirectory` or
 *   `dateCreated` is treated as none.
 * - Continue writes the file in place, not through a temporary file, so a read
 *   can catch it empty or half written. What was read of it before stands in, once.
 *
 * Nothing here writes, renames, deletes or locks anything.
 */

export const INDEX_FILE = "sessions.json";

/** The most of the index read. An entry is about 250 bytes, so this holds some 30,000 sessions. */
export const MAX_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * A session's id, as it names a file: never `.` or `..`, and nothing that could
 * leave the folder. A UUID by default, and what `cn serve --id` is given otherwise.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** `dateCreated` as Continue writes it: `String(Date.now())`. */
const EPOCH_MS = /^\d{1,16}$/;

/** The longest folder kept. A longer one is not a folder. */
const MAX_FOLDER_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** What is kept of one session in the index. */
export interface IndexedSession {
  id: string;
  /** The session's folder: an absolute path on this computer, or null when the entry's is not one. */
  folder: string | null;
  /** `dateCreated` in epoch milliseconds, or null when it is not a time. */
  createdAt: number | null;
}

export type IndexRead =
  | { state: "ok"; sessions: readonly IndexedSession[] }
  /** No file at its name. */
  | { state: "missing" }
  /** A link or something else that is no ordinary file at its name, or a read that failed with nothing read before. */
  | { state: "unreadable" }
  /** Not a list this reads. */
  | { state: "broken" }
  /** Over `MAX_INDEX_BYTES`. */
  | { state: "too-large" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `file:` URI as a path on this system's rules, or null for one that names none. */
function pathOfUri(uri: string, platform: NodeJS.Platform): string | null {
  try {
    return fileURLToPath(uri, { windows: platform === "win32" });
  } catch {
    return null;
  }
}

/**
 * `workspaceDirectory` as a folder. `cn` writes the path it runs in, and an editor
 * the URI of its first workspace folder: `file:///Users/you/code/demo`, or on
 * Windows `file:///c%3A/Users/you/code/demo` from VS Code and
 * `file:///C:/Users/you/code/demo` from a JetBrains editor. A URI of any other
 * kind, as for a remote workspace, names no folder on this computer.
 */
export function folderOf(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_FOLDER_LENGTH) return null;
  const folder = value.startsWith("file:") ? pathOfUri(value, platform) : value;
  if (folder === null || CONTROL.test(folder)) return null;
  return pathsOf(platform).isAbsolute(folder) ? folder : null;
}

function timeOf(value: unknown): number | null {
  return typeof value === "string" && EPOCH_MS.test(value) ? Number(value) : null;
}

/**
 * The kept fields of each session in the index, or null for anything that is not
 * a JSON array. An empty file counts as an empty list, as it does for Continue.
 */
export function parseIndex(text: string, platform: NodeJS.Platform): IndexedSession[] | null {
  if (text.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const sessions = new Map<string, IndexedSession>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { sessionId } = entry;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) continue;
    sessions.set(sessionId, {
      id: sessionId,
      folder: folderOf(entry.workspaceDirectory, platform),
      createdAt: timeOf(entry.dateCreated),
    });
  }
  return [...sessions.values()];
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface IndexReader {
  /** What the index says, read only when it changed. */
  read(): Promise<IndexRead>;
}

interface Remembered {
  info: FileInfo;
  read: IndexRead;
  /** True once this read has stood in for a file caught as it was written. */
  stoodIn: boolean;
}

/** Whether a read has sessions in it, so that a read with none could be a file caught as it was written. */
function holdsSessions(read: IndexRead | undefined): boolean {
  return read?.state === "ok" && read.sessions.length > 0;
}

/** A reader of the index, which keeps what it read until the file changes. */
export function createIndexReader(
  file: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): IndexReader {
  let known: Remembered | null = null;

  async function readFile(): Promise<IndexRead> {
    const handle = await io.openRegular(file);
    try {
      const { size } = handle.info;
      if (size > MAX_INDEX_BYTES) return { state: "too-large" };
      const bytes = await handle.read(0, size);
      const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
      const sessions = parseIndex(text, platform);
      return sessions === null ? { state: "broken" } : { state: "ok", sessions };
    } finally {
      await handle.close();
    }
  }

  return {
    async read() {
      let info: FileInfo;
      try {
        info = await io.lstat(file);
      } catch (error) {
        if (!isMissing(error)) return known?.read ?? { state: "unreadable" };
        known = null;
        return { state: "missing" };
      }
      if (info.kind !== "file") {
        known = null;
        return { state: "unreadable" };
      }
      if (known !== null && sameFile(known.info, info)) return known.read;

      let read: IndexRead;
      try {
        read = await readFile();
      } catch {
        // Gone since its `lstat`, or a read error: what was read before stands,
        // and it is tried again on the next poll.
        return known?.read ?? { state: "unreadable" };
      }
      // Empty or half written, as a read can catch it: what was read before
      // stands in, once, so no session seems to end.
      const caught = read.state === "broken" || (read.state === "ok" && !holdsSessions(read));
      if (caught && known !== null && holdsSessions(known.read) && !known.stoodIn) {
        known.stoodIn = true;
        return known.read;
      }
      known = { info, read, stoodIn: false };
      return read;
    },
  };
}
