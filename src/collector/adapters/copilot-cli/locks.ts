import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { SWEEP_MS } from "../pi/sessionFiles.ts";

/**
 * The locks a Copilot CLI process keeps in a session's folder while it has
 * the session open. Built from the MIT Copilot SDK v2.0.1 and open-source
 * readers, never checked on a computer running Copilot CLI.
 *
 * The SDK says a session is in use while another running process holds it
 * "via an alive lock file" (`sessions.checkInUse` in `nodejs/src/generated/
 * rpc.ts`). Three readers agree that the lock is `inuse.<pid>.lock`, in the
 * session's folder, named for the process that holds it, made when the
 * process opens the session, which moves the folder's modified time. So:
 *
 * - A session's folder is listed again only when its modified time moved, or
 *   once a minute, and a listing that fails keeps the last one.
 * - Of its names only those that are `inuse.`, a process ID of 1 to 10 digits
 *   with no leading zero, and `.lock` are kept, and each is looked up with
 *   `lstat`, which must say it is an ordinary file. Its modified time is
 *   kept, as when the lock was made. A lock is never opened, and
 *   `inuse.<pid>.hold` and every other name in the folder are never looked
 *   up or kept.
 *
 * Nothing here takes, makes, changes or removes a lock.
 */

const LOCK_NAME = /^inuse\.([1-9][0-9]{0,9})\.lock$/;

/** The process ID a name gives, when it is a lock's name, else null. */
export function lockPidOf(name: string): number | null {
  const match = LOCK_NAME.exec(name);
  return match === null ? null : (validPid(Number(match[1])) ?? null);
}

/** A lock in a session's folder. */
export interface SessionLock {
  pid: number;
  /** Its modified time, as `lstat` gave it: when the process made it. */
  mtimeMs: number;
}

interface Listed {
  folderMtimeMs: number;
  at: number;
  locks: SessionLock[];
}

export interface LockReader {
  /**
   * The locks in a session's folder, given the folder's `lstat` this poll,
   * listed again only when its time moved or a sweep is due. Null when the
   * folder could not be listed and never has been.
   */
  locks(folder: string, folderInfo: FileInfo, now: number): Promise<SessionLock[] | null>;
  /** Forgets every folder not in this set. */
  keepOnly(folders: ReadonlySet<string>): void;
  /** How many folders it keeps, for the tests that check none is kept once it has gone. */
  readonly kept: number;
}

export function createLockReader(io: ReadOnlyIo, sweepMs: number = SWEEP_MS): LockReader {
  const listed = new Map<string, Listed>();

  return {
    async locks(folder, folderInfo, now) {
      const known = listed.get(folder);
      // A clock set back counts as time enough.
      const fresh =
        known !== undefined &&
        known.folderMtimeMs === folderInfo.mtimeMs &&
        now >= known.at &&
        now - known.at < sweepMs;
      if (fresh) return known.locks;
      let names: string[];
      try {
        names = await io.readdir(folder);
      } catch {
        return known?.locks ?? null;
      }
      const locks: SessionLock[] = [];
      for (const name of names.sort()) {
        const pid = lockPidOf(name);
        if (pid === null) continue;
        try {
          const info = await io.lstat(path.join(folder, name));
          if (info.kind === "file") locks.push({ pid, mtimeMs: info.mtimeMs });
        } catch {
          // Gone since the listing, or not to be looked at: no lock.
        }
      }
      listed.set(folder, { folderMtimeMs: folderInfo.mtimeMs, at: now, locks });
      return locks;
    },
    keepOnly(folders) {
      for (const folder of listed.keys()) if (!folders.has(folder)) listed.delete(folder);
    },
    get kept() {
      return listed.size;
    },
  };
}
