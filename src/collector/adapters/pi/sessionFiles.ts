import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Finding Pi's session files, without opening any of them.
 *
 * Pi keeps each session in one file, `<project folder>/<time>_<id>.jsonl` in its
 * sessions folder, where a project folder is `--<folder, with / \ : as ->--`
 * (`getDefaultSessionDirPath` in `session-manager.ts`). When another sessions
 * folder is named, with `PI_CODING_AGENT_SESSION_DIR`, the files sit in it
 * directly, so both are looked for. `/import` keeps a file's own name, so any
 * name that ends in `.jsonl` counts, as it does for Pi's own list.
 *
 * Pi never removes a session by itself, so these folders can hold thousands. A
 * poll lists the sessions folder, looks up each project folder with one `lstat`,
 * and lists a project folder again only when its modified time moves, as it does
 * when Pi adds a file. Then it looks up each file not already known to be old.
 * Once a minute, a sweep lists and looks up everything, for an old session opened
 * again: Pi adds to a file without moving its folder's time. So a poll costs one
 * `lstat` for each project folder and each file written to in the last day, and a
 * file not written to for a day is not looked at again until the next sweep.
 */

/** How often every project folder is listed and every session file looked up. */
export const SWEEP_MS = 60_000;

/** The most sessions looked at, newest first. The others wait for the next sweep. */
export const MAX_SESSIONS = 200;

const SESSION_FILE_ENDING = ".jsonl";

/** A session file, with what a `lstat` of it said this poll. */
export interface SessionFileRef {
  path: string;
  info: FileInfo;
}

export function isSessionFileName(name: string): boolean {
  return name.endsWith(SESSION_FILE_ENDING) && name.length > SESSION_FILE_ENDING.length;
}

export function isProjectFolderName(name: string): boolean {
  return name.startsWith("--") && name.endsWith("--") && name.length >= 4;
}

interface Listed {
  mtimeMs: number;
  files: string[];
}

export interface SessionFileFinder {
  /**
   * The session files written to in the last day, newest first, at most
   * `MAX_SESSIONS`. Rejects, with the error's `code`, when the sessions folder
   * cannot be listed.
   */
  recent(now: number): Promise<SessionFileRef[]>;
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
  /** What each project folder held when it was last listed, by the folder. */
  const listed = new Map<string, Listed>();
  /** The files last found not to be worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  let sweptAt: number | null = null;

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  /**
   * The session files in a project folder, which is listed again only when it is
   * due. A look that fails says nothing of what the folder holds, so the last list
   * stands and no session in it seems to end. Its time is left as it was, so a
   * folder that has moved on is listed again by the next poll.
   */
  async function filesIn(dir: string, sweep: boolean): Promise<string[]> {
    const known = listed.get(dir);
    const folder = await infoOf(dir);
    if (folder === null) return known?.files ?? [];
    // A link at a folder's name is not followed: it would lead out of the sessions folder.
    if (folder.kind !== "directory") {
      listed.delete(dir);
      return [];
    }
    if (!sweep && known?.mtimeMs === folder.mtimeMs) return known.files;
    try {
      const files = (await io.readdir(dir))
        .filter(isSessionFileName)
        .sort()
        .map((name) => path.join(dir, name));
      listed.set(dir, { mtimeMs: folder.mtimeMs, files });
      return files;
    } catch {
      return known?.files ?? [];
    }
  }

  return {
    async recent(now) {
      const names = (await io.readdir(sessionsDir)).sort();
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      const sweep = since === null || since < 0 || since >= sweepMs;
      if (sweep) {
        sweptAt = now;
        passedOver = new Set();
      }

      const folders = names.filter(isProjectFolderName).map((name) => path.join(sessionsDir, name));
      const files = names.filter(isSessionFileName).map((name) => path.join(sessionsDir, name));
      for (const dir of folders) files.push(...(await filesIn(dir, sweep)));
      const here = new Set(folders);
      for (const dir of listed.keys()) if (!here.has(dir)) listed.delete(dir);

      const refs: SessionFileRef[] = [];
      for (const file of files) {
        if (passedOver.has(file)) continue;
        const info = await infoOf(file);
        // A link, a pipe or a device is not a session file, whatever it is called.
        if (info?.kind !== "file") continue;
        if (isWithinRetention(Math.floor(info.mtimeMs), now)) refs.push({ path: file, info });
        else passedOver.add(file);
      }
      refs.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || a.path.localeCompare(b.path));
      for (const ref of refs.slice(MAX_SESSIONS)) passedOver.add(ref.path);
      return refs.slice(0, MAX_SESSIONS);
    },

    forget() {
      listed.clear();
      passedOver = new Set();
      sweptAt = null;
    },
  };
}
