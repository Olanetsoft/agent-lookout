import os from "node:os";

import {
  copilotCwdOf,
  type CopilotFold,
} from "../../../core/mapping/copilot-cli/copilotCliFold.ts";
import {
  copilotCliStatusOf,
  type CopilotCliWait,
} from "../../../core/mapping/copilot-cli/copilotCliMapping.ts";
import { continuedDeepseekHarnessWait } from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
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
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import {
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
  type StartMatch,
} from "../../processes/processStart.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { createRecordProcessCheck, type RecordProcess } from "../qwen-code/processCheck.ts";
import { every } from "../words.ts";
import { createEventsReader, type CopilotLog } from "./eventsReader.ts";
import { COPILOT_CLI_HOME_ENV, COPILOT_HOME_ENV, copilotCliHome } from "./home.ts";
import { createLockReader, type SessionLock } from "./locks.ts";
import {
  changedAtOf,
  createSessionFinder,
  NotAFolderError,
  type SessionRef,
} from "./sessionFolders.ts";
import { copilotCliId, copilotCliSession, SOURCE_ID } from "./toSession.ts";

export { COPILOT_CLI_HOME_ENV, COPILOT_HOME_ENV, copilotCliSessionsDirFor } from "./home.ts";
export { SOURCE_ID } from "./toSession.ts";

/**
 * The Copilot CLI adapter. Copilot CLI, `copilot`, is GitHub's terminal coding
 * agent, which keeps an event log for each session. See
 * docs/adapters/copilot-cli.md. Its own program is not open source, so this
 * was built from GitHub's docs, the MIT Copilot SDK v2.0.1 and open-source
 * readers of Copilot's files, not from Copilot's own program, and it has never
 * been checked on a computer running Copilot CLI.
 *
 * It reads Copilot's files alone: GitHub documents no listing of sessions an
 * outside program can run, and the SDK's own needs a running Copilot. It
 * shares Qwen Code's check of a listed process's start
 * (`../qwen-code/processCheck.ts`), Muse Code's walker of a line's bytes
 * (`../muse-code/jsonWalker.ts`), Autohand Code's decoder of one JSON string
 * and one time (`../autohand-code/jsonBytes.ts`), Pi's check of a folder
 * (`folder` in `../pi/sessionFile.ts`), Pi's limits of 200 sessions and a
 * sweep once a minute (`../pi/sessionFiles.ts`), and DeepSeek Harness's way of
 * keeping a wait across polls (`continuedDeepseekHarnessWait`).
 */

const LABEL = "Copilot CLI";

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

/** Said whenever Copilot CLI is watched: how working and idle are told. Each note is at most 130 characters. */
export const STATUS_NOTE =
  "A Copilot CLI session shows as working while a turn or a tool call runs, and as idle once its last turn asked for no tools.";
export const IDLE_NOTE =
  "It shows as idle too once Copilot accepts its task as complete. Copilot never writes that a session is idle.";

/** Said whenever Copilot CLI is watched: what needs you can and cannot show. */
export const NEEDS_YOU_NOTE =
  "It shows as needing you while a permission prompt has waited a second or more, or an ask_user question waits for your answer.";
export const UNWRITTEN_NOTE =
  "Plan approval, MCP prompts and sign-ins, auto-mode switches and limit prompts are never written, so none shows as needing you.";

/** Said whenever Copilot CLI is watched: how a session ends. */
export const ENDS_NOTE =
  "It shows as failed when Copilot writes that the session shut down on an error.";
export const FINISHED_NOTE =
  "It shows as finished when Copilot writes that it shut down, or once no process that holds the session's lock runs.";

/** Said whenever Copilot CLI is watched: whose sessions these are. */
export const OTHER_APPS_NOTE =
  "Copilot's app and VS Code's agent host keep their sessions in the same folder, so theirs show here too.";

/** Said whenever Copilot CLI is watched: what is left alone. */
export const READONLY_NOTE =
  "Agent Lookout reads the event logs and the locks' names alone, runs no Copilot program, and never opens workspace.yaml or a lock.";

/** Said whenever Copilot CLI is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from GitHub's docs, the MIT Copilot SDK v2.0.1 and open-source readers, not from Copilot CLI's own program.";
export const UNCHECKED_RUN_NOTE =
  "It has never been checked on a computer running Copilot CLI, so a status can be wrong.";

/** Said on a Mac, where `ps` is asked. */
export const MAC_LOCK_NOTE =
  "A lock counts while its process runs and started no later than a minute after the lock was made, by ps.";

/** Said on every other system, where signal 0 alone decides. */
export const SIGNAL_LOCK_NOTE =
  "Signal 0 alone decides whether a lock's process runs, so a crashed session can look open while another program has its ID.";

/** Said when this poll found it. */
export const UNREAD_NOTE =
  "Some Copilot CLI sessions hold a line Agent Lookout cannot read, perhaps from a newer Copilot, so they show as unknown.";
export const LOCKS_UNREAD_NOTE =
  "The folder of some Copilot CLI sessions could not be listed for their locks, so they show as unknown.";
export const PASSED_OVER_NOTE = `${COPILOT_HOME_ENV} is set to a folder that is not a whole path, so it is passed over and the default folder is read.`;
export const LINK_NOTE =
  "A link in the sessions folder, or at it, is not followed, so the sessions behind it are not read.";

/**
 * What a Copilot CLI session can show, from its event log and its locks. See
 * docs/adapters/copilot-cli.md for each. Built from GitHub's docs, the MIT
 * Copilot SDK v2.0.1 and open-source readers, never checked on a computer
 * running Copilot CLI.
 */
export const COPILOT_CLI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Idle is read from a last turn that asked for no tools, as Copilot never writes it. A wait it never writes can show as working.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "Permission prompts and ask_user questions only. Plan approval, MCP prompts and sign-ins, and limit prompts are never written.",
  },
  finished: {
    level: "partly",
    reason:
      "From its lock and that process. Off a Mac, signal 0 alone decides, so a crashed session can look open.",
  },
  failed: {
    level: "partly",
    reason:
      "When Copilot writes that the session shut down on an error. A crash writes nothing and shows as finished.",
  },
  names: {
    level: "partly",
    reason:
      "The working folder's. Copilot's own session name can be your first prompt, so it is never read.",
  },
  jump: {
    level: "no",
    reason: "Nothing Agent Lookout reads names a Copilot CLI session's terminal or window.",
  },
  "quiet-for": {
    level: "partly",
    reason:
      "The time since its event log was last written, while it works. A long command may write nothing.",
  },
  tokens: {
    level: "no",
    reason: "Copilot's counts are on lines Agent Lookout steps over without reading them.",
  },
  stop: {
    level: "no",
    reason: "A lock names a process that can hold other sessions too, so Agent Lookout stops none.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Copilot CLI, so it cannot send an answer.",
  },
};

/** The `ps` that says when a lock's process started, as a card names it. */
const START_PS = "ps -o pid=,lstart= -p <pids>";

/** Everything the adapter touches outside itself. Tests replace these. */
export interface CopilotCliAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folder names, and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session folder is looked up, and each one's locks listed. Defaults to a minute. */
  sweepMs?: number;
  /** The most sessions read at once. Defaults to 200. */
  maxSessions?: number;
  /**
   * Reads when processes started, to confirm on a Mac that the process with a
   * lock's ID started before the lock was made. Defaults to asking `ps`,
   * which is never asked on any other system.
   */
  readProcessStarts?: ReadProcessStarts;
}

/**
 * Finds Copilot CLI's sessions on this computer from the files Copilot keeps,
 * with nothing installed, no setting changed and no Copilot program run.
 *
 * Each poll finds the session folders in `session-state/` written in the last
 * day, at most 200, and every one open or needing you at the last poll
 * (`sessionFolders.ts`), reads each one's `events.jsonl` as far as it grew, as
 * bytes (`eventsReader.ts`, `records.ts`), and the names of the
 * `inuse.<pid>.lock` files in its folder when that changed (`locks.ts`).
 * Whether a lock's process runs is asked with signal 0, which sends nothing.
 * On a Mac, every 30 seconds and when a lock appears, `ps` is asked when that
 * process started, and one that started more than a minute after the lock
 * was made was given the ID since, as after a crash. On Linux a process's
 * start moves with the clock, and Windows has no `ps`, so signal 0 alone
 * decides there.
 *
 * Copilot CLI not being installed costs nothing: when its sessions folder is
 * missing, the adapter says so and looks again only once a minute. Someone
 * who sets `AGENT_LOOKOUT_COPILOT_HOME` means that folder: if it holds no
 * sessions, that is an answer, looked for again on every poll.
 */
export function createCopilotCliAdapter(options: CopilotCliAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const { home, sessionsDir, named, fromCopilotHome, passedOver } = copilotCliHome(
    env,
    homeDir,
    platform,
  );
  const homeName = tildify(home, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const finder = createSessionFinder({
    sessionsDir,
    io,
    sweepMs: options.sweepMs,
    maxSessions: options.maxSessions,
  });
  const reader = createEventsReader(io, platform);
  const lockReader = createLockReader(io, options.sweepMs);
  // On a Mac the start `ps` gives decides whether a lock's process is the one
  // that made it. Elsewhere signal 0 alone decides.
  const startCheck =
    platform === "darwin" ? createRecordProcessCheck(options.readProcessStarts, now) : null;

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** Each session's wait at the last poll, by its ID in the model, so a wait that goes on keeps its time. */
  let waits = new Map<string, CopilotCliWait>();
  /** The permission requests each session waited on at the last poll, by its folder's name. */
  let waited = new Map<string, Set<string>>();
  /** When each open permission request was first seen, by the session folder's name and the request's ID. */
  let seen = new Map<string, Map<string, number>>();
  /** The sessions open or needing you at the last poll, looked up however old. */
  let wanted = new Set<string>();

  const lockNote = startCheck !== null ? MAC_LOCK_NOTE : SIGNAL_LOCK_NOTE;
  const notes = [
    STATUS_NOTE,
    IDLE_NOTE,
    NEEDS_YOU_NOTE,
    UNWRITTEN_NOTE,
    ENDS_NOTE,
    FINISHED_NOTE,
    lockNote,
    OTHER_APPS_NOTE,
    READONLY_NOTE,
    UNCHECKED_NOTE,
    UNCHECKED_RUN_NOTE,
  ].join(" ");
  const passedOverNote = passedOver ? ` ${PASSED_OVER_NOTE}` : "";
  const processFacts: SourceFact[] =
    startCheck === null
      ? [{ label: "Process check", value: "signal 0 alone" }]
      : [
          { label: "Process check", value: START_PS },
          {
            label: "Process check run",
            value: `${every(START_CHECK_TTL_MS)} while a session's process runs, and sooner when another appears`,
          },
        ];

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
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        {
          label: "Event logs",
          value:
            "events.jsonl of each session, as bytes, only as far as it grew: at most 8 MiB, or its first 64 KiB and last 8 MiB. Only its working folder, times and IDs become text",
        },
        {
          label: "Locks",
          value: "the names of inuse.<pid>.lock in each session's folder, by lstat, never opened",
        },
        { label: "Process IDs", value: `signal 0, ${every(pollIntervalMs)}` },
        ...processFacts,
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** Copilot CLI is not on this computer, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const none = `there is no ${sessionsName} folder`;
    const where = fromCopilotHome ? `${COPILOT_HOME_ENV} is set to ${homeName}, and ${none}` : none;
    return result(
      "unavailable",
      `Copilot CLI was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.${passedOverNote}`,
      "not found",
      checkedAt,
    );
  }

  function forgetAll() {
    finder.forget();
    reader.keepOnly(new Set());
    lockReader.keepOnly(new Set());
    waits = new Map();
    waited = new Map();
    seen = new Map();
    wanted = new Set();
  }

  /** Whether each lock counts: its process runs, and on a Mac started no later than a minute after the lock was made. */
  async function countedLocks(all: readonly SessionLock[]): Promise<Set<SessionLock>> {
    const runs = new Map<number, boolean>();
    for (const lock of all) if (!runs.has(lock.pid)) runs.set(lock.pid, isAlive(lock.pid));
    const running = all.filter((lock) => runs.get(lock.pid) === true);
    if (startCheck === null) return new Set(running);
    const records = running.map((lock): { lock: SessionLock; record: RecordProcess } => ({
      lock,
      record: { pid: lock.pid, startedAt: Math.floor(lock.mtimeMs) },
    }));
    const matches: Map<RecordProcess, StartMatch> = await startCheck.matches(
      records.map(({ record }) => record),
    );
    return new Set(
      records.filter(({ record }) => matches.get(record) !== "different").map(({ lock }) => lock),
    );
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Copilot CLI is believed missing for a while, so a computer
    // without it pays nothing on most polls. A clock set back counts as time
    // enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let found: Awaited<ReturnType<typeof finder.find>>;
    try {
      found = await finder.find(checkedAt, wanted);
    } catch (error) {
      if (error instanceof NotAFolderError) {
        forgetAll();
        return result(
          "error",
          `Copilot CLI sessions could not be read: ${sessionsName} is not a folder. ${LINK_NOTE}`,
          "cannot be read",
          checkedAt,
        );
      }
      if (!isMissing(error)) {
        return result(
          "error",
          `Copilot CLI sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      forgetAll();
      if (named) {
        return result(
          "ok",
          `${COPILOT_CLI_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Copilot CLI sessions are listed. ${notes}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const read: {
      ref: SessionRef;
      log: CopilotLog;
      fold: CopilotFold;
      locks: SessionLock[] | null;
    }[] = [];
    for (const ref of found.refs) {
      const log = await reader.read(ref);
      if (log.fold === null) continue;
      const locks = await lockReader.locks(ref.folder, ref.folderInfo, checkedAt);
      read.push({ ref, log, fold: log.fold, locks });
    }
    reader.keepOnly(new Set(found.refs.map((ref) => ref.path)));
    lockReader.keepOnly(new Set(found.refs.map((ref) => ref.folder)));
    const counted = await countedLocks(read.flatMap(({ locks }) => locks ?? []));

    const nextWaits = new Map<string, CopilotCliWait>();
    const nextWaited = new Map<string, Set<string>>();
    const nextSeen = new Map<string, Map<string, number>>();
    const nextWanted = new Set<string>();
    let unread = false;
    let locksUnread = false;
    const sessions = read.map(({ ref, log, fold, locks }) => {
      const live = locks === null ? null : locks.some((lock) => counted.has(lock));
      // When each open permission request was first seen, kept while it stays open.
      const before = seen.get(ref.id);
      const firstSeen = new Map<string, number>();
      for (const request of fold.permissions.keys()) {
        firstSeen.set(request, before?.get(request) ?? checkedAt);
      }
      if (firstSeen.size > 0) nextSeen.set(ref.id, firstSeen);
      const status = copilotCliStatusOf({
        fold,
        live,
        writtenAt: plausibleTime(Math.floor(log.writtenAt), checkedAt),
        changedAt: plausibleTime(Math.floor(changedAtOf(ref)), checkedAt),
        now: checkedAt,
        seen: firstSeen,
        waited: waited.get(ref.id) ?? new Set(),
      });
      const id = copilotCliId(ref.id);
      if (status.wait !== undefined) {
        const wait = continuedDeepseekHarnessWait(waits.get(id), status.wait);
        nextWaits.set(id, wait);
        status.since = wait.since;
        const requests = wait.ids
          .filter((wait) => wait.startsWith("permission:"))
          .map((wait) => wait.slice("permission:".length));
        if (requests.length > 0) nextWaited.set(ref.id, new Set(requests));
      }
      if (live !== false || status.status === "needs-you") nextWanted.add(ref.id);
      if (fold.unsure) unread = true;
      if (live === null) locksUnread = true;
      return copilotCliSession({
        folderName: ref.id,
        cwd: copilotCwdOf(fold),
        startedAt: fold.startedAt,
        status,
        writtenAt: log.writtenAt,
        now: checkedAt,
      });
    });
    waits = nextWaits;
    waited = nextWaited;
    seen = nextSeen;
    wanted = nextWanted;

    let detail = `Sessions are read from the event logs Copilot CLI keeps in ${sessionsName}. ${notes}`;
    if (unread) detail += ` ${UNREAD_NOTE}`;
    if (locksUnread) detail += ` ${LOCKS_UNREAD_NOTE}`;
    detail += passedOverNote;
    if (found.link) detail += ` ${LINK_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: COPILOT_CLI_CAPABILITIES,
    lookingIn: `Looking for Copilot CLI sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Copilot CLI sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
