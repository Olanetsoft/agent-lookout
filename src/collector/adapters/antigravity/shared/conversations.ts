import path from "node:path";

import { FINISHED_RETENTION_MS, isWithinRetention } from "../../../../core/sessions/retention.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import { createSubagentRecords } from "./subagents.ts";

/**
 * Finding the conversations of the Antigravity CLI, or the chats of
 * Antigravity 2.0, which keeps them the same way, by the names of two folders
 * and the modified times of three files each, and telling by names which of
 * them another conversation started (`subagents.ts`). No file is opened here.
 *
 * - `<agy folder>/brain/<conversation id>/` holds a conversation's transcript,
 *   `.system_generated/logs/transcript.jsonl`.
 * - `<agy folder>/conversations/<conversation id>.db` is the conversation's
 *   SQLite database, with its write-ahead log `<id>.db-wal` beside it. Neither
 *   is opened here: the CLI's adapter never opens them, and Antigravity 2.0's
 *   asks `sqlite3` for two numbers of the database alone (`../app/waits.ts`).
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
 * found. Its folder of records is looked at with it. The conversation that
 * started one looked at is looked at too, and all of them are when one is first
 * seen, since a conversation can outlive the one that started it.
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
  /** Where its database is. */
  database: string;
  /** What `lstat` said of the database, when it is an ordinary file. Null otherwise. */
  databaseInfo: FileInfo | null;
  /** Whether the database's write-ahead log, `<id>.db-wal`, is there. */
  logThere: boolean;
  /** The newest modified time of the transcript, the database and its log, in whole milliseconds. Null when none is there. */
  lastWriteAt: number | null;
  /** The conversations with a record of starting it, as a subagent or a swarm worker. */
  parents: readonly string[];
}

export type ConversationListing =
  | { state: "missing" }
  | { state: "unreadable" }
  | { state: "ok"; conversations: ConversationFiles[] };

export interface ConversationFinder {
  /**
   * Lists the conversations and looks at the files of those that matter this
   * poll, those another one started among them. `mayBeOpen` says which an agy
   * program may have open, as last worked out, so those are looked at whatever
   * their age.
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

  const records = createSubagentRecords({ brainDir, io });
  const known = new Map<string, ConversationFiles>();
  let oldCheckedAt: number | null = null;

  async function lookAt(id: string): Promise<ConversationFiles> {
    const transcript = path.join(brainDir, id, ...TRANSCRIPT_IN_FOLDER);
    const database = path.join(databaseDir, `${id}.db`);
    const infos = await Promise.all(
      [transcript, database, `${database}-wal`].map((file) => io.lstat(file).catch(() => null)),
    );
    const transcriptInfo = infos[0]?.kind === "file" ? infos[0] : null;
    const databaseInfo = infos[1]?.kind === "file" ? infos[1] : null;
    const writtenAt = transcriptInfo === null ? null : Math.floor(transcriptInfo.mtimeMs);
    let lastWriteAt: number | null = null;
    for (const info of infos) {
      if (info?.kind !== "file") continue;
      const at = Math.floor(info.mtimeMs);
      lastWriteAt = lastWriteAt === null ? at : Math.max(lastWriteAt, at);
    }
    return {
      id,
      transcript,
      transcriptInfo,
      writtenAt,
      database,
      databaseInfo,
      logThere: infos[2] !== null,
      lastWriteAt,
      parents: await records.parentsOf(id),
    };
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
      const inBrain = new Set(ids);
      for (const name of databases) {
        const id = conversationIdOfDatabase(name);
        if (id !== null) ids.add(id);
      }
      for (const id of known.keys()) {
        if (!ids.has(id)) known.delete(id);
      }

      // A clock set back counts as time enough.
      const since = oldCheckedAt === null ? Infinity : checkedAt - oldCheckedAt;
      const refreshOld =
        since < 0 || since >= oldRefreshMs || [...ids].some((id) => !known.has(id));
      if (refreshOld) oldCheckedAt = checkedAt;

      const cutoff = checkedAt - FINISHED_RETENTION_MS;
      const due = new Set(
        [...ids].filter((id) => {
          const lastWriteAt = known.get(id)?.lastWriteAt ?? null;
          return refreshOld || (lastWriteAt !== null && lastWriteAt >= cutoff) || mayBeOpen(id);
        }),
      );
      records.keepOnly(inBrain);
      // Those that started each too: a row can be shown for what a child writes
      // (`rowsOf`), and no record is looked up in a folder not looked at first.
      for (const id of due) for (const parent of records.namedIn(id)) due.add(parent);
      // The records first, so that a conversation seen for the first time is
      // told by them, whichever conversation started it and however old that is.
      await Promise.all(
        [...due].filter((id) => inBrain.has(id)).map((id) => records.look(id, checkedAt)),
      );
      await Promise.all([...due].map(async (id) => known.set(id, await lookAt(id))));

      const conversations = [...known.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      return { state: "ok", conversations };
    },
  };
}

/**
 * The conversations that have a row of their own, all but the children: those
 * whose records lead up to a conversation that none is kept of. Records that
 * lead only round to one another tell nothing. `own` are conversations no
 * record is counted of.
 *
 * What a child writes counts as a write of the transcript of the conversation
 * its records lead up to, when that has one, since the program that has that
 * one open is taken to run the child.
 */
export function rowsOf(
  conversations: readonly ConversationFiles[],
  own: ReadonlySet<string> = new Set(),
): ConversationFiles[] {
  const byId = new Map(conversations.map((files) => [files.id, files]));
  const parentsOf = (id: string) => (own.has(id) ? [] : (byId.get(id)?.parents ?? []));
  const rows: ConversationFiles[] = [];
  /** When the newest child of each was written. */
  const childWrites = new Map<string, number>();
  for (const { id, writtenAt } of conversations) {
    const above = new Set(parentsOf(id));
    for (const each of above) for (const next of parentsOf(each)) above.add(next);
    const top = [...above].filter((each) => byId.has(each) && parentsOf(each).length === 0);
    if (top.length === 0) rows.push(byId.get(id) as ConversationFiles);
    for (const each of top) {
      childWrites.set(each, Math.max(childWrites.get(each) ?? 0, writtenAt ?? 0));
    }
  }
  return rows.map((files) =>
    files.writtenAt === null
      ? files
      : { ...files, writtenAt: Math.max(files.writtenAt, childWrites.get(files.id) ?? 0) },
  );
}

/** Whether a conversation's transcript was written within the time a session that has ended stays listed. */
export function writtenRecently(files: ConversationFiles, now: number): boolean {
  return files.writtenAt !== null && isWithinRetention(files.writtenAt, now);
}
