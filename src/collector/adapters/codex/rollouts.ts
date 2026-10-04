import path from "node:path";

import type { CodexIo } from "./io.ts";

/**
 * Finding Codex's session files, which Codex calls rollouts, without opening
 * any of them.
 *
 * Codex writes each session to
 * `<codex home>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl`,
 * with the folder and the time in the name in local time, taken when the
 * session was created (codex-rs/rollout/src/recorder.rs). A reverted session
 * gets a second file, `rollout-<time>-<thread id>_<rollout id>.jsonl`, with the
 * same thread id. Files untouched for seven days are compressed to
 * `.jsonl.zst`, and archived sessions move to `<codex home>/archived_sessions`.
 * Neither is read: a compressed file has not been written for a week, and an
 * archived session is one the person put away.
 *
 * A resumed session goes on writing to its original file, which can sit in a
 * folder many days old. Listing every folder on every poll would cost more
 * than the rest of the poll together, so each poll lists only the folders for
 * today and yesterday, and a list of every folder is kept for finding the
 * sessions Codex says are open that those two do not hold.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A rollout file's name. `.jsonl.zst` and any other ending do not match. */
export const ROLLOUT_FILE_NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_(${UUID}))?\\.jsonl$`,
  "i",
);

/** How often, at most, every day folder is listed again while an open session has not been found. */
export const INDEX_REFRESH_MS = 30_000;

/**
 * How soon after the last listing a session Codex has only just opened may
 * cause another one. Sooner than the usual wait, so a resumed session shows
 * within a poll or two, but never on every poll.
 */
export const INDEX_PROMPT_REFRESH_MS = 5_000;

/** A rollout file, by path, with the thread it belongs to. */
export interface RolloutRef {
  path: string;
  /** In lowercase. */
  threadId: string;
}

/** The thread id in a rollout file's name, in lowercase, or null when the name is not a rollout's. */
export function threadIdOfRollout(name: string): string | null {
  const match = ROLLOUT_FILE_NAME.exec(name);
  return match?.[1] ? match[1].toLowerCase() : null;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The day folders a session written to in the last day can be in: the folders
 * for the local dates of `now` and of 24 hours before it. Codex names folders
 * by local date, so these are local too.
 */
export function recentDayFolders(sessionsDir: string, now: number): string[] {
  const folders = [now, now - 24 * 60 * 60 * 1000].map((at) => {
    const date = new Date(at);
    return path.join(
      sessionsDir,
      String(date.getFullYear()),
      twoDigits(date.getMonth() + 1),
      twoDigits(date.getDate()),
    );
  });
  return [...new Set(folders)];
}

const YEAR = /^\d{4}$/;
const MONTH_OR_DAY = /^\d{2}$/;

export interface RolloutFinder {
  /** The rollout files in today's and yesterday's folders. A folder that is not there holds none. */
  recent(now: number): Promise<RolloutRef[]>;
  /**
   * The rollout files of these threads, found in the list of every day folder.
   * The list is made again when a thread asked for is not in it: at once the
   * first time that thread is asked for, if the last listing is at least
   * `INDEX_PROMPT_REFRESH_MS` old, and otherwise at most every `INDEX_REFRESH_MS`.
   */
  locate(threadIds: readonly string[], now: number): Promise<RolloutRef[]>;
}

export interface RolloutFinderOptions {
  sessionsDir: string;
  io: CodexIo;
  refreshMs?: number;
  promptRefreshMs?: number;
}

export function createRolloutFinder(options: RolloutFinderOptions): RolloutFinder {
  const { sessionsDir, io } = options;
  const refreshMs = options.refreshMs ?? INDEX_REFRESH_MS;
  const promptRefreshMs = options.promptRefreshMs ?? INDEX_PROMPT_REFRESH_MS;

  /** Every rollout file in every day folder, by thread id. Null until first needed. */
  let index: Map<string, string[]> | null = null;
  let indexedAt = 0;
  /** The threads that were asked for and not found when the list was last made. */
  let notFound = new Set<string>();

  async function names(dir: string): Promise<string[]> {
    try {
      return await io.readdir(dir);
    } catch {
      return [];
    }
  }

  async function filesIn(dir: string): Promise<RolloutRef[]> {
    const refs: RolloutRef[] = [];
    for (const name of (await names(dir)).sort()) {
      const threadId = threadIdOfRollout(name);
      if (threadId !== null) refs.push({ path: path.join(dir, name), threadId });
    }
    return refs;
  }

  async function subfolders(dir: string, pattern: RegExp): Promise<string[]> {
    return (await names(dir))
      .filter((name) => pattern.test(name))
      .sort()
      .map((name) => path.join(dir, name));
  }

  /** Lists every day folder. Only folders are listed; no file is opened. */
  async function buildIndex(): Promise<Map<string, string[]>> {
    const years = await subfolders(sessionsDir, YEAR);
    const months = (await Promise.all(years.map((dir) => subfolders(dir, MONTH_OR_DAY)))).flat();
    const days = (await Promise.all(months.map((dir) => subfolders(dir, MONTH_OR_DAY)))).flat();
    const built = new Map<string, string[]>();
    for (const refs of await Promise.all(days.map(filesIn))) {
      for (const ref of refs) {
        const paths = built.get(ref.threadId);
        if (paths) paths.push(ref.path);
        else built.set(ref.threadId, [ref.path]);
      }
    }
    return built;
  }

  return {
    async recent(now) {
      const refs = await Promise.all(recentDayFolders(sessionsDir, now).map(filesIn));
      return refs.flat();
    },

    async locate(threadIds, now) {
      if (threadIds.length === 0) return [];
      const missing = threadIds.filter((id) => !index?.has(id));
      if (missing.length > 0) {
        const since = now - indexedAt;
        const askedFresh = missing.some((id) => !notFound.has(id));
        // A clock set back counts as time enough.
        const due =
          index === null ||
          since < 0 ||
          since >= refreshMs ||
          (askedFresh && since >= promptRefreshMs);
        if (due) {
          index = await buildIndex();
          indexedAt = now;
          notFound = new Set(missing.filter((id) => !index?.has(id)));
        }
      }
      return threadIds.flatMap((threadId) =>
        (index?.get(threadId) ?? []).map((file) => ({ path: file, threadId })),
      );
    },
  };
}
