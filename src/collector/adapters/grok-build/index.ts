import os from "node:os";
import path from "node:path";

import {
  mapGrokBuildStatus,
  type GrokBuildLog,
  type GrokBuildStatus,
  type GrokBuildWait,
} from "../../../core/mapping/grok-build/grokBuildMapping.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import {
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
  type StartMatch,
} from "../../processes/processStart.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { TabAsker } from "../../terminal/tabFinder.ts";
import type { TerminalTab } from "../../terminal/terminalTabs.ts";
import type { PaneAsker } from "../../tmux/paneFinder.ts";
import type { TmuxPane } from "../../tmux/panes.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { effectiveUser } from "../autohand-code/folders.ts";
import { paneFacts } from "../paneFacts.ts";
import {
  createRecordProcessCheck,
  type RecordProcess,
  type RecordProcessCheck,
} from "../qwen-code/processCheck.ts";
import { tabFacts } from "../tabFacts.ts";
import { every } from "../words.ts";
import { createLogReader } from "./eventLog.ts";
import { createGrokBuildMemory } from "./finishedSessions.ts";
import { createFolderFinder, SESSIONS_DIR, type FolderLook } from "./folders.ts";
import { GROK_BUILD_HOME_ENV, GROK_HOME_ENV, grokBuildHome } from "./home.ts";
import { createRegistryReader, REGISTRY_FILE, type RegistryEntry } from "./registry.ts";
import { createSessionFiles } from "./sessionFiles.ts";
import { finishedGrokBuildSession, grokBuildSession, SOURCE_ID, withJump } from "./toSession.ts";

/**
 * The Grok Build adapter. Grok Build is SpaceXAI's coding agent, in its
 * terminal app `grok`. Its source is open, under the Apache-2.0 licence, and
 * this was built from it at 1.0.45 (github.com/xai-org/grok-build, commit
 * 2bdd1d6, 2026-09-29). Released builds are at 1.0.89, whose source is not
 * public, and it has not yet been checked on a machine running Grok Build. See
 * docs/adapters/grok-build.md.
 *
 * It is an adapter of its own, which shares Qwen Code's check of a listed
 * process's start (`../qwen-code/processCheck.ts`), Autohand Code's test of
 * what it is willing to read and its reading of JSON as bytes
 * (`../autohand-code/folders.ts`, `../autohand-code/jsonBytes.ts`).
 */

export { GROK_BUILD_HOME_ENV, GROK_HOME_ENV, grokBuildHomeFor } from "./home.ts";

/** How long Grok Build's home, not found, is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** The way this adapter reads, named for the poller. */
export const BASIS = "files";

const LABEL = "Grok Build";

/** Said whenever Grok Build is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "A Grok Build session shows as needing you while it asks you a question or waits for you to approve a plan. Grok Build writes the same lines for a tool you are asked to approve as for one that runs, so a session waiting for a tool's approval shows as working.";

/** Said whenever Grok Build is watched, until Agent Lookout has been checked against it. */
export const UNCHECKED_NOTE =
  "This was built from Grok Build's source at 1.0.45, released builds are at 1.0.89, and it has not yet been checked on a machine running Grok Build, so a status can be wrong.";

/** Said when a session's status is unknown, with every cause of it. */
export const UNKNOWN_NOTE =
  "A Grok Build session shows as unknown while its folder cannot be found, its event log or plan file cannot be read, its event log ends in a way Grok Build 1.0.45 does not write, or its event log is longer than 8 MiB with no turn's start or end in its last 8 MiB. So does one whose turn has had nothing from the model for 2 minutes, or started more than a minute before Grok Build listed it with nothing from the turn since.";

/** Said when `GROK_HOME` names a folder that is not a whole path. */
export const PASSED_OVER_NOTE = `${GROK_HOME_ENV} is set to a folder that is not a whole path, which Grok Build reads from the folder it was started in, so Agent Lookout reads the default folder instead.`;

/**
 * What a Grok Build session can show, from the files this adapter reads. See
 * docs/adapters/grok-build.md for each. Built from Grok Build's source at
 * 1.0.45 and not yet checked on a machine running it.
 *
 * - Working, idle and failed come from its event log's newest turn
 *   (`grokBuildMapping.ts`), for a session in the terminal app alone: Grok
 *   Build lists no other. Background work can go on after a turn ends, and a
 *   crash on Linux or Windows can leave a session listed with its process ID
 *   given to another program.
 * - Needs you while a question is open, or `plan_mode.json` says a plan waits
 *   for approval. A tool's approval writes the same lines as a tool that runs.
 * - Finished once its process ends, Grok Build takes it off its list with its
 *   turn over, as /new does, or a crash left it listed.
 * - Failed while its newest turn ended on an error, or a crash cut it off.
 * - Its name is a title marked as set by you, else the folder's.
 * - Jump is a pane for tmux, and a tab for Terminal or iTerm2 on a Mac, given
 *   only once `ps` says its process started before Grok Build listed it.
 * - Quiet for is the event log's modified time.
 * - No Tokens, Stop or Answer.
 */
export const GROK_BUILD_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Sessions in its terminal app only. Idle can mean background work still runs. On Linux and Windows, a crash can leave one open.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While it asks a question or to approve a plan. Waits for a tool's approval, a subagent or an MCP server show as working or idle.",
  },
  finished: {
    level: "partly",
    reason:
      "Once Grok Build closes it or its process ends, if Agent Lookout saw it open or it was left behind. After /new, once its turn ends.",
  },
  failed: {
    level: "partly",
    reason:
      "When its last turn ended on an error, or was cut off by a crash and the session reopened, until a new turn starts.",
  },
  names: {
    level: "partly",
    reason:
      "A title marked as set by you, as with /rename, else the folder's. Grok Build's own titles are not shown: one can be your prompt.",
  },
  jump: {
    level: "partly",
    reason:
      "In tmux, and in a tab of Terminal or iTerm2 on a Mac. Not in another terminal or on Windows.",
  },
  "quiet-for": {
    level: "partly",
    reason:
      "The time since its event log was last written. A long reply or command writes nothing until it ends.",
  },
  tokens: {
    level: "no",
    reason:
      "Grok Build counts tokens by turn, not by reply, and Agent Lookout does not read its usage file.",
  },
  stop: {
    level: "no",
    reason: "Agent Lookout stops Claude Code sessions only so far.",
  },
  answer: {
    level: "no",
    reason:
      "Agent Lookout never connects to Grok Build's socket or ACP server, so it cannot send an answer.",
  },
};

/** The `ps` that says when a listed process started, as a card names it. */
const START_PS = "ps -o pid=,lstart= -p <pids>";

/**
 * What Sources says tells a session's process from another program given its
 * ID, and how often: on a Mac, the `ps` that says when it started, and
 * elsewhere signal 0 alone.
 */
function processCheckFacts(platform: NodeJS.Platform): SourceFact[] {
  if (platform !== "darwin") return [{ label: "Process check", value: "signal 0 alone" }];
  return [
    { label: "Process check", value: START_PS },
    {
      label: "Process check run",
      value: `${every(START_CHECK_TTL_MS)} while a session's process runs, and sooner when another appears`,
    },
  ];
}

/**
 * What Sources says of the `ps` that confirms a process found in a tmux pane
 * before its session gets Jump, on Linux alone, as for Qwen Code: what is run,
 * and how often, or "not run" until it has been.
 */
function jumpCheckFacts(
  panes: PaneAsker | undefined,
  startCheck: RecordProcessCheck,
  platform: NodeJS.Platform,
): SourceFact[] {
  if (platform !== "linux" || !panes?.installed()) return [];
  return [
    { label: "Jump check", value: START_PS },
    {
      label: "Jump check run",
      value: startCheck.asked()
        ? `${every(START_CHECK_TTL_MS)} while a session's process is in a pane, and sooner when another is found in one`
        : "not run",
    },
  ];
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface GrokBuildAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** Whether a process runs, with signal 0, which tests a process and sends it nothing. */
  isAlive?: (pid: number) => boolean;
  /** The system's rules for folder names and process IDs. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** The user Agent Lookout runs as, on macOS and Linux. Defaults to this process's. */
  euid?: number | null;
  /**
   * How often the poller calls `poll()`, which is how often the files are read.
   * The adapter keeps no timer of its own: this is only stated in `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing home is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often, at most, every folder in `sessions` is looked through for missing sessions. */
  sweepMs?: number;
  /** The most names in `sessions` looked through at once. Defaults to 2,000. */
  sweepNames?: number;
  /**
   * Finds the tmux pane each open session's process runs in, so that Jump can
   * select it. The collector passes an asker of the finder the jump route acts
   * with. Left out, no pane is looked for and tmux is never run.
   */
  panes?: PaneAsker;
  /**
   * Finds the Terminal or iTerm2 tab each open session's process runs in, for
   * a session in no tmux pane. Left out, no tab is looked for.
   */
  terminals?: TabAsker;
  /**
   * Reads when processes started, to confirm that the process with a listed
   * session's ID is the one that listed it: on a Mac for every open session,
   * and on Linux for one whose process is found in a pane, before it is given
   * Jump. Defaults to asking `ps`, which is never asked on Windows.
   */
  readProcessStarts?: ReadProcessStarts;
}

/** A session's place in this poll's reading: its entry, and the record `ps` is asked about. */
interface Tracked {
  entry: RegistryEntry;
  record: RecordProcess;
}

/**
 * Finds Grok Build sessions on this machine from the files Grok Build keeps,
 * with nothing installed, no setting changed and no Grok Build program run.
 *
 * It reads, read-only:
 *
 * - The list of open sessions, `<grok home>/active_sessions.json`, which the
 *   terminal app keeps: each session's ID, its process's ID, its folder and
 *   when it was listed (`registry.ts`). A session an editor or `grok -p` runs
 *   is not listed.
 * - Each listed session's folder, `sessions/<folder>/<ID>/`, found with
 *   `lstat` (`folders.ts`), and in it its event log, `events.jsonl`, read
 *   only as far as it grew (`eventLog.ts`), its `plan_mode.json`, and its
 *   `summary.json` for a title the person set (`sessionFiles.ts`).
 *
 * Whether a session's process runs is asked with signal 0, which sends
 * nothing. On a Mac, every 30 seconds and when a session appears, `ps` is
 * asked when the process started, and one that started more than a minute
 * after Grok Build listed the session was given the ID since, as after a
 * crash (`../qwen-code/processCheck.ts`). On Linux a process's start moves
 * with the clock, so signal 0 alone decides, and on Windows there is no `ps`.
 *
 * A session whose process has gone, or a crash left listed, is finished. One
 * Grok Build lists no more whose process runs, as /new leaves the one before,
 * is watched while its turn is under way, a question is open or a plan waits,
 * and finished after (`finishedSessions.ts`). Otherwise its status comes from
 * its event log and plan file (`grokBuildMapping.ts`).
 *
 * A listed session whose process runs inside a tmux pane, or else in a tab of
 * Terminal or iTerm2, is given a `jump` that names the place, once `ps` says
 * the process started before Grok Build listed the session.
 *
 * Grok Build not being installed costs nothing: when its home holds neither
 * the list nor `sessions`, the adapter says so and looks again only once a
 * minute, with two `lstat`s. Someone who sets `AGENT_LOOKOUT_GROK_HOME` means
 * that folder: if it holds neither, that is an answer, not a missing Grok
 * Build.
 */
export function createGrokBuildAdapter(options: GrokBuildAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const isAlive = options.isAlive ?? isProcessAlive;
  const platform = options.platform ?? process.platform;
  const euid = options.euid === undefined ? effectiveUser() : options.euid;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;

  const { home, named, fromGrokHome, passedOver } = grokBuildHome(env, homeDir, platform);
  const registryFile = path.join(home, REGISTRY_FILE);
  const sessionsDir = path.join(home, SESSIONS_DIR);
  const homeName = tildify(home, homeDir);
  const registryName = tildify(registryFile, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);

  const registry = createRegistryReader({ home, io, platform, euid });
  const finder = createFolderFinder({
    sessionsDir,
    io,
    platform,
    euid,
    sweepMs: options.sweepMs,
    maxNames: options.sweepNames,
  });
  const logs = createLogReader({ io, platform, euid });
  const files = createSessionFiles({ io, platform, euid });
  const memory = createGrokBuildMemory();
  const startCheck = createRecordProcessCheck(options.readProcessStarts, now);
  // On a Mac the start `ps` gives decides whether a session is open. On Linux
  // it moves with the clock, so it is asked only before Jump, and on Windows never.
  const liveCheck = platform === "darwin" ? startCheck : null;

  /** The open sessions this poll listed, by their ID in the model, for Jump. */
  let openTracked = new Map<string, Tracked>();
  /** This poll's answer for each listed session's process, from the live check. */
  let recordMatches = new Map<RecordProcess, StartMatch>();
  /** What each waiting session waited on at the last poll, and since when, by ID. */
  let waits = new Map<string, { wait: GrokBuildWait; since: number | null }>();
  /** When the home was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;

  const processCheck = processCheckFacts(platform);

  function watching(read: string): SourceFact[] {
    return [
      { label: "Session list", value: registryName },
      { label: "Read", value: read },
      { label: "Sessions folder", value: sessionsName },
      {
        label: "Event logs",
        value: "events.jsonl in each listed session's folder, when it changes",
      },
      { label: "Process IDs", value: `signal 0, ${every(pollIntervalMs)}` },
      ...processCheck,
      // Written before this poll's look, so what it finds shows at the next poll.
      ...paneFacts(options.panes, platform),
      ...jumpCheckFacts(options.panes, startCheck, platform),
      ...tabFacts(options.terminals, platform),
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

  const passedOverNote = passedOver ? ` ${PASSED_OVER_NOTE}` : "";

  /** Grok Build is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    const neither = `there is no ${registryName} or ${sessionsName} folder`;
    const where = fromGrokHome ? `${GROK_HOME_ENV} is set to ${homeName}, and ${neither}` : neither;
    return result(
      "unavailable",
      `Grok Build was not found: ${where}. Agent Lookout looks again ${every(recheckMs)}.${passedOverNote}`,
      "not found",
      checkedAt,
    );
  }

  /** Whether something is at a path. Only one that is missing counts as not there. */
  async function isThere(target: string): Promise<boolean> {
    try {
      await io.lstat(target);
      return true;
    } catch (error) {
      return !isMissing(error);
    }
  }

  const notes = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

  /** What a session's plan file says, as the mapping takes it. */
  async function planOf(sessionId: string, folder: string) {
    const read = await files.plan(sessionId, folder);
    if (read.state === "ok") return { plan: read.waits, planWrittenAt: read.writtenAt };
    return { plan: read.state === "missing" ? false : ("unknown" as const), planWrittenAt: null };
  }

  /**
   * A status whose wait goes on keeps the time it began: a plan's, taken from
   * `plan_mode.json` once, stays while the plan waits, though the file is
   * written again. A question's, and a plan's from its call, stay by
   * themselves while the wait lasts.
   */
  function heldWait(
    sessionId: string,
    status: GrokBuildStatus,
    next: Map<string, { wait: GrokBuildWait; since: number | null }>,
  ): GrokBuildStatus {
    if (status.status !== "needs-you" || status.wait === undefined) return status;
    const before = waits.get(sessionId);
    const since =
      status.wait === "plan-file" && before?.wait === "plan-file" && before.since !== null
        ? before.since
        : status.since;
    next.set(sessionId, { wait: status.wait, since });
    return { ...status, since };
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Grok Build is believed missing for a while, so a machine without
    // it pays nothing on most polls. A clock set back counts as time enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    const read = await registry.read();
    if (read.state === "error") {
      const why =
        read.why === "too-large"
          ? "it is larger than Agent Lookout reads"
          : read.why === "broken"
            ? "it is not a list Agent Lookout reads"
            : "it could not be opened";
      return result(
        "error",
        `Grok Build sessions could not be read: ${registryName} was found, but ${why}.`,
        "cannot be read",
        checkedAt,
      );
    }
    // With no list and no sessions folder there is no Grok Build here, unless
    // the folder was named: then that is the answer, and those shown open have closed.
    const nothing = read.state === "missing" && !(await isThere(sessionsDir));
    if (nothing && !named) {
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const entries = read.state === "ok" ? read.entries : [];
    const listedIds = new Set(entries.map((entry) => entry.sessionId));
    const watched = memory.unlisted(listedIds, checkedAt);

    // Signal 0 once for each process. On a Mac, a process with the ID that
    // started more than a minute after Grok Build listed the session was given
    // the ID since, and the session's own process has gone.
    const tracked = [...entries, ...watched.map((item) => item.entry)].map((entry): Tracked => ({
      entry,
      record: { pid: entry.pid, startedAt: entry.openedAt },
    }));
    const runs = new Map<number, boolean>();
    for (const { entry } of tracked) {
      if (!runs.has(entry.pid)) runs.set(entry.pid, isAlive(entry.pid));
    }
    const running = tracked.filter(({ entry }) => runs.get(entry.pid) === true);
    recordMatches = liveCheck
      ? await liveCheck.matches(running.map(({ record }) => record))
      : new Map();
    const ownRuns = ({ entry, record }: Tracked) =>
      runs.get(entry.pid) === true && recordMatches.get(record) !== "different";

    const looks = await finder.find(
      tracked.map(({ entry }) => entry),
      checkedAt,
    );
    const lookOf = (entry: RegistryEntry): FolderLook =>
      looks.get(entry.sessionId) ?? { state: "none" };
    const folderOf = (entry: RegistryEntry) => {
      const look = lookOf(entry);
      return look.state === "found" ? look.folder : null;
    };

    const open: Session[] = [];
    const nextWaits = new Map<string, { wait: GrokBuildWait; since: number | null }>();
    let unknown = false;

    for (const item of tracked) {
      const { entry } = item;
      const listed = listedIds.has(entry.sessionId);
      const folder = folderOf(entry);
      const title = folder === null ? null : await files.title(entry.sessionId, folder);
      if (!ownRuns(item)) {
        // Its process has ended, or another program has its ID: only the
        // log's modified time is looked at, for when it ended.
        const writtenAt = folder === null ? null : await logs.writtenAt(folder);
        memory.ended({ entry, title, writtenAt, processRunsOn: false }, checkedAt);
        continue;
      }
      let log: GrokBuildLog;
      let writtenAt: number | null = null;
      if (folder === null) {
        log = { state: "no-folder" };
      } else {
        const logRead = await logs.read(entry.sessionId, folder);
        if (logRead.state === "ok") {
          log = { state: "ok", turn: logRead.turn };
          writtenAt = logRead.writtenAt;
        } else {
          log = { state: "unreadable" };
        }
      }
      const plan =
        folder === null
          ? { plan: false, planWrittenAt: null }
          : await planOf(entry.sessionId, folder);
      const status = mapGrokBuildStatus({
        alive: true,
        listed,
        log,
        writtenAt,
        ...plan,
        openedAt: entry.openedAt,
        now: checkedAt,
      });
      const over = status.status === "finished";
      memory.seen(entry, { listed, title, writtenAt, over }, checkedAt);
      if (over) {
        // Watched, and its turn is over: its process runs on with another
        // session, so it names none. It is still watched, for a new turn.
        // When neither of its own times can be right, it is finished from the
        // first poll that found it so, on every poll after.
        const noticedAt = memory.overAt(entry.sessionId) ?? checkedAt;
        open.push(
          finishedGrokBuildSession(
            { entry, title, writtenAt, noticedAt, processRunsOn: true },
            checkedAt,
          ),
        );
        continue;
      }
      if (status.status === "unknown") unknown = true;
      let session = grokBuildSession({
        entry,
        title,
        status: heldWait(entry.sessionId, status, nextWaits),
        writtenAt,
        now: checkedAt,
      });
      // On a Mac the card names the process only once `ps` says it is the one
      // that listed the session, as Jump does.
      if (liveCheck !== null && recordMatches.get(item.record) !== "same") {
        const { pid: _pid, alive: _alive, ...rest } = session;
        session = rest;
      }
      // A watched session's process shows another session now, so Jump would not reach it.
      if (listed) openTracked.set(session.id, item);
      open.push(session);
    }
    waits = nextWaits;

    const finished = memory.finished(checkedAt);
    const keep = new Set([...listedIds, ...memory.ids()]);
    finder.keepOnly(keep);
    logs.keepOnly(keep);
    files.keepOnly(keep);

    let detail = nothing
      ? `${GROK_BUILD_HOME_ENV} is set to ${homeName}, which holds no list of open sessions and no sessions folder, so no Grok Build sessions are listed. ${notes}`
      : `Sessions are read from the list of open sessions Grok Build keeps in ${registryName}, and each one's event log in ${sessionsName}. ${notes}`;
    if (unknown) detail += ` ${UNKNOWN_NOTE}`;
    detail += passedOverNote;
    const shownOpen = new Set(open.map((session) => session.id));
    const ended = finished.filter((session) => !shownOpen.has(session.id));
    return result("ok", detail, nothing ? "not found" : every(pollIntervalMs), checkedAt, [
      ...open,
      ...ended,
    ]);
  }

  /** Tells the finders which processes to look for: this poll's listed open sessions', and no other. */
  async function lookFor(pids: readonly number[]): Promise<void> {
    await Promise.all([options.panes?.look(pids), options.terminals?.look(pids)]);
  }

  /**
   * The sessions of a poll, each listed open one whose process runs inside a
   * tmux pane, or else in a tab of Terminal or iTerm2, with the place Jump
   * reaches it in, once `ps` says the process started before Grok Build
   * listed it. On a Mac that is this poll's own answer.
   */
  async function withJumps(answer: AdapterResult): Promise<AdapterResult> {
    if (!options.panes && !options.terminals) return answer;
    const items = [...openTracked.values()];
    await lookFor([...new Set(items.map(({ entry }) => entry.pid))]);
    const places = new Map<RecordProcess, { pane?: TmuxPane; tab?: TerminalTab }>();
    for (const { entry, record } of items) {
      const pane = options.panes?.paneOf(entry.pid);
      const tab = pane ? undefined : options.terminals?.tabOf(entry.pid);
      if (pane || tab) places.set(record, { pane, tab });
    }
    if (places.size === 0) return answer;
    const matches =
      liveCheck === startCheck ? recordMatches : await startCheck.matches([...places.keys()]);
    return {
      ...answer,
      sessions: answer.sessions.map((session) => {
        const item = openTracked.get(session.id);
        const place =
          item && matches.get(item.record) === "same" ? places.get(item.record) : undefined;
        return place ? withJump(session, place.pane, place.tab) : session;
      }),
    };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: GROK_BUILD_CAPABILITIES,
    lookingIn: `Looking for Grok Build sessions in ${sessionsName}.`,
    async poll() {
      openTracked = new Map();
      recordMatches = new Map();
      try {
        return await withJumps(await poll());
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace. No process is
        // looked for.
        await lookFor([]).catch(() => {});
        return result(
          "error",
          "Something unexpected went wrong while reading Grok Build sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
