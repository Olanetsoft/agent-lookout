import path from "node:path";

import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { MAX_SESSIONS, SWEEP_MS } from "../pi/sessionFiles.ts";

/**
 * Finding Copilot CLI's sessions, without opening any of their files. Built
 * from GitHub's docs, the MIT Copilot SDK v2.0.1 and open-source readers,
 * never checked on a computer running Copilot CLI.
 *
 * Copilot keeps each session in a folder of its own in `session-state/`,
 * named by the session's ID, with its event log, `events.jsonl`, in it
 * (GitHub's config-directory reference, and the SDK's persistence guide).
 * Copilot first writes a session to disk when it handles its first message,
 * so a folder can exist with no log for a while. So on each poll:
 *
 * - `session-state/` is looked up with `lstat`, and listed again when its
 *   modified time moved, as it does when a session's folder is made, or a
 *   sweep is due. It must be a real folder: a link there is not followed.
 * - Only names that are a lowercase UUID are taken. The older flat
 *   `<id>.jsonl` files, dot names such as `.session-operation-locks/`, and the
 *   folders of sessions the SDK named itself are never looked up.
 * - Each session folder not passed over is looked up with `lstat`, and must be
 *   a real folder, and its `events.jsonl` with `lstat`, which must be an
 *   ordinary file. One whose log, or folder, was written in the last day, or
 *   one in `wanted`, is a session; any other is passed over until the next
 *   sweep. A process makes its lock in the folder as it opens a session,
 *   which moves the folder's time. A folder with no log yet is looked at
 *   again when its time moves, as it does when the log is made, while it was
 *   changed in the last day, and is passed over after that.
 * - Once a minute, a sweep lists `session-state/` again and looks up every
 *   session folder.
 * - The newest `MAX_SESSIONS` are taken, and every one in `wanted`: a session
 *   that was open or needed you at the last poll. The rest are passed over
 *   until the next sweep.
 *
 * Pi's limits of 200 sessions and a sweep once a minute are shared
 * (`../pi/sessionFiles.ts`). A link, or anything but a folder or an ordinary
 * file, is never gone into or taken.
 */

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The name of a session's event log in its folder. */
export const LOG_NAME = "events.jsonl";

/** Whether a name in `session-state/` is one Copilot gives a session's folder. */
export function isSessionFolderName(name: string): boolean {
  return SESSION.test(name);
}

/** A session found this poll, with what `lstat` said of its folder and its log. */
export interface SessionRef {
  /** The session folder's name: the session's ID. */
  id: string;
  folder: string;
  folderInfo: FileInfo;
  /** Its `events.jsonl`. */
  path: string;
  info: FileInfo;
}

export interface FoundSessions {
  /** The sessions to read, newest first, then by name. */
  refs: SessionRef[];
  /** Whether a link, or anything but a folder or an ordinary file, was met where one was looked for. */
  link: boolean;
}

/** `session-state/` is there, but it is a link or not a folder. */
export class NotAFolderError extends Error {}

export interface SessionFinder {
  /**
   * The sessions this poll, with `wanted`, the IDs of the sessions that were
   * open or needed you at the last poll. Rejects, with the error's `code`,
   * when `session-state/` is missing or cannot be listed, and with
   * `NotAFolderError` when it is not a real folder.
   */
  find(now: number, wanted: ReadonlySet<string>): Promise<FoundSessions>;
  /** Forgets everything, as for a folder that went. */
  forget(): void;
}

export interface SessionFinderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  sweepMs?: number;
  /** The most sessions read at once, `MAX_SESSIONS` unless a test says fewer. */
  maxSessions?: number;
}

/** The later of a log's modified time and its folder's. */
export const changedAtOf = (ref: Pick<SessionRef, "info" | "folderInfo">) =>
  Math.max(ref.info.mtimeMs, ref.folderInfo.mtimeMs);

export function createSessionFinder(options: SessionFinderOptions): SessionFinder {
  const { sessionsDir, io } = options;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  let listed: { mtimeMs: number; names: string[] } | null = null;
  /** Sessions found not worth a look, passed over until the next sweep. */
  let passedOver = new Set<string>();
  /** The folders found with no log, by their ID, with their modified time then. */
  let noLog = new Map<string, number>();
  let sweptAt: number | null = null;

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  return {
    async find(now, wanted) {
      const root = await io.lstat(sessionsDir);
      if (root.kind !== "directory") throw new NotAFolderError("Not a folder.");
      // A clock set back counts as time enough.
      const since = sweptAt === null ? null : now - sweptAt;
      const sweep = since === null || since < 0 || since >= sweepMs;
      if (sweep) {
        sweptAt = now;
        passedOver = new Set();
        noLog = new Map();
      }
      if (sweep || listed?.mtimeMs !== root.mtimeMs) {
        const names = (await io.readdir(sessionsDir)).filter(isSessionFolderName).sort();
        listed = { mtimeMs: root.mtimeMs, names };
      }

      let link = false;
      const candidates: SessionRef[] = [];
      for (const id of listed.names) {
        const want = wanted.has(id);
        if (!want && passedOver.has(id)) continue;
        const folder = path.join(sessionsDir, id);
        const folderInfo = await infoOf(folder);
        if (folderInfo?.kind !== "directory") {
          if (folderInfo?.kind === "other") link = true;
          continue;
        }
        // A folder with no log that has not changed since is not looked in again.
        if (!want && noLog.get(id) === folderInfo.mtimeMs) continue;
        const file = path.join(folder, LOG_NAME);
        const info = await infoOf(file);
        if (info?.kind !== "file") {
          if (info?.kind === "other") link = true;
          if (want) continue;
          if (isWithinRetention(Math.floor(folderInfo.mtimeMs), now)) {
            noLog.set(id, folderInfo.mtimeMs);
          } else {
            passedOver.add(id);
          }
          continue;
        }
        noLog.delete(id);
        const ref: SessionRef = { id, folder, folderInfo, path: file, info };
        if (!want && !isWithinRetention(Math.floor(changedAtOf(ref)), now)) {
          passedOver.add(id);
          continue;
        }
        candidates.push(ref);
      }

      candidates.sort(
        (a, b) => changedAtOf(b) - changedAtOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const refs: SessionRef[] = [];
      for (const [index, ref] of candidates.entries()) {
        if (index < maxSessions || wanted.has(ref.id)) refs.push(ref);
        else passedOver.add(ref.id);
      }
      return { refs, link };
    },

    forget() {
      listed = null;
      passedOver = new Set();
      noLog = new Map();
      sweptAt = null;
    },
  };
}
