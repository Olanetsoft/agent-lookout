import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { MAX_SESSIONS, SWEEP_MS } from "../pi/sessionFiles.ts";

/**
 * Finding Muse Code's session logs, without opening any of them. Built from
 * Meta's documentation and not yet checked on a computer running Muse Code.
 *
 * Muse Code keeps each session's log at
 * `<sessions>/<YYYY>/<MM>/<DD>/<session id>/session.jsonl`, and the folder's
 * name is the session's ID, a UUID (Meta's host-operations guide and its
 * sessions-and-turns page, at 1.4). A resume appends to the same file, in its
 * old day folder. So on each poll:
 *
 * - `sessions/` is looked up with `lstat`, and listed again when its modified
 *   time moved or a sweep is due. It must be a real folder: a link there is
 *   not followed.
 * - Between sweeps, the newest three day folders by name are looked at:
 *   years newest first, in each its months, in each its days. Each folder on
 *   the way is looked up with `lstat` and listed again only when its modified
 *   time moved. So neither local time nor UTC is assumed for a folder's date.
 * - In this order, each session folder in those three day folders, each log
 *   the last sweep found written in the last day wherever it is, and each
 *   session that needed the person at the last poll, are looked up: the
 *   session folder with `lstat`, which must be a real folder, then its
 *   `session.jsonl` with `lstat`, which must be an ordinary file. A log
 *   written in the last day, or one of a session that needed the person, is
 *   one to read; any other is passed over until the next sweep.
 * - Once a minute, a sweep lists every year, month and day folder and looks
 *   up every session folder in them.
 * - The newest `MAX_SESSIONS` are read, and every one that needed the person.
 *   The rest are passed over until the next sweep.
 *
 * Names are taken only as Muse Code makes them: years of four digits, months
 * and days of two, session folders lowercase UUIDs. A dot folder such as
 * `.msp-view-v1` and every other name are never looked up. A session folder
 * is never listed, so `.session.lock`, `subagent/`, `approval-review/`, the
 * databases and every other name beside the log are never learnt. A link, or
 * anything but a folder or an ordinary file, is never gone into or taken.
 */

const YEAR = /^\d{4}$/;
const MONTH = /^(0[1-9]|1[0-2])$/;
const DAY = /^(0[1-9]|[12]\d|3[01])$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name of a session's log in its folder. */
export const LOG_NAME = "session.jsonl";

/** The day folders looked at between sweeps. */
export const NEWEST_DAYS = 3;

/** A session's log, with what a `lstat` of it said this poll. */
export interface SessionRef {
  /** The session folder's name: the session's ID. */
  id: string;
  folder: string;
  path: string;
  info: FileInfo;
}

export interface FoundSessions {
  /** The logs to read, newest first, then by path. */
  refs: SessionRef[];
  /** Whether a link, or anything but a folder or a file, was met where one was looked for. */
  link: boolean;
}

/** `sessions/` is there, but it is a link or not a folder. */
export class NotAFolderError extends Error {}

export interface SessionFinder {
  /**
   * The logs this poll, with `needed`, the logs of the sessions that needed
   * the person at the last poll. Rejects, with the error's `code`, when
   * `sessions/` is missing or cannot be listed, and with `NotAFolderError`
   * when it is not a real folder.
   */
  find(now: number, needed: ReadonlySet<string>): Promise<FoundSessions>;
  /** Forgets everything, as for a sessions folder that went. */
  forget(): void;
}

export interface SessionFinderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  sweepMs?: number;
  /** The most logs read at once, `MAX_SESSIONS` unless a test says fewer. */
  maxSessions?: number;
}

interface Listed {
  mtimeMs: number;
  names: string[];
}

export function createSessionFinder(options: SessionFinderOptions): SessionFinder {
  const { sessionsDir, io } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  /** What each folder held when it was last listed, by the folder. */
  let lists = new Map<string, Listed>();
  /** Logs found not worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  /** The session folders whose log the last sweep found written in the last day. */
  let recent: string[] = [];
  let sweptAt: number | null = null;

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  /** What a `lstat` of a folder says: its info, `missing` when nothing is there, or `unknown` for any other error. */
  async function lookUp(target: string): Promise<FileInfo | "missing" | "unknown"> {
    try {
      return await io.lstat(target);
    } catch (error) {
      return isMissing(error) ? "missing" : "unknown";
    }
  }

  return {
    async find(now, needed) {
      const root = await io.lstat(sessionsDir);
      if (root.kind !== "directory") throw new NotAFolderError("Not a folder.");
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      const sweep = since === null || since < 0 || since >= sweepMs;
      if (sweep) {
        sweptAt = now;
        passedOver = new Set();
      }
      let link = false;
      /** The lists kept after this poll: those listed or used on it. */
      const seen = new Map<string, Listed>();

      /**
       * The names in a folder that `pattern` takes, newest first, or null when
       * it is not a real folder or is gone. It is listed again when its time
       * moved or a sweep is due. One that cannot be looked up, or listed,
       * keeps its last list for this poll.
       */
      async function namesIn(
        dir: string,
        pattern: RegExp,
        found: FileInfo | "missing" | "unknown",
      ): Promise<string[] | null> {
        const kept = lists.get(dir);
        const keep = () => {
          if (kept === undefined) return null;
          seen.set(dir, kept);
          return kept.names;
        };
        if (found === "missing") {
          lists.delete(dir);
          return null;
        }
        if (found === "unknown") return keep();
        if (found.kind !== "directory") {
          if (found.kind === "other") link = true;
          return null;
        }
        if (!sweep && kept?.mtimeMs === found.mtimeMs) return keep();
        let names: string[];
        try {
          names = (await io.readdir(dir))
            .filter((name) => pattern.test(name))
            .sort()
            .reverse();
        } catch (error) {
          if (dir === sessionsDir) throw error;
          return keep();
        }
        seen.set(dir, { mtimeMs: found.mtimeMs, names });
        return names;
      }

      /** The session folders of the newest `limit` day folders, or of every one. */
      async function sessionFolders(limit: number): Promise<string[]> {
        const folders: string[] = [];
        let days = 0;
        for (const year of (await namesIn(sessionsDir, YEAR, root)) ?? []) {
          const yearDir = path.join(sessionsDir, year);
          for (const month of (await namesIn(yearDir, MONTH, await lookUp(yearDir))) ?? []) {
            const monthDir = path.join(yearDir, month);
            for (const day of (await namesIn(monthDir, DAY, await lookUp(monthDir))) ?? []) {
              const dayDir = path.join(monthDir, day);
              const sessions = await namesIn(dayDir, SESSION, await lookUp(dayDir));
              if (sessions === null) continue;
              for (const name of sessions) folders.push(path.join(dayDir, name));
              days += 1;
              if (days >= limit) return folders;
            }
          }
        }
        return folders;
      }

      const folders = await sessionFolders(sweep ? Infinity : NEWEST_DAYS);
      const neededFolders = [...needed].map((log) => path.dirname(log));
      const order = new Set([...folders, ...(sweep ? [] : recent), ...neededFolders]);

      const candidates: SessionRef[] = [];
      const recentNow: string[] = [];
      for (const folder of order) {
        const file = path.join(folder, LOG_NAME);
        const wanted = needed.has(file);
        if (!wanted && passedOver.has(file)) continue;
        const folderInfo = await infoOf(folder);
        if (folderInfo?.kind !== "directory") {
          if (folderInfo?.kind === "other") link = true;
          continue;
        }
        const info = await infoOf(file);
        if (info?.kind !== "file") {
          if (info?.kind === "other") link = true;
          continue;
        }
        const written = isWithinRetention(Math.floor(info.mtimeMs), now);
        if (!written && !wanted) {
          passedOver.add(file);
          continue;
        }
        if (written) recentNow.push(folder);
        candidates.push({ id: path.basename(folder), folder, path: file, info });
      }
      // The sweep's own list of logs written in the last day stands until the next sweep.
      if (sweep) recent = recentNow;
      // What was listed this poll, and what was kept and looked at, stays; folders not reached keep theirs between sweeps.
      lists = sweep ? seen : new Map([...lists, ...seen]);

      candidates.sort(
        (a, b) =>
          b.info.mtimeMs - a.info.mtimeMs || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      const refs: SessionRef[] = [];
      for (const [index, ref] of candidates.entries()) {
        if (index < maxSessions || needed.has(ref.path)) refs.push(ref);
        else passedOver.add(ref.path);
      }
      return { refs, link };
    },

    forget() {
      lists = new Map();
      passedOver = new Set();
      recent = [];
      sweptAt = null;
    },
  };
}
