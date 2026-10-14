import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Where a Qwen Code session's chat file is.
 *
 * It is `<runtime>/projects/<folder>/chats/<sessionId>.jsonl`, where the
 * folder is the session's folder with every character that is not a letter
 * or a digit made a `-`, after it is made lowercase on Windows: `/Users/a/b.c`
 * is kept in `-Users-a-b-c` (`sanitizeCwd` in Qwen Code's `utils/paths.ts`
 * at v0.25.1). The file is made when the session records its first line, so
 * a new session has none yet. Built from Qwen Code's source and not yet
 * checked on a machine running it.
 *
 * When the file is not in the folder named for the session's folder, every
 * folder in `projects` is looked in for it, at most once every 30 seconds for
 * each session. The files beside it, `<id>.runtime.json`, `<id>.worktree.json`,
 * `<id>.pr.json`, `<id>.ledger.jsonl` and `archive/`, and the folders beside
 * `chats`, `memory/` and `subagents/`, are never opened or listed.
 */

export const PROJECTS_DIR = "projects";

export const CHATS_DIR = "chats";

/** How often, at most, every folder in `projects` is looked in for one session's file. */
export const RESCAN_MS = 30_000;

/** A session id as Qwen Code's own rule allows one in a file's name. Nothing else is ever made part of a path. */
const SESSION_ID = /^[0-9a-fA-F-]{32,36}$/;

/** Whether a value is a session id that may name a chat file. */
export function isQwenSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/**
 * The folder Qwen Code keeps a session's chats in, named for the session's
 * folder. What it gives cannot name a folder above `projects`.
 */
export function projectFolderName(cwd: string, platform: NodeJS.Platform): string {
  return (platform === "win32" ? cwd.toLowerCase() : cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** A session's chat file, with what a `lstat` of it said this poll. */
export interface FoundChat {
  path: string;
  info: FileInfo;
}

export interface ChatFinder {
  /** The session's chat file, or null when it has none where Qwen Code keeps them. */
  find(sessionId: string, cwd: string | null, now: number): Promise<FoundChat | null>;
  /** What one `lstat` says of the file in the folder named for the session's folder, or null. */
  likely(sessionId: string, cwd: string | null): Promise<FileInfo | null>;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

export interface ChatFinderOptions {
  projectsDir: string;
  io: Pick<ReadOnlyIo, "readdir" | "lstat">;
  platform: NodeJS.Platform;
  rescanMs?: number;
}

export function createChatFinder(options: ChatFinderOptions): ChatFinder {
  const { projectsDir, io, platform } = options;
  const rescanMs = options.rescanMs ?? RESCAN_MS;
  /** The file each session was found at, and the folder it had then. */
  const known = new Map<string, { cwd: string | null; path: string }>();
  /** When every folder was last looked in for each session that had no file. */
  const looked = new Map<string, number>();

  /** The file's info when it is an ordinary file. A link is not one. */
  async function fileAt(file: string): Promise<FileInfo | null> {
    try {
      const info = await io.lstat(file);
      return info.kind === "file" ? info : null;
    } catch {
      return null;
    }
  }

  function likelyPath(sessionId: string, cwd: string | null): string | null {
    if (cwd === null || cwd === "") return null;
    return path.join(
      projectsDir,
      projectFolderName(cwd, platform),
      CHATS_DIR,
      `${sessionId}.jsonl`,
    );
  }

  return {
    async find(sessionId, cwd, now) {
      if (!isQwenSessionId(sessionId)) return null;
      const before = known.get(sessionId);
      if (before !== undefined) {
        // A session that moved with /cd is looked for again.
        if (before.cwd === cwd) {
          const info = await fileAt(before.path);
          if (info !== null) return { path: before.path, info };
        }
        known.delete(sessionId);
      }

      const likely = likelyPath(sessionId, cwd);
      if (likely !== null) {
        const info = await fileAt(likely);
        if (info !== null) {
          known.set(sessionId, { cwd, path: likely });
          looked.delete(sessionId);
          return { path: likely, info };
        }
      }

      // A clock set back counts as time enough.
      const last = looked.get(sessionId);
      if (last !== undefined && now - last >= 0 && now - last < rescanMs) return null;
      looked.set(sessionId, now);
      let folders: string[];
      try {
        folders = await io.readdir(projectsDir);
      } catch {
        return null;
      }
      const candidates = folders
        .filter((name) => name !== "" && !name.startsWith("."))
        .sort()
        .map((name) => path.join(projectsDir, name, CHATS_DIR, `${sessionId}.jsonl`));
      const infos = await Promise.all(candidates.map(fileAt));
      const index = infos.findIndex((info) => info !== null);
      const info = infos[index];
      const file = candidates[index];
      if (index === -1 || info == null || file === undefined) return null;
      known.set(sessionId, { cwd, path: file });
      looked.delete(sessionId);
      return { path: file, info };
    },
    async likely(sessionId, cwd) {
      if (!isQwenSessionId(sessionId)) return null;
      const file = likelyPath(sessionId, cwd);
      return file === null ? null : fileAt(file);
    },
    keepOnly(sessionIds) {
      for (const id of known.keys()) if (!sessionIds.has(id)) known.delete(id);
      for (const id of looked.keys()) if (!sessionIds.has(id)) looked.delete(id);
    },
  };
}
