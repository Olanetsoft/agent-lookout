import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { IndexedSession } from "./sessionIndex.ts";

/**
 * Finding which of Continue's sessions were written lately, without opening any
 * of their files.
 *
 * Each session has one file, `<id>.json` in the sessions folder, that holds the
 * whole conversation, and it is never opened. Its modified time is all that is
 * wanted of it, and `sessions.json` has no such time.
 *
 * Continue removes no session by itself, so the folder can hold thousands. A poll
 * looks up each session not already known to be old, with one `lstat`. Once a
 * minute, a sweep looks up every session in the index, for an old one opened
 * again. So a poll costs one `lstat` for each file written in the last day, and a
 * file not written for a day is not looked at again until the next sweep. A new
 * session is looked up on the first poll that finds it in the index.
 */

/** How often every session in the index is looked up. */
export const SWEEP_MS = 60_000;

/** The most sessions listed, newest first. The others wait for the next sweep. */
export const MAX_SESSIONS = 200;

/** A session, with what a `lstat` of its file said this poll. */
export interface RecentSession {
  session: IndexedSession;
  info: FileInfo;
}

export function sessionFilePath(sessionsDir: string, id: string): string {
  return path.join(sessionsDir, `${id}.json`);
}

export interface SessionFileFinder {
  /** Of these sessions, the ones whose files were written in the last day, newest first, at most `MAX_SESSIONS`. */
  recent(sessions: readonly IndexedSession[], now: number): Promise<RecentSession[]>;
  /** Forgets everything, as for a sessions folder that went. */
  forget(): void;
}

export interface SessionFileFinderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  sweepMs?: number;
}

export function createSessionFileFinder(options: SessionFileFinderOptions): SessionFileFinder {
  const { sessionsDir, io } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  /** The sessions last found not to be worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  let sweptAt: number | null = null;

  async function infoOf(id: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(sessionFilePath(sessionsDir, id));
    } catch {
      return null;
    }
  }

  return {
    async recent(sessions, now) {
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      if (since === null || since < 0 || since >= sweepMs) {
        sweptAt = now;
        passedOver = new Set();
      }

      const found: RecentSession[] = [];
      for (const session of sessions) {
        if (passedOver.has(session.id)) continue;
        const info = await infoOf(session.id);
        // A link, a pipe or a device is not a session file, whatever it is called.
        if (info?.kind === "file" && isWithinRetention(Math.floor(info.mtimeMs), now)) {
          found.push({ session, info });
        } else {
          passedOver.add(session.id);
        }
      }
      found.sort(
        (a, b) => b.info.mtimeMs - a.info.mtimeMs || a.session.id.localeCompare(b.session.id),
      );
      for (const { session } of found.slice(MAX_SESSIONS)) passedOver.add(session.id);
      return found.slice(0, MAX_SESSIONS);
    },

    forget() {
      passedOver = new Set();
      sweptAt = null;
    },
  };
}
