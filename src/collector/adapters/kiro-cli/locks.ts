import type { KiroLiveness } from "../../../core/mapping/kiro-cli/kiroCliMapping.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import type { StartMatch } from "../../processes/processStart.ts";
import { parseKiroTime } from "./rows.ts";

/**
 * A Kiro CLI session's lock: `sess_<uuid>/.lock` in the V3 store and
 * `cli/<uuid>.lock` in the V2 store. Built from Kiro's documentation and
 * open-source readers of its files, and not yet checked on a computer running
 * Kiro CLI.
 *
 * Kiro's documentation says a local session is open in one process at a time,
 * and names that process when another tries to open it. Readers of its files
 * find the lock held while a session is open, removed on a clean exit and left
 * behind, naming a process that has ended, after a crash. Its body is one line
 * of JSON, `{"pid":…,"started_at":"<RFC 3339>"}`, with more fields on Linux.
 * Only `pid` and `started_at` are kept, and at most 4 KiB of the file is read.
 *
 * The process it names is Kiro's terminal app, or in V2 a helper below
 * `kiro-cli`, never `kiro-cli` itself, so it is used only to tell whether the
 * session is open, never to find a terminal. Nothing here takes, clears, makes
 * or changes a lock, and a lock left behind is left alone.
 */

/** The most of a lock read. Kiro writes well under 200 bytes. */
export const LOCK_LIMIT_BYTES = 4 * 1024;

/** What is kept of a lock. */
export interface KiroLock {
  pid: number;
  /** When it was taken, in Unix milliseconds, or null when the lock does not say in a form that can be read. */
  startedAt: number | null;
}

/** What one look at a session's lock found. */
export type LockLook =
  /** No lock: no file at its name, or in the V2 store a folder there, which is not a lock. */
  | { state: "none" }
  /** A lock that cannot be read: a link or anything else at its name, a failed look, too large, or not a lock's shape. */
  | { state: "unreadable" }
  | { state: "held"; lock: KiroLock };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a lock's bytes say, or null when they are not a lock Kiro wrote: one with no `pid` that could be a process's. */
export function parseLock(text: string): KiroLock | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const pid = validPid(value.pid);
  if (pid === undefined) return null;
  return { pid, startedAt: parseKiroTime(value.started_at) };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface LockReader {
  /**
   * What a session's lock says this poll. `folderIsNoLock` is true in the V2
   * store, where a folder at a lock's name is passed over. A lock is opened
   * only when it changed since its last read, or that read failed.
   */
  look(file: string, folderIsNoLock: boolean): Promise<LockLook>;
  /** Forgets every lock not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createLockReader(io: ReadOnlyIo): LockReader {
  const kept = new Map<string, { info: FileInfo; look: LockLook }>();

  /** What a lock's bytes say, or null when it could not be opened or read this time. */
  async function readLock(file: string): Promise<LockLook | null> {
    try {
      const handle = await io.openRegular(file);
      try {
        if (handle.info.size > LOCK_LIMIT_BYTES) return { state: "unreadable" };
        const data = await handle.read(0, handle.info.size);
        const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
        const lock = parseLock(text);
        return lock === null ? { state: "unreadable" } : { state: "held", lock };
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Gone since its `lstat`: let go between the two looks.
      return isMissing(error) ? { state: "none" } : null;
    }
  }

  return {
    async look(file, folderIsNoLock) {
      let info: FileInfo;
      try {
        info = await io.lstat(file);
      } catch (error) {
        kept.delete(file);
        return isMissing(error) ? { state: "none" } : { state: "unreadable" };
      }
      if (info.kind !== "file") {
        kept.delete(file);
        return info.kind === "directory" && folderIsNoLock
          ? { state: "none" }
          : { state: "unreadable" };
      }
      const before = kept.get(file);
      if (before && sameFile(before.info, info)) return before.look;
      const look = await readLock(file);
      // A read that failed is tried again on the next poll, so a lock a crash
      // left behind can still be found to name a process that has ended.
      if (look === null) {
        kept.delete(file);
        return { state: "unreadable" };
      }
      if (look.state === "none") kept.delete(file);
      else kept.set(file, { info, look });
      return look;
    },
    keepOnly(files) {
      for (const file of kept.keys()) {
        if (!files.has(file)) kept.delete(file);
      }
    },
  };
}

/** What tells whether a held lock's process is the one that took it. */
export interface LockProcess {
  /** Whether a process has the lock's pid now, by signal 0. */
  alive: boolean;
  /** When the computer started, as Agent Lookout last worked it out. */
  bootedAt: number;
  /**
   * Whether `ps` says the process with the pid now started no later than the
   * lock was taken, give or take a minute: "same", "different" or "unknown",
   * or null where `ps` is not asked.
   */
  match: StartMatch | null;
}

/**
 * Whether a session is open, from its lock and its process.
 *
 * - No lock: closed.
 * - A lock that cannot be read: unknown.
 * - A lock whose process does not run: closed, a lock a crash left behind.
 * - A lock with no time that can be read, or whose process's start cannot be
 *   checked, as where `ps` is not asked or cannot say: unknown.
 * - A lock taken before the computer started: closed, as no process outlives a
 *   restart, and the pid is another program's.
 * - A lock whose process started more than a minute after it was taken:
 *   closed, as the pid has been given to another program.
 * - Otherwise: open.
 */
export function livenessOf(look: LockLook, facts: LockProcess | undefined): KiroLiveness {
  if (look.state === "none") return "closed";
  if (look.state === "unreadable" || facts === undefined) return "unknown";
  const { alive, bootedAt, match } = facts;
  if (!alive) return "closed";
  const { startedAt } = look.lock;
  if (startedAt === null) return "unknown";
  if (startedAt < bootedAt) return "closed";
  if (match === "same") return "open";
  if (match === "different") return "closed";
  return "unknown";
}
