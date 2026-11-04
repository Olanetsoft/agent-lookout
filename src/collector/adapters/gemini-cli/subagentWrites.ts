import path from "node:path";

import { plausibleTime } from "../../../core/time.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { CHATS_DIR, CHATS_REFRESH_MS } from "./chats.ts";

/**
 * When a session's subagents last wrote, from the modified times of their
 * files, without opening any of them.
 *
 * A subagent writes to a file of its own,
 * `tmp/<project>/chats/<parent session id>/<agent id>.jsonl`, while the session
 * that started it waits and writes nothing to its own file
 * (packages/core/src/services/chatRecordingService.ts at v0.64.0). The folders
 * go no deeper: a subagent is given no tool that starts another, and any
 * agent's file is kept under the id of the main session
 * (`registerToolInstance` and `executionContext` in
 * packages/core/src/agents/local-executor.ts).
 *
 * Only the folders of the sessions a poll lists are looked at. A folder is
 * listed when its session comes onto the list, and after that only when its
 * own modified time moves, as it does when a subagent starts, or at least every
 * 30 seconds, and up to `SUBAGENT_FILES_LIMIT` of its files are looked at with
 * `lstat` then. Between listings, only the `SUBAGENT_FILES_WATCHED` written to
 * last are looked at again: Gemini CLI adds to a file without moving its
 * folder's time, and every line it adds moves the file's. A session that
 * started no subagent has no folder, which costs one `lstat` a poll. The names
 * kept of a folder go at the first poll that does not list its session.
 */

/** A subagent's file. Any other ending does not match, so a `.tmp-<pid>` a rewrite left is passed over. */
export const SUBAGENT_FILE_NAME = /^[A-Za-z0-9_-]{1,200}\.jsonl$/;

/** The most files of one folder looked at each time it is listed, so that one folder's cost has a limit. */
export const SUBAGENT_FILES_LIMIT = 1_000;

/** The most files of one folder looked at between listings. A write to any other is seen at the next listing. */
export const SUBAGENT_FILES_WATCHED = 16;

/**
 * The folder that holds a session's subagents' files. Gemini CLI's own name for
 * it is its id with any other character than a letter, a digit, `_` or `-` made
 * `_`, and an id this adapter accepts holds no other (`SESSION_ID` in
 * `chatFile.ts`), so the id is the folder's name, and never names another folder.
 */
export function subagentFolder(projectDir: string, sessionId: string): string {
  return path.join(projectDir, CHATS_DIR, sessionId);
}

interface Listed {
  listedAt: number;
  mtimeMs: number;
  /** The files looked at until the next listing, those written to last first. */
  names: string[];
}

/** A subagent's file, with when it was last written. */
interface Written {
  name: string;
  at: number;
}

export interface SubagentWrites {
  /**
   * When anything in each of these folders was last written, by the folder.
   * A folder with no file whose time could be right has no entry. What is kept
   * of a folder not among them is forgotten, so every folder is given in one call.
   */
  newest(dirs: readonly string[], now: number): Promise<Map<string, number>>;
  /** Forgets what is kept of every folder, for a poll that lists no session. */
  forget(): void;
  /** How many folders it keeps the names of files for. */
  readonly size: number;
}

export interface SubagentWritesOptions {
  io: ReadOnlyIo;
  refreshMs?: number;
}

export function createSubagentWrites(options: SubagentWritesOptions): SubagentWrites {
  const { io } = options;
  const refreshMs = options.refreshMs ?? CHATS_REFRESH_MS;
  /** Which files of each folder to look at, as of its last listing, by the folder. */
  const listed = new Map<string, Listed>();

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  async function namesIn(dir: string): Promise<string[] | null> {
    try {
      const names = (await io.readdir(dir)).filter((name) => SUBAGENT_FILE_NAME.test(name));
      return names.sort().slice(0, SUBAGENT_FILES_LIMIT);
    } catch {
      return null;
    }
  }

  async function writesOf(dir: string, names: readonly string[], now: number): Promise<Written[]> {
    const writes: Written[] = [];
    for (const name of names) {
      const info = await infoOf(path.join(dir, name));
      // A link, a pipe, a device or a folder is not a subagent's file, whatever it is called.
      if (info?.kind !== "file") continue;
      // The system gives the time with a fraction of a millisecond. A time that
      // could not be right is left out, so that it cannot hide the others.
      const at = plausibleTime(Math.floor(info.mtimeMs), now);
      if (at !== null) writes.push({ name, at });
    }
    return writes;
  }

  return {
    async newest(dirs, now) {
      const newest = new Map<string, number>();
      const asked = new Set(dirs);

      for (const dir of asked) {
        const folder = await infoOf(dir);
        // A session that started no subagent has no folder, which is no error.
        // A link in its place is not followed.
        if (folder?.kind !== "directory") {
          listed.delete(dir);
          continue;
        }
        const known = listed.get(dir);
        const since = now - (known?.listedAt ?? now);
        // A clock set back counts as time enough.
        const fresh =
          known === undefined ||
          since < 0 ||
          since >= refreshMs ||
          folder.mtimeMs !== known.mtimeMs;
        const names = fresh ? await namesIn(dir) : known.names;
        if (names === null) {
          listed.delete(dir);
          continue;
        }
        const writes = await writesOf(dir, names, now);
        if (fresh) {
          const lastFirst = writes.sort((a, b) => b.at - a.at);
          listed.set(dir, {
            listedAt: now,
            mtimeMs: folder.mtimeMs,
            names: lastFirst.slice(0, SUBAGENT_FILES_WATCHED).map(({ name }) => name),
          });
        }
        if (writes.length > 0) newest.set(dir, Math.max(...writes.map(({ at }) => at)));
      }
      for (const dir of listed.keys()) if (!asked.has(dir)) listed.delete(dir);
      return newest;
    },
    forget() {
      listed.clear();
    },
    get size() {
      return listed.size;
    },
  };
}
