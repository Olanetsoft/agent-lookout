import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Finding DeepSeek Harness's session logs, without opening any of them.
 * Built from DeepSeek Harness's source at dsh-v0.2.2-rc.3 and not yet checked
 * on a computer running it.
 *
 * DeepSeek Harness keeps each session in a folder of its own, in a folder
 * for its project: `<sessions>/<project folder>/<session folder>/<log>`
 * (session-persistence-jsonl/src/format.ts:225-269). Every folder in the
 * sessions folder is a project's, and every folder in one of those a
 * session's (index.ts:1671-1693). A log is `session.jsonl` or
 * `session.v<N>.jsonl`, with `.zstd` when it is compressed
 * (session-format/src/filename.ts:5). DeepSeek Harness reads the one with
 * the highest N, and refuses a session whose highest N it does not know even
 * when an older one is beside it (docs/subsystems/persistence.md:193), or
 * whose folder holds names of both kinds (index.ts:1561).
 *
 * So on each poll the sessions folder is looked up, following a link there,
 * and listed when its modified time moved or a sweep is due. Each project
 * folder is looked up with `lstat`, which follows no link, and listed when
 * its time moved or a sweep is due. A session folder is listed when it first
 * appears and at each sweep, and on every poll while it holds no log yet and
 * was changed in the last day, for a session being made. A session folder
 * that held no log when last listed is looked up with `lstat` on every poll,
 * however old it is. Of a session folder only its names are read. On every
 * poll each log of format 4 is looked up with `lstat`, its session folder
 * first, unless the log was found to be older than a day or past the newest
 * `MAX_LOGS`, when it is passed over until the next sweep. A link a lookup
 * finds, or anything that is not a folder or a file, is never gone into or
 * taken. So a link put at a session folder's name since it was listed is
 * caught by the folder's lookup, just before its log's, and one put there
 * after the log's lookup by the reader, which reads a log only when the file
 * it opens is the one that lookup found. Only one put there between the two
 * lookups is followed, for that poll alone. `session.lock`, temporary files
 * and every other name are never looked up.
 */

/** How often every folder is listed and every log looked up. */
export const SWEEP_MS = 60_000;

/** The most logs looked at, newest first. The others wait for the next sweep. */
export const MAX_LOGS = 2000;

/** The format this reads. */
export const FORMAT_VERSION = 4;

/** A log's name, with its format and whether it is compressed. */
const LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/;

/** A file in a project folder of DeepSeek Harness's older flat layout, which it refuses (index.ts:1685-1692). */
const FLAT_FILE = /\.jsonl(?:\.zstd)?$/;

/** A log of format 4, with what a `lstat` of it said this poll. */
export interface LogRef {
  /** The session's folder, whose name the session's ID is made from. */
  folder: string;
  path: string;
  zstd: boolean;
  info: FileInfo;
}

/** A session whose newest log is of a newer format than this reads. */
export interface NewerRef {
  folder: string;
  /** Its log of format 4 beside the newer one, or null when there is none. */
  current: string | null;
  /** What a `lstat` of the newer log said. */
  info: FileInfo;
}

export interface FoundLogs {
  /** The logs of format 4 written to in the last day, newest first, at most `MAX_LOGS`. */
  logs: LogRef[];
  /** The sessions written to in the last day whose newest log is newer. */
  newer: NewerRef[];
  /** How many sessions written to in the last day have only logs older than format 4. */
  older: number;
  /** How many compressed logs written to in the last day were passed over, as this Node.js cannot read them. */
  compressed: number;
}

type Choice =
  | { kind: "log"; name: string; zstd: boolean }
  | { kind: "newer"; name: string; current: string | null }
  | { kind: "older"; name: string }
  /** Names of both kinds, or none. */
  | { kind: "none" };

interface SessionFolder {
  choice: Choice;
}

interface ProjectFolder {
  mtimeMs: number;
  sessions: string[];
}

/** The sessions folder is there, but it is not a folder. */
export class NotAFolderError extends Error {}

/** Which of a session folder's names DeepSeek Harness would read, from the names alone. */
export function chooseLog(names: readonly string[]): Choice {
  let best: { name: string; version: number; zstd: boolean } | null = null;
  const kinds = new Set<boolean>();
  const byVersion = new Map<string, string>();
  for (const name of names) {
    const match = LOG_NAME.exec(name);
    if (match === null) continue;
    const version = match[1] === undefined ? 0 : Number(match[1]);
    if (!Number.isSafeInteger(version)) continue;
    const zstd = match[2] !== undefined;
    kinds.add(zstd);
    byVersion.set(`${version}:${zstd}`, name);
    if (best === null || version > best.version) best = { name, version, zstd };
  }
  if (best === null || kinds.size > 1) return { kind: "none" };
  if (best.version > FORMAT_VERSION) {
    return {
      kind: "newer",
      name: best.name,
      current: byVersion.get(`${FORMAT_VERSION}:${best.zstd}`) ?? null,
    };
  }
  if (best.version < FORMAT_VERSION) return { kind: "older", name: best.name };
  return { kind: "log", name: best.name, zstd: best.zstd };
}

export interface LogFinder {
  /**
   * The logs this poll. Rejects, with the error's `code`, when the sessions
   * folder is missing or cannot be listed, and with `NotAFolderError` when it
   * is not a folder.
   */
  find(now: number): Promise<FoundLogs>;
  /** Forgets everything, as for a sessions folder that went. */
  forget(): void;
}

export interface LogFinderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  /** Whether compressed logs can be read. When not, they are looked up only to be counted. */
  readsCompressed: boolean;
  sweepMs?: number;
}

export function createLogFinder(options: LogFinderOptions): LogFinder {
  const { sessionsDir, io, readsCompressed } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  let root: { mtimeMs: number; names: string[] } | null = null;
  const projects = new Map<string, ProjectFolder>();
  const sessions = new Map<string, SessionFolder>();
  /** Session folders that held no log when last listed, listed again on each poll. */
  const pending = new Set<string>();
  /** Paths found not worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  let sweptAt: number | null = null;

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  /** The session folders in a project folder, listed again when its time moved or a sweep is due. */
  async function sessionsIn(dir: string, sweep: boolean): Promise<string[]> {
    const known = projects.get(dir);
    const folder = await infoOf(dir);
    if (folder === null) return known?.sessions ?? [];
    // A link at a project folder's name is not followed.
    if (folder.kind !== "directory") {
      projects.delete(dir);
      return [];
    }
    if (!sweep && known?.mtimeMs === folder.mtimeMs) return known.sessions;
    try {
      const names = (await io.readdir(dir)).filter((name) => !FLAT_FILE.test(name)).sort();
      const listed = names.map((name) => path.join(dir, name));
      projects.set(dir, { mtimeMs: folder.mtimeMs, sessions: listed });
      return listed;
    } catch {
      return known?.sessions ?? [];
    }
  }

  /**
   * What a session folder holds, from its names, listed when new, pending or
   * at a sweep; and whether it was looked up with `lstat` for it.
   */
  async function choiceIn(
    dir: string,
    sweep: boolean,
    now: number,
  ): Promise<{ choice: Choice; looked: boolean }> {
    const known = sessions.get(dir);
    if (known !== undefined && !sweep && !pending.has(dir)) {
      return { choice: known.choice, looked: false };
    }
    const folder = await infoOf(dir);
    if (folder?.kind !== "directory") {
      sessions.delete(dir);
      pending.delete(dir);
      return { choice: { kind: "none" }, looked: true };
    }
    // A folder that held no log is listed again only while it was changed in the last day.
    if (known !== undefined && !sweep && !isWithinRetention(Math.floor(folder.mtimeMs), now)) {
      return { choice: known.choice, looked: true };
    }
    let choice: Choice;
    try {
      choice = chooseLog(await io.readdir(dir));
    } catch {
      return { choice: known?.choice ?? { kind: "none" }, looked: true };
    }
    sessions.set(dir, { choice });
    if (choice.kind === "none") pending.add(dir);
    else pending.delete(dir);
    return { choice, looked: true };
  }

  /** A file's `lstat`, when it is a file written to in the last day; else it is passed over. */
  async function recent(file: string, now: number): Promise<FileInfo | null> {
    const info = await infoOf(file);
    if (info?.kind !== "file") return null;
    if (isWithinRetention(Math.floor(info.mtimeMs), now)) return info;
    passedOver.add(file);
    return null;
  }

  return {
    async find(now) {
      const here = await io.stat(sessionsDir);
      if (here.kind !== "directory") throw new NotAFolderError("Not a folder.");
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      const sweep = since === null || since < 0 || since >= sweepMs;
      if (sweep) {
        sweptAt = now;
        passedOver = new Set();
      }
      if (sweep || root?.mtimeMs !== here.mtimeMs) {
        root = { mtimeMs: here.mtimeMs, names: (await io.readdir(sessionsDir)).sort() };
      }

      const seenProjects = new Set<string>();
      const seenSessions = new Set<string>();
      const found: FoundLogs = { logs: [], newer: [], older: 0, compressed: 0 };
      for (const name of root.names) {
        const project = path.join(sessionsDir, name);
        seenProjects.add(project);
        for (const folder of await sessionsIn(project, sweep)) {
          seenSessions.add(folder);
          const { choice, looked } = await choiceIn(folder, sweep, now);
          if (choice.kind === "none") continue;
          const file = path.join(folder, choice.name);
          if (passedOver.has(file)) continue;
          // A link put at a session folder's name since it was listed is not gone into.
          if (!looked && (await infoOf(folder))?.kind !== "directory") {
            sessions.delete(folder);
            continue;
          }
          const info = await recent(file, now);
          if (info === null) continue;
          if (choice.kind === "older") found.older += 1;
          else if (choice.kind === "newer") {
            const current = choice.current === null ? null : path.join(folder, choice.current);
            found.newer.push({ folder, current, info });
          } else if (choice.zstd && !readsCompressed) found.compressed += 1;
          else found.logs.push({ folder, path: file, zstd: choice.zstd, info });
        }
      }
      for (const dir of projects.keys()) if (!seenProjects.has(dir)) projects.delete(dir);
      for (const dir of sessions.keys()) {
        if (!seenSessions.has(dir)) {
          sessions.delete(dir);
          pending.delete(dir);
        }
      }

      found.logs.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.path.localeCompare(b.path));
      for (const ref of found.logs.slice(MAX_LOGS)) passedOver.add(ref.path);
      found.logs = found.logs.slice(0, MAX_LOGS);
      return found;
    },

    forget() {
      root = null;
      projects.clear();
      sessions.clear();
      pending.clear();
      passedOver = new Set();
      sweptAt = null;
    },
  };
}
