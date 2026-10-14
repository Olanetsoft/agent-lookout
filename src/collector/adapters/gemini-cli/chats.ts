import path from "node:path";

import { FINISHED_RETENTION_MS } from "../../../core/sessions/retention.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import type { Project } from "./projects.ts";

/**
 * Finding each project's session files, without opening any of them.
 *
 * Gemini CLI 0.39 and later writes a session to
 * `tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of its id>.jsonl`,
 * and an imported one to `session-<epoch ms>-<id>.jsonl`. A subagent's file
 * is in a folder of its parent session's, which is not looked into. A
 * rewrite that fails can leave `.jsonl.tmp-<pid>` or `.jsonl.unreadable-<time>`
 * beside a file, and those are passed over. Versions before 0.39 wrote
 * `session-<…>.json`, a format this adapter does not read: those are only
 * counted, for the note on the Sources card, never opened
 * (packages/core/src/services/chatRecordingService.ts at v0.64.0).
 *
 * A folder holds up to 30 days of sessions, so it is listed again only when
 * its own modified time moves, as it does when Gemini CLI adds a file, or at
 * least every 30 seconds. Every file is looked at with `lstat` then. Between
 * listings, only the files written to in the last day are looked at again:
 * Gemini CLI adds to a file without moving its folder's time, and every line
 * it adds moves the file's.
 */

/** A session file this adapter reads. Any other ending does not match. */
export const SESSION_FILE_NAME = /^session-[A-Za-z0-9_-]{1,200}\.jsonl$/;

/** A session file of Gemini CLI before 0.39, which is counted and never opened. */
export const OLDER_SESSION_FILE_NAME = /^session-[A-Za-z0-9_-]{1,200}\.json$/;

/** The folder in a project's folder that holds its session files. */
export const CHATS_DIR = "chats";

/** How often, at most, a folder of session files is listed again when its own modified time has not moved. */
export const CHATS_REFRESH_MS = 30_000;

/** A session file, with what a `lstat` of it said this poll. */
export interface ChatRef {
  path: string;
  /** The project folder it is in. */
  project: Project;
  info: FileInfo;
}

/** What a look at every project's session files found. */
export interface ChatListing {
  /** The session files written to in the last day. */
  refs: ChatRef[];
  /** How many files in the format of Gemini CLI before 0.39 changed in the last day. */
  older: number;
}

interface Listed {
  listedAt: number;
  mtimeMs: number;
  /** The session files' names. */
  names: string[];
  /** The names not written to in the last day when they were last looked at, passed over until the next listing. */
  old: Set<string>;
  older: number;
}

export interface ChatLister {
  /** The session files of these projects written to in the last day. */
  recent(projects: readonly Project[], now: number): Promise<ChatListing>;
}

export interface ChatListerOptions {
  io: ReadOnlyIo;
  refreshMs?: number;
}

export function createChatLister(options: ChatListerOptions): ChatLister {
  const { io } = options;
  const refreshMs = options.refreshMs ?? CHATS_REFRESH_MS;
  /** What each folder of session files held when it was last listed, by the folder. */
  const listed = new Map<string, Listed>();

  async function infoOf(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  async function listAgain(dir: string, mtimeMs: number, now: number): Promise<Listed | null> {
    let names: string[];
    try {
      names = (await io.readdir(dir)).sort();
    } catch {
      return null;
    }
    const cutoff = now - FINISHED_RETENTION_MS;
    let older = 0;
    for (const name of names) {
      if (!OLDER_SESSION_FILE_NAME.test(name)) continue;
      const info = await infoOf(path.join(dir, name));
      if (info?.kind === "file" && info.mtimeMs >= cutoff) older += 1;
    }
    return {
      listedAt: now,
      mtimeMs,
      names: names.filter((name) => SESSION_FILE_NAME.test(name)),
      old: new Set(),
      older,
    };
  }

  return {
    async recent(projects, now) {
      const cutoff = now - FINISHED_RETENTION_MS;
      const refs: ChatRef[] = [];
      let older = 0;
      const seen = new Set<string>();

      for (const project of projects) {
        const dir = path.join(project.dir, CHATS_DIR);
        seen.add(dir);
        const folder = await infoOf(dir);
        // A project with no sessions yet has no folder for them, which is no error.
        if (folder?.kind !== "directory") {
          listed.delete(dir);
          continue;
        }
        let known = listed.get(dir) ?? null;
        const since = known === null ? null : now - known.listedAt;
        // A clock set back counts as time enough.
        const fresh =
          known === null ||
          since === null ||
          since < 0 ||
          since >= refreshMs ||
          folder.mtimeMs !== known.mtimeMs;
        if (fresh) {
          known = await listAgain(dir, folder.mtimeMs, now);
          if (known === null) {
            listed.delete(dir);
            continue;
          }
          listed.set(dir, known);
        }
        if (known === null) continue;
        older += known.older;

        for (const name of known.names) {
          if (!fresh && known.old.has(name)) continue;
          const file = path.join(dir, name);
          const info = await infoOf(file);
          // A link, a pipe or a device is not a session file, whatever it is called.
          if (info === null || info.kind !== "file") continue;
          // A file not written to for a day is old news, and is not opened.
          if (info.mtimeMs < cutoff) {
            known.old.add(name);
            continue;
          }
          known.old.delete(name);
          refs.push({ path: file, project, info });
        }
      }
      for (const dir of listed.keys()) if (!seen.has(dir)) listed.delete(dir);
      return { refs, older };
    },
  };
}
