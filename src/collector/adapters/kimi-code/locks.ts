import path from "node:path";

import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { isFolderName, isReachedByRealFolders } from "./paths.ts";
import { isRecord } from "./sessionIndex.ts";

/**
 * The folder where Kimi Code keeps a lock for each session it is using:
 * `locks/sessions/` in its folder, one `<session id>.lock` for each
 * (`persistence/backends/node-fs/sessionLockService.ts` at 2.4.1).
 *
 * To take a lock, Kimi Code writes a temporary file and links it to that name,
 * so a lock is never half written, and it writes
 * `{"version":1,"token":…,"pid":…,"hostname":…,"startedAt":…,"clientIdentity":…}`.
 * It takes the lock when a session's turn begins and each time it writes to the
 * session, and lets it go 3 seconds after the session stops being busy, so a
 * session idle between turns has none (`session/sessionActivity/sessionRunGateService.ts`).
 * A process that crashes leaves its lock behind, which the next Kimi Code to want
 * that session clears once it finds the process gone.
 *
 * This adapter lists the folder and reads each `.lock`, and takes `pid` and
 * `startedAt` alone. `token`, `hostname` and the client's name are dropped with
 * the parsed file. Kimi Code's temporary `.lock.tmp-…` and `.lock.reclaim` files
 * end otherwise and are not read. A lock is read only when it changed, and a
 * read that fails leaves what was read of it before, and is tried again next
 * poll: a failed read is no fact about the file.
 *
 * Nothing here takes, clears, makes or changes a lock.
 */

/** The folder of locks, in Kimi Code's folder. */
export const LOCK_FOLDERS = ["locks", "sessions"] as const;

/** The most of a lock read. Kimi Code writes about 200 bytes. */
export const LOCK_LIMIT_BYTES = 4 * 1024;

const LOCK = ".lock";

/** What is kept of a lock. It stands only with both: Kimi Code takes a lock with no time for dead. */
export interface SessionLock {
  /** The process that took it. */
  pid: number;
  /** When it took it, in Unix milliseconds. */
  startedAt: number;
}

/** What a lock's bytes say. A lock that is not one Kimi Code wrote names nothing. */
export function parseLock(text: string): SessionLock | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const pid = validPid(value.pid);
  const { startedAt } = value;
  if (pid === undefined || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)) {
    return null;
  }
  return { pid, startedAt };
}

/** The session a file in the folder is the lock of, or null for any other name. */
export function sessionOfLockFile(name: string): string | null {
  if (!name.endsWith(LOCK)) return null;
  const id = name.slice(0, -LOCK.length);
  return isFolderName(id) ? id : null;
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface LockReader {
  /**
   * Each session with a lock now, with what it says, or null when that names no
   * process. Null in place of the map when the folder could not be listed.
   */
  read(): Promise<Map<string, SessionLock | null> | null>;
}

export function createLockReader(home: string, io: ReadOnlyIo): LockReader {
  const dir = path.join(home, ...LOCK_FOLDERS);
  const known = new Map<string, { info: FileInfo; lock: SessionLock | null }>();

  /** Reads one lock. Throws when it could not be read. */
  async function readLock(file: string, info: FileInfo): Promise<SessionLock | null> {
    if (info.size > LOCK_LIMIT_BYTES) return null;
    const handle = await io.openRegular(file);
    try {
      const bytes = await handle.read(0, Math.min(handle.info.size, LOCK_LIMIT_BYTES));
      return parseLock(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString());
    } finally {
      await handle.close();
    }
  }

  /** What a session's lock says this poll, or undefined when it has none. */
  async function lockOf(id: string): Promise<SessionLock | null | undefined> {
    const file = path.join(dir, `${id}${LOCK}`);
    const before = known.get(id);
    let info: FileInfo;
    try {
      info = await io.lstat(file);
    } catch (error) {
      if (!isMissing(error)) return before?.lock ?? null;
      known.delete(id);
      return undefined;
    }
    if (info.kind !== "file") {
      known.delete(id);
      return null;
    }
    if (before && sameFile(before.info, info)) return before.lock;
    try {
      const lock = await readLock(file, info);
      known.set(id, { info, lock });
      return lock;
    } catch {
      return before?.lock ?? null;
    }
  }

  return {
    async read() {
      let names: string[];
      try {
        if (!(await isReachedByRealFolders(home, LOCK_FOLDERS, io))) names = [];
        else names = await io.readdir(dir);
      } catch (error) {
        if (!isMissing(error)) return null;
        names = [];
      }
      const locks = new Map<string, SessionLock | null>();
      for (const name of names) {
        const id = sessionOfLockFile(name);
        if (id === null) continue;
        const lock = await lockOf(id);
        if (lock !== undefined) locks.set(id, lock);
      }
      for (const id of known.keys()) if (!locks.has(id)) known.delete(id);
      return locks;
    },
  };
}
