import path from "node:path";

import { plausibleTime } from "../../../core/time.ts";
import { isMissing, isRefused, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
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
 *
 * A folder or file that is not there is no failure: that is how a session with
 * no subagent looks. A look that fails for any other reason is counted, once a
 * session, so that Sources can say so, and tells nothing about the session's
 * subagents: the time stays the newest seen until a look can say otherwise. A
 * folder is tried again at each poll, and while it cannot be listed the files
 * looked at between listings go on being looked at. A file a listing could not
 * look at joins those files, up to `SUBAGENT_FILES_WATCHED` of them with the
 * ones already looked at first, so that what Sources says does not come and go
 * with the listings. When a listing could not look at more than that, one it
 * left out may be what was written last, so the time stands until a listing
 * has looked at them all.
 */

/** A subagent's file. Any other ending does not match, so a `.tmp-<pid>` a rewrite left is passed over. */
export const SUBAGENT_FILE_NAME = /^[A-Za-z0-9_-]{1,200}\.jsonl$/;

/** The most files of one folder looked at each time it is listed, so that one folder's cost has a limit. */
export const SUBAGENT_FILES_LIMIT = 1_000;

/**
 * The most files of one folder looked at between listings for their writes. A
 * write to any other is seen at the next listing. As many again are looked at
 * when a listing could not look at them.
 */
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

/**
 * Why a look at a subagent's folder or file told nothing: `refused` when the
 * system would not let this user look, `failed` for any other error. A folder
 * or file that is not there is neither.
 */
export type SubagentFailure = "refused" | "failed";

/** How many folders of one call a look told nothing about, by why. A folder counts once, as `refused` if any look at it was. */
export type SubagentsUnread = Record<SubagentFailure, number>;

/** What a call found, new at each call, so that nothing of a failure outlasts it. */
export interface SubagentLook {
  /**
   * When anything in each folder was last written, by the folder. A folder with
   * no file whose time could be right has no entry. While a look at a folder
   * tells nothing, its time is the newest seen, if that could still be right.
   */
  times: Map<string, number>;
  unread: SubagentsUnread;
}

function failureOf(error: unknown): SubagentFailure | null {
  if (isMissing(error)) return null;
  return isRefused(error) ? "refused" : "failed";
}

/** What one lookup gave: what it found, null when that is not there, and why it told nothing if it did not. */
interface Lookup<T> {
  found: T | null;
  failure: SubagentFailure | null;
}

async function lookUp<T>(ask: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { found: await ask(), failure: null };
  } catch (error) {
    return { found: null, failure: failureOf(error) };
  }
}

interface Listed {
  listedAt: number;
  mtimeMs: number;
  /** The files looked at until the next listing: those written to last first, then those it could not look at. */
  names: string[];
  /** Whether the listing left out of `names` a file it could not look at. */
  leftOut: boolean;
  /** The newest time last found in the folder, which a look that tells nothing leaves standing. */
  at: number | null;
}

/** A subagent's file, with when it was last written. */
interface Written {
  name: string;
  at: number;
}

/** What a look at some of a folder's files gave. */
interface FilesLook {
  writes: Written[];
  /** The names of the files a look told nothing about. */
  unread: string[];
  failure: SubagentFailure | null;
}

/** What a look at one folder gave: its time, and why any part of it told nothing. */
interface FolderLook {
  at: number | null;
  failure: SubagentFailure | null;
}

const NOTHING: FolderLook = { at: null, failure: null };

/**
 * Which of the files a listing could not look at to look at until the next.
 * Those already looked at come first, so that the file that led goes on being
 * looked at.
 */
function unreadToWatch(unread: readonly string[], known: Listed | undefined): string[] {
  const watched = known?.names.filter((name) => unread.includes(name)) ?? [];
  return [...new Set([...watched, ...unread])].slice(0, SUBAGENT_FILES_WATCHED);
}

export interface SubagentWrites {
  /**
   * Looks at each of these folders. What is kept of a folder not among them is
   * forgotten, so every folder is given in one call.
   */
  newest(dirs: readonly string[], now: number): Promise<SubagentLook>;
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

  async function namesIn(dir: string): Promise<string[]> {
    const names = (await io.readdir(dir)).filter((name) => SUBAGENT_FILE_NAME.test(name));
    return names.sort().slice(0, SUBAGENT_FILES_LIMIT);
  }

  async function writesOf(dir: string, names: readonly string[], now: number): Promise<FilesLook> {
    const writes: Written[] = [];
    const unread: string[] = [];
    let failure: SubagentFailure | null = null;
    for (const name of names) {
      const look = await lookUp(() => io.lstat(path.join(dir, name)));
      if (look.failure !== null) {
        unread.push(name);
        if (failure !== "refused") failure = look.failure;
      }
      // A link, a pipe, a device or a folder is not a subagent's file, whatever it is called.
      if (look.found?.kind !== "file") continue;
      // The system gives the time with a fraction of a millisecond. A time that
      // could not be right is left out, so that it cannot hide the others.
      const at = plausibleTime(Math.floor(look.found.mtimeMs), now);
      if (at !== null) writes.push({ name, at });
    }
    return { writes, unread, failure };
  }

  async function lookAt(dir: string, now: number): Promise<FolderLook> {
    const known = listed.get(dir);
    /** The time to stand by while a look tells nothing. What is kept of the folder stays too. */
    const held = plausibleTime(known?.at, now);

    const { found: folder, failure: folderFailure } = await lookUp(() => io.lstat(dir));
    if (folderFailure !== null) return { at: held, failure: folderFailure };
    // A session that started no subagent has no folder, which is no error.
    // A link in its place is not followed.
    if (folder?.kind !== "directory") {
      listed.delete(dir);
      return NOTHING;
    }
    const since = now - (known?.listedAt ?? now);
    // A clock set back counts as time enough.
    const fresh =
      known === undefined || since < 0 || since >= refreshMs || folder.mtimeMs !== known.mtimeMs;
    const listing: Lookup<string[]> = fresh
      ? await lookUp(() => namesIn(dir))
      : { found: known.names, failure: null };
    // It went between the two looks.
    if (listing.found === null && listing.failure === null) {
      listed.delete(dir);
      return NOTHING;
    }

    // A listing that failed leaves the files looked at until now to look at.
    const look = await writesOf(dir, listing.found ?? known?.names ?? [], now);
    const failure = look.failure === "refused" ? "refused" : (listing.failure ?? look.failure);
    const times = look.writes.map(({ at }) => at);
    // What could not be looked at may be what was written last, and so may a
    // file the last listing left out.
    if (held !== null && (failure !== null || (!fresh && known.leftOut))) times.push(held);
    const at = times.length > 0 ? Math.max(...times) : null;
    if (fresh && listing.found !== null) {
      const lastFirst = look.writes.sort((a, b) => b.at - a.at);
      listed.set(dir, {
        listedAt: now,
        mtimeMs: folder.mtimeMs,
        names: [
          ...lastFirst.slice(0, SUBAGENT_FILES_WATCHED).map(({ name }) => name),
          ...unreadToWatch(look.unread, known),
        ],
        leftOut: look.unread.length > SUBAGENT_FILES_WATCHED,
        at,
      });
    } else if (known !== undefined) {
      // After a failed listing its listing time stays as it was, so it is listed
      // again at the next look.
      listed.set(dir, { ...known, at });
    }
    return { at, failure };
  }

  return {
    async newest(dirs, now) {
      const times = new Map<string, number>();
      const unread: SubagentsUnread = { refused: 0, failed: 0 };
      const asked = new Set(dirs);

      for (const dir of asked) {
        const { at, failure } = await lookAt(dir, now);
        if (at !== null) times.set(dir, at);
        if (failure !== null) unread[failure] += 1;
      }
      for (const dir of listed.keys()) if (!asked.has(dir)) listed.delete(dir);
      return { times, unread };
    },
    forget() {
      listed.clear();
    },
    get size() {
      return listed.size;
    },
  };
}
