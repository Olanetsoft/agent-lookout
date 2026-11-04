import os from "node:os";
import path from "node:path";

import {
  continuedKimiCodeWait,
  kimiCodeWaitOf,
  type KimiCodeWait,
} from "../../../core/mapping/kimi-code/kimiCodeMapping.ts";
import { isWithinRetention } from "../../../core/sessions/retention.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import { START_CHECK_TTL_MS, type ReadProcessStarts } from "../../processes/processStart.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { createRecordProcessCheck } from "../qwen-code/processCheck.ts";
import { every } from "../words.ts";
import { createLockReader, LOCK_FOLDERS, type SessionLock } from "./locks.ts";
import { SESSIONS_DIR, stateFilePath, wireFilePath } from "./paths.ts";
import { createIndexReader, SESSION_INDEX_FILE, type IndexedSession } from "./sessionIndex.ts";
import { createStateReader, type SessionState } from "./sessionState.ts";
import { kimiCodeSession, SOURCE_ID } from "./toSession.ts";
import { createWireReader } from "./wireFile.ts";

/** The variable that names Kimi Code's folder, for Agent Lookout alone. */
export const KIMI_CODE_HOME_ENV = "AGENT_LOOKOUT_KIMI_CODE_HOME";

/** Kimi Code's own variable for its folder. */
export const KIMI_CODE_OWN_HOME_ENV = "KIMI_CODE_HOME";

/** Where Kimi Code keeps its files, in the home folder, when nothing names another place. */
export const DEFAULT_KIMI_CODE_HOME = ".kimi-code";

/** How long a folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/**
 * How often every session's `state.json` is looked up, for one last written over
 * a day ago that was opened again. A new session is found on the next poll, and
 * the sessions already shown, with a lock or found written in the last day are
 * looked up on every poll.
 */
export const SWEEP_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Kimi Code";

/** Said whenever Kimi Code is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A Kimi Code session shows as needing you while Kimi Code waits for your approval or an answer. Kimi Code keeps a subagent's wait in the subagent's own file, which is not read, so a session whose subagent waits for you shows as working.";

/** Said whenever Kimi Code is watched: why an open session can show as finished. */
export const OPEN_NOTE =
  "Kimi Code keeps a lock on a session only while it is busy, so a session shows as idle only once Agent Lookout has seen it busy, for as long as that process runs. Any other session with no lock shows as finished.";

/** Said whenever Kimi Code is watched, until Agent Lookout has been checked against it. */
export const UNCHECKED_NOTE =
  "This was built from Kimi Code's source at 2.4.1 and has not yet been checked on a computer running it, so a status can be wrong.";

/** Said when a `state.json` is over the most this reads. */
export const TOO_LARGE_NOTE =
  "A Kimi Code session's state.json is over 1 MiB, the most Agent Lookout reads, so that session is not shown.";

/**
 * What a Kimi Code session can show, from the files this adapter reads. See
 * docs/adapters/kimi-code.md for each. Built from Kimi Code's source at 2.4.1 and
 * not yet checked on a computer running it.
 *
 * - Working is a lock a process that runs holds, which Kimi Code takes for as
 *   long as a session is busy. Idle is a session whose lock Agent Lookout saw
 *   held, let go, with that process still running: Kimi Code writes nothing that
 *   says a session is open but idle.
 * - Needs you is an approval or a question the main agent's event file holds
 *   with no answer, asked since the lock was taken (`kimiCodeWaitOf`). A
 *   subagent's wait is in its own file, which is not read.
 * - Finished is a session with no lock held and no process known to have it. So
 *   a session idle in a Kimi Code that was opened before Agent Lookout saw it
 *   busy shows as finished until its next turn.
 * - Failed is a last turn `state.json` says failed. A Kimi Code that stops
 *   mid-turn writes nothing, and shows as finished.
 * - The name is the title a model or a person set, else the folder's. The
 *   default title, the start of the first prompt, is never kept.
 * - No Jump: a lock names a process, which can serve many sessions, and no
 *   terminal or window. Kimi Code documents no link that opens a session.
 * - Quiet for is the main agent's event file's modified time, which a subagent's
 *   work does not move.
 * - No Tokens: Kimi Code writes its counts into the event file, of which only
 *   lines about approvals and questions are parsed.
 * - No Stop: the process that holds a session's lock can hold others' too.
 * - No Answer: Agent Lookout does not talk to Kimi Code.
 */
export const KIMI_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Working from the lock Kimi Code keeps on a busy session. Idle only after that, while the same process runs.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While Kimi Code waits for your approval or an answer. A session whose subagent waits for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once its process goes. A session idle since before Agent Lookout saw it busy also shows as finished.",
  },
  failed: {
    level: "partly",
    reason: "When a turn ends on an error Kimi Code records. A crash mid-turn shows as finished.",
  },
  names: {
    level: "partly",
    reason:
      "The title you or a model set, else the folder's. The default title is the start of your first prompt, never kept.",
  },
  jump: {
    level: "no",
    reason:
      "A session's lock names a process, which can serve many sessions, and no terminal or window.",
  },
  "quiet-for": {
    level: "partly",
    reason: "From the main agent's event file, so a session whose subagent works can look quiet.",
  },
  tokens: {
    level: "no",
    reason:
      "Kimi Code writes its counts into the event file, of which only approvals and questions are parsed.",
  },
  stop: {
    level: "no",
    reason:
      "The process holding a Kimi Code session can hold others too, so none can be confirmed and stopped alone.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout does not talk to Kimi Code, so it cannot send an answer.",
  },
};

/** A setting's value, trimmed. Empty is none. */
function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/**
 * The folder this adapter reads, worked out as Kimi Code does (`resolveKimiHome`
 * in `app/bootstrap/bootstrap.ts`): the one `AGENT_LOOKOUT_KIMI_CODE_HOME` names,
 * else `KIMI_CODE_HOME`, else `~/.kimi-code`, on every system.
 */
export function kimiCodeHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = setting(env, KIMI_CODE_HOME_ENV) ?? setting(env, KIMI_CODE_OWN_HOME_ENV);
  return path.resolve(own ?? path.join(homeDir, DEFAULT_KIMI_CODE_HOME));
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface KimiCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folder names, and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** How long the computer has been on, in milliseconds. Defaults to asking the system. */
  uptimeMs?: () => number;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session's `state.json` is looked up. Defaults to a minute. */
  sweepMs?: number;
  /** Reads when processes started, on a Mac. Defaults to asking `ps`. */
  readProcessStarts?: ReadProcessStarts;
}

/** One `state.json` this poll read, with what its session is shown from. */
interface Found {
  session: IndexedSession;
  state: SessionState;
  /** The session's lock, when that names a process. */
  lock: SessionLock | null;
  /** The process Agent Lookout last saw hold its lock, when it has none now. */
  lastHolder: SessionLock | null;
  stateWrittenAt: number;
}

/** What tells one lock's process from another's, for `ruledOut`. */
const processMark = ({ pid, startedAt }: SessionLock) => `${pid} ${startedAt}`;

/**
 * What Sources says tells a session's process from another program given its
 * pid, and how often that is asked. Where `ps` is not asked, signal 0 is all
 * there is.
 */
function processCheckFacts(asksPs: boolean, pollIntervalMs: number): SourceFact[] {
  if (!asksPs) {
    return [{ label: "Process check", value: `signal 0 alone, ${every(pollIntervalMs)}` }];
  }
  return [
    { label: "Process check", value: "ps -o pid=,lstart= -p <pids>" },
    {
      label: "Process check run",
      value: `${every(START_CHECK_TTL_MS)} while a session's process runs, and sooner when another appears`,
    },
  ];
}

/**
 * Finds Kimi Code sessions on this machine from the files Kimi Code keeps, with
 * nothing installed, no setting changed and no Kimi Code program run. Built from
 * Kimi Code's source at 2.4.1 and not yet checked on a computer running it.
 *
 * Kimi Code's command, its web page and its editor extension keep their sessions
 * in one folder, `~/.kimi-code`. Its own lists are its `kimi` command, which
 * starts Kimi Code, and the server of `kimi web`, which needs a token and runs
 * only when a person starts it, so the adapter reads its files, read-only:
 *
 * - `session_index.jsonl`, the list of sessions, looked up on every poll and read
 *   when it changes (`sessionIndex.ts`).
 * - `locks/sessions/`, listed on every poll, and each `<id>.lock` in it when it
 *   changes, which names the process using a session (`locks.ts`).
 * - Each session's `state.json`, read when it changes (`sessionState.ts`).
 * - `agents/main/wire.jsonl`, the session's event file, read only while a process
 *   that runs holds the session's lock, for the approvals and questions left
 *   unanswered (`wireFile.ts`).
 *
 * Kimi Code keeps every session it ever ran, so a poll looks up only the sessions
 * it shows, those with a lock, any new one and any it found written in the last
 * day, with one `lstat` each. Every other `state.json` is looked up once a minute,
 * and one last written over a day ago is never opened. So a session is first
 * listed by its `state.json`'s time alone, when that is within 24 hours, and stays
 * for 24 hours after that time, and for as long as a process that runs holds it,
 * or last held it. A session the person archived, and a child session, which a
 * client makes from another for one piece of work, are not listed.
 *
 * A lock is held by a process that runs, and that session works or waits, while
 * three things hold, the first two being Kimi Code's own rule: signal 0 finds its
 * process, which sends nothing; it was taken since the computer started; and on a
 * Mac, `ps` says that process did not start more than a minute after the lock was
 * taken, or it was given a dead Kimi Code's pid. Only on a Mac, as a comparison
 * acts only when it is sure: Linux's `ps` works a start out again from the clock
 * each time, a lock holds no start token to read from `/proc`, and Windows has no
 * `ps`. No other process is read, and nothing of any process's arguments. A crash
 * leaves a lock behind for a process that no longer runs, and the session is then
 * finished, or failed if its last turn failed.
 *
 * Kimi Code lets a lock go 3 seconds after a session stops being busy, and writes
 * nothing that says a session is open but idle. So the process that last held a
 * session's lock is kept in memory while it runs, and the session is idle until
 * that process ends. It is never written anywhere, and a restart of Agent Lookout
 * forgets it.
 *
 * Kimi Code not being installed costs nothing: when its folder is missing, the
 * adapter says so and looks again only once a minute. Someone who sets
 * `AGENT_LOOKOUT_KIMI_CODE_HOME` means that folder: if it holds no sessions, that
 * is an answer, not a missing Kimi Code.
 */
export function createKimiCodeAdapter(options: KimiCodeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const uptimeMs = options.uptimeMs ?? (() => os.uptime() * 1000);
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const asksPs = platform === "darwin";
  const processCheck = asksPs ? createRecordProcessCheck(options.readProcessStarts, now) : null;

  const named = setting(env, KIMI_CODE_HOME_ENV) !== undefined;
  const fromKimiCode = !named && setting(env, KIMI_CODE_OWN_HOME_ENV) !== undefined;
  const home = kimiCodeHomeFor(env, homeDir);
  const homeName = tildify(home, homeDir);
  const sessionsName = tildify(path.join(home, SESSIONS_DIR), homeDir);
  const indexFile = path.join(home, SESSION_INDEX_FILE);
  const indexName = tildify(indexFile, homeDir);
  const locksName = tildify(path.join(home, ...LOCK_FOLDERS), homeDir);
  const sessionsIndex = createIndexReader(indexFile, io, platform);
  const locks = createLockReader(home, io);
  const states = createStateReader(home, io, platform);
  const wires = createWireReader(home, io);
  const processFacts = processCheckFacts(asksPs, pollIntervalMs);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** When every `state.json` was last looked up. */
  let sweptAt: number | null = null;
  /** The sessions the last poll showed. */
  let shown = new Set<string>();
  /** The sessions last found to have no `state.json`, or one written over a day ago, looked up only by a sweep. */
  let settled = new Set<string>();
  /** The process Agent Lookout last saw hold each session's lock, while that runs. */
  let holders = new Map<string, SessionLock>();
  /** Each session's wait as the last poll showed it. */
  let waits = new Map<string, KimiCodeWait>();
  /**
   * Each process `ps` showed another program has, by `processMark`, kept while
   * that pid runs. A pid goes only to a program that starts later, so the answer
   * stands: a later check that cannot answer does not bring the session back.
   */
  let ruledOut = new Set<string>();

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
        { label: "Session index", value: indexName },
        { label: "Locks folder", value: locksName },
        { label: "Read", value: read },
        ...processFacts,
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis: BASIS } : { health, sessions: [] };
  }

  /** Kimi Code is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const where = fromKimiCode
      ? `${KIMI_CODE_OWN_HOME_ENV} is set, and there is no ${homeName} folder`
      : `there is no ${homeName} folder`;
    return result(
      "unavailable",
      `Kimi Code was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** The notes said whenever Kimi Code is watched. */
  const alwaysNotes = `${NEEDS_YOU_NOTE} ${OPEN_NOTE} ${UNCHECKED_NOTE}`;

  /** Whether the folder is there. Only one that is missing, or is no folder, counts as not there. */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  /**
   * An ordinary file's `lstat`, or null when none is at its name. A look that
   * fails is no fact about the file, so the `lstat` of its last read stands.
   */
  async function lookUp(file: string, lastLook: FileInfo | null): Promise<FileInfo | null> {
    try {
      const info = await io.lstat(file);
      return info.kind === "file" ? info : null;
    } catch (error) {
      return isMissing(error) ? null : lastLook;
    }
  }

  /** Whether it is time to look up every `state.json`. A clock set back counts as time enough. */
  function sweepDue(checkedAt: number): boolean {
    if (sweptAt === null) return true;
    const since = checkedAt - sweptAt;
    return since < 0 || since >= sweepMs;
  }

  function forgetAll(): void {
    shown = new Set();
    settled = new Set();
    holders = new Map();
    waits = new Map();
    ruledOut = new Set();
    sweptAt = null;
    states.keepOnly(shown);
    wires.keepOnly(shown);
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Kimi Code is believed missing for a while, so a machine without
    // it pays nothing on most polls.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    const index = await sessionsIndex.read();
    if (index.state === "unreadable") {
      return result(
        "error",
        `Kimi Code sessions could not be read: ${indexName} could not be read, or a link or something other than an ordinary file is at its name.`,
        "cannot be read",
        checkedAt,
      );
    }
    if (index.state === "missing") {
      forgetAll();
      if (!(await homeIsThere())) {
        if (named) {
          return result(
            "ok",
            `${KIMI_CODE_HOME_ENV} is set, and there is no ${homeName} folder, so no Kimi Code sessions are listed. ${alwaysNotes}`,
            "not found",
            checkedAt,
          );
        }
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      absentAt = null;
      return result(
        "ok",
        `Kimi Code has not saved any sessions in ${homeName} yet. ${alwaysNotes}`,
        every(pollIntervalMs),
        checkedAt,
      );
    }
    absentAt = null;

    const found = await locks.read();
    if (found === null) {
      return result(
        "error",
        `Kimi Code sessions could not be read: the folder ${locksName} could not be listed.`,
        "cannot be read",
        checkedAt,
      );
    }

    const sweep = sweepDue(checkedAt);
    if (sweep) sweptAt = checkedAt;
    const stillSettled = new Set<string>();
    /** What this poll read, so a `state.json` it cannot use is not opened again until it changes. */
    const read = new Set<string>();
    const listed: Found[] = [];
    let tooLarge = false;

    for (const session of index.sessions.values()) {
      const { id } = session;
      const locked = found.has(id);
      if (settled.has(id) && !sweep && !locked) {
        stillSettled.add(id);
        continue;
      }
      const info = await lookUp(stateFilePath(home, session), states.lastLook(id));
      // A `state.json` last written over a day ago is not opened, unless its
      // session is shown already or has a lock: one that works stays for as
      // long as that lasts.
      const old = info !== null && !isWithinRetention(Math.floor(info.mtimeMs), checkedAt);
      if (info === null || (old && !shown.has(id) && !locked)) {
        stillSettled.add(id);
        continue;
      }
      read.add(id);
      const answer = await states.read(session, info);
      if (answer.state === "too-large") tooLarge = true;
      if (answer.state !== "ok" || !answer.session.listed) continue;
      const lock = found.get(id) ?? null;
      listed.push({
        session,
        state: answer.session,
        lock,
        lastHolder: lock === null ? (holders.get(id) ?? null) : null,
        stateWrittenAt: info.mtimeMs,
      });
    }

    // A lock counts only as Kimi Code's own rule counts one: its process runs,
    // and it was taken since the computer started. On a Mac, a process that
    // started more than a minute after the lock was taken was given the pid of
    // a Kimi Code that ended.
    const bootedAt = checkedAt - uptimeMs();
    const running = listed
      .flatMap(({ lock, lastHolder }) => lock ?? lastHolder ?? [])
      .filter((one) => one.startedAt >= bootedAt && isAlive(one.pid));
    const matches = await processCheck?.matches(running);
    ruledOut = new Set(
      running
        .filter((one) => matches?.get(one) === "different" || ruledOut.has(processMark(one)))
        .map(processMark),
    );
    const runs = (one: SessionLock | null): one is SessionLock =>
      one !== null && running.includes(one) && !ruledOut.has(processMark(one));

    const sessions: Session[] = [];
    const stillShown = new Set<string>();
    const stillHeld = new Map<string, SessionLock>();
    const shownWaits = new Map<string, KimiCodeWait>();
    for (const { session, state, lock, lastHolder, stateWrittenAt } of listed) {
      const { id } = session;
      const held = runs(lock);
      const open = runs(lastHolder);
      if (held) stillHeld.set(id, lock);
      else if (open) stillHeld.set(id, lastHolder);

      let wait: KimiCodeWait | null = null;
      let wireWrittenAt: number | undefined;
      if (held) {
        const wire = await lookUp(wireFilePath(home, session), wires.lastLook(id));
        if (wire !== null) {
          wireWrittenAt = wire.mtimeMs;
          const asked = kimiCodeWaitOf(await wires.read(session, wire), lock.startedAt);
          wait = asked && continuedKimiCodeWait(waits.get(id), asked);
        }
      }
      if (wait !== null) shownWaits.set(id, wait);

      if (held || open || isWithinRetention(Math.floor(stateWrittenAt), checkedAt)) {
        stillShown.add(id);
        sessions.push(
          kimiCodeSession({
            session,
            state,
            lock: held ? lock : null,
            lastHolder: open ? lastHolder : null,
            wait,
            stateWrittenAt,
            ...(wireWrittenAt === undefined ? {} : { wireWrittenAt }),
            now: checkedAt,
          }),
        );
      } else {
        stillSettled.add(id);
      }
    }

    settled = stillSettled;
    shown = stillShown;
    holders = stillHeld;
    waits = shownWaits;
    states.keepOnly(read);
    wires.keepOnly(stillShown);

    let detail = `Sessions are read from the files Kimi Code saves in ${homeName}, since it offers no list of its sessions for other programs. ${alwaysNotes}`;
    if (tooLarge) detail += ` ${TOO_LARGE_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: KIMI_CODE_CAPABILITIES,
    lookingIn: `Looking for Kimi Code sessions in ${homeName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Kimi Code sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
