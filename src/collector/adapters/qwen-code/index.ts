import os from "node:os";
import path from "node:path";

import { startQwenCodeFold } from "../../../core/mapping/qwen-code/qwenCodeMapping.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { lastMessageStoppedBy } from "../../messages/lastMessageSettings.ts";
import type { TailLimits } from "../../messages/tailReader.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createChatReader, type ChatState } from "./chatRecords.ts";
import { createFinishedSessions } from "./finishedSessions.ts";
import { createQwenCodeLastMessages } from "./lastMessages.ts";
import { oneForEachSession, readRegistry, SESSIONS_DIR, type RegistryEntry } from "./registry.ts";
import { leftBehindQwenCodeSession, qwenCodeSession, SOURCE_ID } from "./toSession.ts";
import { createChatFinder, PROJECTS_DIR } from "./transcriptFile.ts";

/** The variable that replaces Qwen Code's folders, for Agent Lookout alone. */
export const QWEN_CODE_HOME_ENV = "AGENT_LOOKOUT_QWEN_HOME";

/** Qwen Code's own variable for its folder, which holds its list of running sessions. */
export const QWEN_OWN_HOME_ENV = "QWEN_HOME";

/** Qwen Code's own variable for the folder its chat files are kept in. */
export const QWEN_OWN_RUNTIME_ENV = "QWEN_RUNTIME_DIR";

/** How long Qwen Code's folders, not there, are taken to be still missing before they are looked for again. */
export const RECHECK_MS = 60_000;

/** How long a session may have no chat file before the Sources view says so. */
export const NO_CHAT_AFTER_MS = 10 * 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Qwen Code";

/** Said whenever Qwen Code is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "Qwen Code does not record approval waits in its files, so a Qwen Code session that is waiting for you shows as working.";

/** Said whenever Qwen Code is watched, until Agent Lookout has been checked against it. */
export const UNCHECKED_NOTE =
  "This was built from Qwen Code's source at 0.25.1 and has not yet been checked on a machine running it, so a status can be wrong.";

/** Said when there are chat files and no list of running sessions. */
export const OLDER_QWEN_NOTE =
  "Qwen Code 0.21.14 or later lists its running sessions where Agent Lookout reads them. No list was found, so no session is shown.";

/** Said when a session has had no chat file for a while. */
export const NO_CHAT_NOTE =
  "A Qwen Code session has no chat file where Agent Lookout looks: its chats may be kept elsewhere or not recorded, so it shows as idle.";

/** Said when a record is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A Qwen Code newer than this Agent Lookout lists a session in a format it does not read, so that session is not shown.";

/** Said, on a Mac or Windows, when a record was written by a process on Linux. */
export const ELSEWHERE_NOTE =
  "A Qwen Code session that runs in a container is not listed: its process cannot be checked from here.";

/** Said when a session's status is unknown. */
export const UNKNOWN_NOTE =
  "A Qwen Code session shows as unknown while the end of its chat file says nothing Agent Lookout reads.";

/**
 * What a Qwen Code session can show, from the files this adapter reads. See
 * docs/adapters/qwen-code.md for each. Built from Qwen Code's source at
 * v0.25.1 and not yet checked on a machine running it.
 *
 * - Working and idle are the end of the chat file (`qwenCodeMapping.ts`), but
 *   a request that fails for good writes nothing that ends the turn, and
 *   neither does Esc while Qwen Code waits to retry or before its first
 *   request, nor, before 0.25.1, may Esc at any time.
 * - Needs you never: an approval prompt writes nothing to the files.
 * - Finished is a session Agent Lookout saw open whose process has gone, or
 *   let it go, as /clear and /resume do, and a record a crash left behind
 *   (`finishedSessions.ts`).
 * - Failed never: each failed try is recorded, but not when Qwen Code gives up.
 * - Its name is the title Qwen Code gives a session, which needs its fast
 *   model, or the one set with /rename.
 * - No Jump: the tmux and Terminal finders look for Claude Code's processes only.
 * - Quiet for is the chat file's own modified time, moved on by every line.
 * - No tokens yet: they are in the chat file, and not read.
 * - No Stop: Qwen Code records no start time for its process on a Mac or
 *   Windows, so the process cannot be confirmed before it is stopped.
 * - No Answer: there is no approval wait recorded to answer.
 */
export const QWEN_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "A request that fails for good, and some replies stopped with Esc, such as between retries, show as working until the next prompt.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Qwen Code does not record approval waits, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once its Qwen Code closes or moves on with /clear or /resume, if Agent Lookout saw it open or Qwen Code left its record behind.",
  },
  failed: {
    level: "no",
    reason:
      "Qwen Code records each failed try but not when it gives up, so a session whose request failed shows as working.",
  },
  names: {
    level: "partly",
    reason:
      "The title Qwen Code gives a session, or one set with /rename. Until then, or without its fast model, the folder's name.",
  },
  jump: {
    level: "no",
    reason:
      "Agent Lookout looks for tmux panes and Terminal tabs only for Claude Code sessions so far.",
  },
  "quiet-for": { level: "yes" },
  tokens: { level: "no", reason: "Agent Lookout does not read Qwen Code's token counts yet." },
  stop: {
    level: "no",
    reason:
      "Qwen Code records no process start time on a Mac or Windows, so its process cannot be confirmed before a stop.",
  },
  answer: {
    level: "no",
    reason:
      "Qwen Code records no approval waits, so there is nothing to answer from here, by hand or by a permission rule.",
  },
};

/** Where each of Qwen Code's two folders was named. */
type HomeFrom = "agent-lookout" | "qwen" | "default";

/** The two folders this adapter reads in, as Qwen Code works them out. */
export interface QwenFolders {
  /** Qwen Code's own folder, which holds `sessions/`, its list of running sessions. */
  home: string;
  /** The folder that holds `projects/`, its chat files: its own folder unless moved. */
  runtime: string;
  homeFrom: HomeFrom;
}

/** A setting's value, trimmed. Empty is none. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** A folder as Qwen Code reads one from a variable: `~` is the home folder, and a relative one is made absolute. */
function folderFrom(value: string, homeDir: string): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(
      path.join(
        homeDir,
        ...value
          .slice(2)
          .split(/[/\\]+/)
          .filter(Boolean),
      ),
    );
  }
  return path.resolve(value);
}

/**
 * The folders Qwen Code keeps its list of running sessions and its chat files
 * in. `AGENT_LOOKOUT_QWEN_HOME` names both at once, for Agent Lookout alone.
 * Otherwise they are Qwen Code's own: `QWEN_HOME`, or `~/.qwen`, for the list,
 * and `QWEN_RUNTIME_DIR`, or that same folder, for the chat files.
 */
export function qwenFolders(env: NodeJS.ProcessEnv, homeDir: string): QwenFolders {
  const own = setting(env, QWEN_CODE_HOME_ENV);
  if (own !== undefined) {
    const folder = folderFrom(own, homeDir);
    return { home: folder, runtime: folder, homeFrom: "agent-lookout" };
  }
  const qwenHome = setting(env, QWEN_OWN_HOME_ENV);
  const home =
    qwenHome !== undefined ? folderFrom(qwenHome, homeDir) : path.resolve(homeDir, ".qwen");
  const runtime = setting(env, QWEN_OWN_RUNTIME_ENV);
  return {
    home,
    runtime: runtime !== undefined ? folderFrom(runtime, homeDir) : home,
    homeFrom: qwenHome !== undefined ? "qwen" : "default",
  };
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface QwenCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folder names and process ids. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long missing folders are believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, every folder in `projects` is looked in for one session's chat file. */
  rescanMs?: number;
  /**
   * The limits its reader of last messages shares with the other agents'
   * readers. The collector passes one for them all. Left out, it has its own.
   */
  lastMessageLimits?: TailLimits;
}

/** The Qwen Code adapter, which reads what its sessions last said when asked. */
export interface QwenCodeAdapter extends Adapter {
  lastMessage: NonNullable<Adapter["lastMessage"]>;
  /**
   * How many sessions it keeps a last message for, in memory. For the tests
   * that check none is kept once its session has left the list.
   */
  readonly lastMessagesKept: number;
}

/**
 * Finds Qwen Code sessions on this machine from the files Qwen Code keeps,
 * with nothing installed, no setting changed and no program run. Built from
 * Qwen Code's source at v0.25.1 and not yet checked on a machine running it.
 *
 * It reads two things, both read-only:
 *
 * - The list of running sessions, `<qwen home>/sessions/`, which Qwen Code
 *   documents for other programs to read: one small file for each open
 *   session, with its process's id, its folder and when it began
 *   (`registry.ts`). Only Qwen Code in a terminal is listed: a session an
 *   editor or Qwen Code's own server drives is left out.
 * - Each listed session's chat file,
 *   `<runtime>/projects/<folder>/chats/<id>.jsonl`, read only as far as it
 *   grew since the last poll (`chatRecords.ts`), for its status and title.
 *
 * What a session last said is read from the end of the chat file the adapter
 * last found for it, but only when `lastMessage` is asked for it, which the
 * route does while a page has the session's details open, and only for a
 * session the last poll listed (`lastMessages.ts`). No poll reads it, and it
 * is never put on a session. `AGENT_LOOKOUT_LAST_MESSAGE=off` stops it, and so
 * does `AGENT_LOOKOUT_WAITING_TEXT=off`, which says no transcript is read.
 *
 * Whether a session's process runs is asked with signal 0, which sends
 * nothing. A session whose process has gone, or whose record has gone or
 * names another session, shows as finished for 24 hours
 * (`finishedSessions.ts`). Its status is working, idle, finished or unknown,
 * never "needs-you": Qwen Code does not write approval waits to its files.
 *
 * Qwen Code not being installed costs nothing: when neither folder is there,
 * the adapter says so and looks again only once a minute, with two `stat`s.
 * Someone who sets `AGENT_LOOKOUT_QWEN_HOME` means that folder: if it holds
 * no sessions, that is an answer, not a missing Qwen Code.
 */
export function createQwenCodeAdapter(options: QwenCodeAdapterOptions = {}): QwenCodeAdapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const folders = qwenFolders(env, homeDir);
  const { homeFrom } = folders;
  const sessionsDir = path.join(folders.home, SESSIONS_DIR);
  const projectsDir = path.join(folders.runtime, PROJECTS_DIR);
  const homeName = tildify(folders.home, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const projectsName = tildify(projectsDir, homeDir);

  const finder = createChatFinder({ projectsDir, io, platform, rescanMs: options.rescanMs });
  const reader = createChatReader(io);
  const finished = createFinishedSessions();
  // What a session last said, read only when it is asked for. With either
  // setting off, no file is opened for it.
  const lastMessagesOff = lastMessageStoppedBy(env);
  const lastMessages =
    lastMessagesOff === null
      ? createQwenCodeLastMessages({ io, now, limits: options.lastMessageLimits })
      : null;
  /** What Sources says of the last-message read: when it reads the end of a chat file, or Off. */
  const lastMessageRead =
    lastMessagesOff === null ? "end of a session's chat file, while its details are open" : "Off";
  /**
   * The chat file each session the last poll that could list the sessions
   * listed was found at, by its id, or null for one with none: the only file
   * its last message is read from. A poll that could not list them leaves it
   * as it was, since a session shown as finished afterwards is still read from
   * the file found while it was open.
   */
  let listedFiles: ReadonlyMap<string, string | null> = new Map();
  /** The chat files this poll found, by session id, or null for an open session with none. */
  let foundFiles = new Map<string, string | null>();

  /** When the folders were last found missing. Null while they are there, or before the first look. */
  let absentAt: number | null = null;
  /** True once a folder has been seen, until the list of running sessions goes missing. */
  let seen = false;
  /** The records the last read parsed, by file name, for a record caught mid-write. */
  let parsed: ReadonlyMap<string, RegistryEntry> = new Map();
  /** The session each running process had at the last poll that read the list, and that poll's time, by pid. */
  let holders = new Map<number, { entry: RegistryEntry; seenAt: number }>();
  /** Which process /clear or /resume moved to each session, and when, as `qwenCodeSession` takes it, by session id. */
  const tookOver = new Map<string, { pid: number; at: number }>();

  function watching(read: string): SourceFact[] {
    return [
      { label: "Sessions folder", value: sessionsName },
      { label: "Chats folder", value: projectsName },
      { label: "Read", value: read },
      { label: "Last message read", value: lastMessageRead },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** Qwen Code is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const neither = `there is no ${sessionsName} or ${projectsName} folder`;
    const where =
      homeFrom === "qwen" ? `${QWEN_OWN_HOME_ENV} is set to ${homeName}, and ${neither}` : neither;
    return result(
      "unavailable",
      `Qwen Code was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** Whether a folder is there. Only one that is missing, or is not a folder, counts as not there. */
  async function folderIsThere(folder: string): Promise<boolean> {
    try {
      return (await io.stat(folder)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  async function isThere(): Promise<boolean> {
    return (await folderIsThere(sessionsDir)) || (await folderIsThere(projectsDir));
  }

  /** The chat file of an open session, read as far as it grew, or null when it has none. */
  async function chatOf(
    entry: RegistryEntry,
    checkedAt: number,
    read: Set<string>,
  ): Promise<{ chat: ChatState | null; writtenAt?: number; file?: string }> {
    const found = await finder.find(entry.sessionId, entry.cwd, checkedAt);
    if (found === null) return { chat: null };
    read.add(found.path);
    try {
      return {
        chat: await reader.read(found.path, found.info),
        writtenAt: found.info.mtimeMs,
        file: found.path,
      };
    } catch {
      // A chat file that cannot be read, and never could, says nothing that can be known.
      return {
        chat: { fold: startQwenCodeFold(false), firstAt: null },
        writtenAt: found.info.mtimeMs,
        file: found.path,
      };
    }
  }

  /**
   * The chat file of each session a poll listed, by id: the one this poll
   * found for an open session, or the one last found for a session shown as
   * finished, which this poll did not look for.
   */
  function filesOf(sessions: readonly Session[]): Map<string, string | null> {
    const files = new Map<string, string | null>();
    for (const { id } of sessions) {
      files.set(
        id,
        foundFiles.has(id) ? (foundFiles.get(id) ?? null) : (listedFiles.get(id) ?? null),
      );
    }
    return files;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // Missing folders are believed missing for a while, so a machine without
    // Qwen Code pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout") {
      if (absentAt !== null) {
        const since = checkedAt - absentAt;
        if (since >= 0 && since < recheckMs) return notFound(checkedAt);
      }
      if (!seen) {
        if (!(await isThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        absentAt = null;
        seen = true;
      }
    }

    const notes = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
    const registry = await readRegistry(sessionsDir, io, platform, parsed);
    if (!registry.readable) {
      if (!registry.missing) {
        return result(
          "error",
          `Qwen Code sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      parsed = new Map();
      // With no list, no session is open: those shown open have closed.
      if (homeFrom === "agent-lookout") {
        const closed = finished.update([], [], checkedAt);
        return result(
          "ok",
          `${QWEN_CODE_HOME_ENV} is set to ${homeName}, which has no sessions folder, so no Qwen Code sessions are listed. ${notes}`,
          "not found",
          checkedAt,
          closed,
        );
      }
      seen = false;
      if (!(await isThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      seen = true;
      const closed = finished.update([], [], checkedAt);
      return result(
        "ok",
        `Qwen Code keeps chat files in ${projectsName}, and no list of running sessions in ${sessionsName}. ${OLDER_QWEN_NOTE} ${notes}`,
        "not found",
        checkedAt,
        closed,
      );
    }
    parsed = registry.parsed;

    const read = new Set<string>();
    const open: Session[] = [];
    const gone: RegistryEntry[] = [];
    const held = new Map<number, { entry: RegistryEntry; seenAt: number }>();
    let noChat = false;
    for (const { entry, alive } of oneForEachSession(registry.entries, isAlive)) {
      if (!alive) {
        gone.push(entry);
        continue;
      }
      // /clear and /resume change the session a record names in place, and
      // keep when its process registered: the session is the process's only
      // since then, which was after the last poll that found the earlier one.
      const before = holders.get(entry.pid);
      if (
        before !== undefined &&
        before.entry.sessionId !== entry.sessionId &&
        before.entry.startedAt === entry.startedAt
      ) {
        tookOver.set(entry.sessionId, { pid: entry.pid, at: before.seenAt });
      }
      held.set(entry.pid, { entry, seenAt: checkedAt });
      const moved = tookOver.get(entry.sessionId);
      const tookOverAt = moved?.pid === entry.pid ? moved.at : undefined;
      const { chat, writtenAt, file } = await chatOf(entry, checkedAt, read);
      const registeredAt = plausibleTime(tookOverAt ?? entry.startedAt, checkedAt);
      if (chat === null && registeredAt !== null && checkedAt - registeredAt >= NO_CHAT_AFTER_MS) {
        noChat = true;
      }
      const session = qwenCodeSession({ entry, chat, writtenAt, tookOverAt, now: checkedAt });
      foundFiles.set(session.id, file ?? null);
      open.push(session);
    }
    holders = held;

    // Records a crash left behind are looked at once, when Agent Lookout starts.
    const leftBehind = finished.first
      ? await Promise.all(
          gone.map(async (entry) => {
            const found = await finder.likely(entry.sessionId, entry.cwd);
            const session = leftBehindQwenCodeSession(entry, found?.info.mtimeMs, checkedAt);
            foundFiles.set(session.id, found?.path ?? null);
            return session;
          }),
        )
      : [];
    const closed = finished.update(open, leftBehind, checkedAt);
    const listed = new Set(registry.entries.map((entry) => entry.sessionId));
    finder.keepOnly(listed);
    reader.keepOnly(read);
    for (const id of tookOver.keys()) if (!listed.has(id)) tookOver.delete(id);

    let detail = `Sessions are read from the list of running sessions Qwen Code keeps in ${sessionsName}, and each one's chat file in ${projectsName}. ${notes}`;
    if (noChat) detail += ` ${NO_CHAT_NOTE}`;
    if (open.some((session) => session.status === "unknown")) detail += ` ${UNKNOWN_NOTE}`;
    if (registry.newer > 0) detail += ` ${NEWER_FORMAT_NOTE}`;
    if (registry.elsewhere > 0) detail += ` ${ELSEWHERE_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, [...open, ...closed]);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: QWEN_CODE_CAPABILITIES,
    lookingIn: `Looking for Qwen Code sessions in ${sessionsName}.`,
    async poll() {
      foundFiles = new Map();
      try {
        const answer = await poll();
        // The sessions whose last message may be asked for until the next poll.
        // One that could not list them lists none, so none may be asked for,
        // but the files known for them stand for the next poll that can.
        const files = filesOf(answer.sessions);
        if (answer.health.state === "ok") listedFiles = files;
        lastMessages?.keep(files);
        return answer;
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace. It lists no
        // session, so no last message is kept either.
        lastMessages?.forget();
        return result(
          "error",
          "Something unexpected went wrong while reading Qwen Code sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
    async lastMessage(sessionId) {
      if (lastMessagesOff !== null) {
        return { message: null, reason: "off", setting: lastMessagesOff };
      }
      return lastMessages?.read(sessionId) ?? null;
    },
    get lastMessagesKept() {
      return lastMessages?.size ?? 0;
    },
  };
}
