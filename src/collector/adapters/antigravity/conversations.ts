import path from "node:path";

import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../core/sessions/retention.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Finding the Antigravity CLI's conversations, by the names of two folders and
 * the modified times of three files each. No file is opened here.
 *
 * - `<agy folder>/brain/<conversation id>/` holds a conversation's transcript,
 *   `.system_generated/logs/transcript.jsonl`.
 * - `<agy folder>/conversations/<conversation id>.db` is the conversation's
 *   SQLite database, with its write-ahead log `<id>.db-wal` beside it. Neither
 *   is ever opened.
 *
 * Whether a conversation was written lately, and so may be open, is told by
 * its transcript's modified time alone. Only the program running a
 * conversation adds steps to its transcript, while its database is also
 * written at other times: agy flushes it as a program exits (changelog
 * 1.1.26), and has been seen to write it half a minute after the transcript.
 * The newest of all three times is kept for Quiet for, since agy may write the
 * database while a step runs, before it writes the step to the transcript.
 *
 * A conversation any of whose files changed in the last 24 hours, or one an
 * agy program may have open, is looked at on every poll. Every other one is
 * looked at again every 30 seconds, so a conversation resumed after a day is
 * found.
 */

export const BRAIN_DIR = "brain";
export const CONVERSATIONS_DIR = "conversations";

/** The transcript's place inside a conversation's folder under `brain/`. */
export const TRANSCRIPT_IN_FOLDER = [".system_generated", "logs", "transcript.jsonl"] as const;

/** How often the conversations not written for a day are looked at again. */
export const OLD_REFRESH_MS = 30_000;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FOLDER_NAME = new RegExp(`^(${UUID})$`, "i");
const DATABASE_NAME = new RegExp(`^(${UUID})\\.db(?:-wal)?$`, "i");

/** The conversation id a folder under `brain/` is named for, in lower case, or null for any other name. */
export function conversationIdOfFolder(name: string): string | null {
  return FOLDER_NAME.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** The conversation id a file in `conversations/` is named for, `<id>.db` or `<id>.db-wal`, or null. */
export function conversationIdOfDatabase(name: string): string | null {
  return DATABASE_NAME.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** One conversation's files, as last looked at. */
export interface ConversationFiles {
  id: string;
  /** Where its transcript is. */
  transcript: string;
  /** What `lstat` said of the transcript, when it is an ordinary file. Null otherwise. */
  transcriptInfo: FileInfo | null;
  /** When the transcript was last written, in whole milliseconds. Null when it is not an ordinary file. */
  writtenAt: number | null;
  /** The newest modified time of the transcript, the database and its log, in whole milliseconds. Null when none is there. */
  lastWriteAt: number | null;
}

export type ConversationListing =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; conversations: ConversationFiles[] };

export interface ConversationFinder {
  /**
   * Lists the conversations and looks at the files of those that matter this
   * poll. `mayBeOpen` says which an agy program may have open, as last worked
   * out, so those are looked at whatever their age.
   */
  list(checkedAt: number, mayBeOpen: (id: string) => boolean): Promise<ConversationListing>;
}

export function createConversationFinder(options: {
  home: string;
  io: ReadOnlyIo;
  oldRefreshMs?: number;
}): ConversationFinder {
  const { io } = options;
  const brainDir = path.join(options.home, BRAIN_DIR);
  const databaseDir = path.join(options.home, CONVERSATIONS_DIR);
  const oldRefreshMs = options.oldRefreshMs ?? OLD_REFRESH_MS;

  const known = new Map<string, ConversationFiles>();
  let oldCheckedAt: number | null = null;

  async function lookAt(id: string): Promise<ConversationFiles> {
    const transcript = path.join(brainDir, id, ...TRANSCRIPT_IN_FOLDER);
    const infos = await Promise.all(
      [transcript, path.join(databaseDir, `${id}.db`), path.join(databaseDir, `${id}.db-wal`)].map(
        (file) => io.lstat(file).catch(() => null),
      ),
    );
    const transcriptInfo = infos[0]?.kind === "file" ? infos[0] : null;
    const writtenAt = transcriptInfo === null ? null : Math.floor(transcriptInfo.mtimeMs);
    let lastWriteAt: number | null = null;
    for (const info of infos) {
      if (info?.kind !== "file") continue;
      const at = Math.floor(info.mtimeMs);
      lastWriteAt = lastWriteAt === null ? at : Math.max(lastWriteAt, at);
    }
    return { id, transcript, transcriptInfo, writtenAt, lastWriteAt };
  }

  return {
    async list(checkedAt, mayBeOpen) {
      let folders: string[];
      try {
        folders = await io.readdir(brainDir);
      } catch (error) {
        return { state: isMissing(error) ? "missing" : "unreadable" };
      }
      // The databases name conversations whose transcript may not be written yet.
      const databases = await io.readdir(databaseDir).catch(() => [] as string[]);

      const ids = new Set<string>();
      for (const name of folders) {
        const id = conversationIdOfFolder(name);
        if (id !== null) ids.add(id);
      }
      for (const name of databases) {
        const id = conversationIdOfDatabase(name);
        if (id !== null) ids.add(id);
      }
      for (const id of known.keys()) {
        if (!ids.has(id)) known.delete(id);
      }

      // A clock set back counts as time enough.
      const since = oldCheckedAt === null ? Infinity : checkedAt - oldCheckedAt;
      const refreshOld = since < 0 || since >= oldRefreshMs;
      if (refreshOld) oldCheckedAt = checkedAt;

      const cutoff = checkedAt - FINISHED_RETENTION_MS;
      await Promise.all(
        [...ids].map(async (id) => {
          const before = known.get(id);
          const recent =
            before === undefined ||
            (before.lastWriteAt !== null && before.lastWriteAt >= cutoff) ||
            mayBeOpen(id);
          if (recent || refreshOld) known.set(id, await lookAt(id));
        }),
      );

      const conversations = [...known.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      return { state: "ok", conversations };
    },
  };
}

/** Whether a conversation's transcript was written within the time a session that has ended stays listed. */
export function writtenRecently(files: ConversationFiles, now: number): boolean {
  return files.writtenAt !== null && isWithinRetention(files.writtenAt, now);
}
