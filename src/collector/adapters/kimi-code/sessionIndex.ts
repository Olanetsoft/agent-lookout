import path from "node:path";

import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isFolderName, SESSIONS_DIR, type SessionPlace } from "./paths.ts";

/**
 * Reading `session_index.jsonl`, the list Kimi Code keeps of its sessions, in
 * its folder. Built from Kimi Code's source at 2.4.1 and not yet checked on a
 * computer running it.
 *
 * Kimi Code appends one line when it makes or forks a session,
 * `{"sessionId":"…","sessionDir":"…","workDir":"…"}`, and one when it deletes
 * one, `{"sessionId":"…","deleted":true}` (`appendSessionIndexEntry` and
 * `delete` in `workspace/sessionLifecycle/sessionLifecycleService.ts`). It
 * rewrites the file now and then to drop lines for folders that have gone
 * (`compactSessionIndexIfStale` in `app/workspace/workspaceAlias.ts`).
 *
 * - The file is opened without following a link, and read again only when its
 *   size, modified time or identity changes.
 * - At most its last 8 MiB are read, in which the newest lines are, and the line
 *   that cuts into is dropped.
 * - `sessionDir` is an absolute path, written when the session was made, and is
 *   never followed. Only the name of the session's bucket is taken from it, and
 *   the session's folder is worked out from Kimi Code's folder as it is now.
 * - A line that is not one of these, or has a bad id or `sessionDir`, is skipped.
 *   A bad `workDir` only leaves `folder` null.
 */

export const SESSION_INDEX_FILE = "session_index.jsonl";

/** The most of the index read. A line is about 300 bytes, so this holds some 25,000 sessions. */
export const INDEX_LIMIT_BYTES = 8 * 1024 * 1024;

/** The longest folder kept. A longer one is not a folder. */
const MAX_FOLDER_LENGTH = 4096;

const NEWLINE = 0x0a;

const CONTROL = /\p{Cc}/u;

/** What is kept of one session in the index. */
export interface IndexedSession extends SessionPlace {
  /** The folder it was made in: an absolute path, or null when the line's is not one. */
  folder: string | null;
}

export type IndexRead =
  | { state: "ok"; sessions: ReadonlyMap<string, IndexedSession> }
  /** No file at its name. */
  | { state: "missing" }
  /** A link or something else that is no ordinary file at its name, or a read that failed with nothing read before. */
  | { state: "unreadable" };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An absolute path on this system's rules, or null. */
export function folderOf(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_FOLDER_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? value : null;
}

/** The bucket a line's `sessionDir` names, when it ends in `sessions/<bucket>/<id>`. */
function bucketOf(sessionDir: unknown, id: string): string | null {
  if (typeof sessionDir !== "string" || sessionDir.length > MAX_FOLDER_LENGTH) return null;
  const [sessions, bucket, last] = sessionDir.split(/[\\/]/).slice(-3);
  return sessions === SESSIONS_DIR && last === id && isFolderName(bucket) ? bucket : null;
}

/** The sessions lines leave standing: a later line for an id replaces an earlier one. */
export function parseIndex(text: string, platform: NodeJS.Platform): Map<string, IndexedSession> {
  const sessions = new Map<string, IndexedSession>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const id = value.sessionId;
    if (!isFolderName(id)) continue;
    if (value.deleted === true) {
      sessions.delete(id);
      continue;
    }
    const bucket = bucketOf(value.sessionDir, id);
    if (bucket !== null) {
      sessions.set(id, { id, bucket, folder: folderOf(value.workDir, platform) });
    }
  }
  return sessions;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface IndexReader {
  /** What the index says, read only when it changed. When it cannot be read, what was read before stands. */
  read(): Promise<IndexRead>;
}

export function createIndexReader(
  file: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): IndexReader {
  let known: { info: FileInfo; sessions: ReadonlyMap<string, IndexedSession> } | null = null;

  async function textOf(): Promise<string> {
    const handle = await io.openRegular(file);
    try {
      const { size } = handle.info;
      const from = Math.max(0, size - INDEX_LIMIT_BYTES);
      const read = await handle.read(from, size - from);
      const bytes = Buffer.from(read.buffer, read.byteOffset, read.byteLength);
      // A read that begins inside the file begins inside a line, which is dropped.
      return bytes.toString("utf8", from === 0 ? 0 : bytes.indexOf(NEWLINE) + 1);
    } finally {
      await handle.close();
    }
  }

  function stood(): IndexRead {
    return known === null ? { state: "unreadable" } : { state: "ok", sessions: known.sessions };
  }

  return {
    async read() {
      let info: FileInfo;
      try {
        info = await io.lstat(file);
      } catch (error) {
        if (!isMissing(error)) return stood();
        known = null;
        return { state: "missing" };
      }
      if (info.kind !== "file") {
        known = null;
        return { state: "unreadable" };
      }
      if (known !== null && sameFile(known.info, info)) return stood();
      try {
        known = { info, sessions: parseIndex(await textOf(), platform) };
      } catch {
        // Unreadable this time: what was read before stands, and it is tried again next poll.
      }
      return stood();
    },
  };
}
