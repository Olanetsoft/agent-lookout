import os from "node:os";
import path from "node:path";

import {
  isClaudeCodeSessionKind,
  mapClaudeCodeStatus,
} from "../../../core/mapping/claudeCodeMapping.ts";
import type { SourceFact, SourceHealth, SourceState } from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import {
  createFeedReader,
  FEED_ARGS,
  FEED_ARGS_WITHOUT_ALL,
  runProgram,
  type FeedEntry,
  type FeedResult,
  type RunCommand,
} from "./feed.ts";
import { CLAUDE_BIN_ENV, findClaudeBinary, tildify } from "./findBinary.ts";
import { createFinishedTracker } from "./finishedJobs.ts";
import { createProcessStartCheck, type ReadProcessStarts } from "./processStart.ts";
import {
  readRegistry,
  type RegistryEntry,
  type RegistryIo,
  type RegistryRead,
} from "./registry.ts";
import {
  isProcessAlive,
  sessionFromFeed,
  sessionFromRegistry,
  SOURCE_ID,
  uniqueById,
  type SessionContext,
} from "./toSession.ts";

/** The variable that replaces `~/.claude`. */
export const CLAUDE_HOME_ENV = "AGENT_LOOKOUT_CLAUDE_HOME";

/** The variable that, set to `off`, stops the `claude` command being run at all. */
export const CLAUDE_FEED_ENV = "AGENT_LOOKOUT_CLAUDE_FEED";

/** How often the `claude` command is run while the registry can be relied on. */
export const FEED_INTERVAL_MS = 30_000;

/** How often it is run while the registry cannot be relied on and sessions come from the command. */
export const FEED_FALLBACK_INTERVAL_MS = 5_000;

/**
 * How recently a session must have started to be believed on the registry's
 * word alone. A session this young may have begun after the command last
 * answered, or just before, while it was still writing its first status.
 */
export const NEW_SESSION_GRACE_MS = 10_000;

/** A poll this close to the moment a read is due counts as on time. Timers fire a moment early now and then. */
const DUE_SLACK_MS = 50;

const LABEL = "Claude Code";

/** What is said of a run that ended in a way `runProgram` promises it never will. */
const COULD_NOT_RUN = "The claude agents --json command could not be run";

/** Everything the adapter touches outside itself. Tests replace these. */
export interface ClaudeCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  run?: RunCommand;
  isAlive?: (pid: number) => boolean;
  isExecutable?: (candidate: string) => Promise<boolean>;
  registryIo?: RegistryIo;
  /** Reads when processes started. Defaults to asking `ps`. */
  readProcessStarts?: ReadProcessStarts;
  /** How long `claude agents --json` gets. Defaults to 5 seconds. */
  feedTimeoutMs?: number;
  /** How often the command is run. Defaults to 30 seconds. */
  feedIntervalMs?: number;
  /** How often it is run while the registry cannot be relied on. Defaults to 5 seconds. */
  feedFallbackIntervalMs?: number;
  /**
   * How often the poller calls `poll()`, which is how often the registry is
   * read. The adapter keeps no timer of its own: this is only stated in
   * `watching`. Defaults to the poller's interval.
   */
  pollIntervalMs?: number;
}

/** What the last run of the command came back with. */
interface FeedRead {
  /** The time of the poll that asked. */
  askedAt: number;
  feed: FeedResult;
  /** False when no binary was found, so nothing was run. */
  binaryFound: boolean;
  /** True when `AGENT_LOOKOUT_CLAUDE_BIN` names something that cannot be run. */
  badVariable: boolean;
  /** True when the binary was read without `--all`. */
  plain: boolean;
}

/** One reading of the registry folder. */
interface Reading {
  registry: RegistryRead;
  /** The registry's sessions that have a live process, in the order of their files. */
  live: RegistryEntry[];
  /** True when one of them has a status the mapping does not know. */
  unknownStatus: boolean;
}

/** Why the registry cannot be relied on for this poll. */
type RegistryProblem = "unreadable" | "unknown-status" | "lacks-a-session";

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** "every 2 seconds", for the facts and the sentences. */
function every(ms: number): string {
  const seconds = ms / 1000;
  return seconds === 1 ? "every second" : `every ${seconds} seconds`;
}

/** A session's start time, when it is one that could be real and falls after `since`. */
function startedAfter(entry: RegistryEntry, since: number, now: number): boolean {
  const startedAt = plausibleTime(entry.startedAt, now);
  return startedAt !== null && startedAt > since;
}

/**
 * Finds Claude Code sessions on this machine, in two places.
 *
 * The session registry under `<claude home>/sessions` holds one small file per
 * running session, which Claude Code rewrites as the session's status changes.
 * It is read on every poll, so a change shows within one poll. Reading it
 * starts no process and causes no network traffic. It is undocumented, so it is
 * not taken on trust.
 *
 * `claude agents --json --all` is the documented feed. It is run on the first
 * poll and every 30 seconds after that, and its answer outranks the registry:
 *
 * - It supplies the background jobs that have no live process: the finished and
 *   failed ones. The registry holds a file per live process and cannot.
 * - A registry session it did not list is left out, unless that session started
 *   too recently for the answer to have known about it.
 * - When it lists a running session the registry lacks, when a registry entry
 *   has a status the mapping does not know, or when the folder cannot be read,
 *   the registry is not relied on. Sessions then come from the command, which is
 *   run every 5 seconds until the registry can be relied on again.
 *
 * The command is run seldom because each run starts another vendor's program,
 * which costs CPU and may contact Anthropic the way Claude Code does for anyone
 * who runs it. Its answer is kept until the next run. When the command cannot
 * be found, or fails, the registry is used alone until it works.
 *
 * `AGENT_LOOKOUT_CLAUDE_FEED=off` stops the command being run at all. Sessions
 * then come from the registry alone, and background jobs whose process has
 * ended are not listed.
 *
 * `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude`, and it has to replace it for
 * the feed as well as for the registry, or a dashboard pointed at an empty or
 * fixture directory would still list this machine's real sessions. The `claude`
 * command reads the real folder and cannot safely be told otherwise: pointed
 * elsewhere with `CLAUDE_CONFIG_DIR`, it writes account details into that
 * directory (seen on 2.1.283). So when the variable is set, a `claude` found on
 * this machine is not run at all and only the named directory's registry is
 * read. The feed runs again when `AGENT_LOOKOUT_CLAUDE_BIN` names a program too,
 * because then the person has said exactly what to run.
 */
export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? isProcessAlive;
  const feedIntervalMs = options.feedIntervalMs ?? FEED_INTERVAL_MS;
  const feedFallbackIntervalMs = options.feedFallbackIntervalMs ?? FEED_FALLBACK_INTERVAL_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  const feedReader = createFeedReader(options.run ?? runProgram);
  const startCheck = createProcessStartCheck(options.readProcessStarts, now);
  const finished = createFinishedTracker();

  const homeOverride = env[CLAUDE_HOME_ENV]?.trim() || undefined;
  const binaryNamed = Boolean(env[CLAUDE_BIN_ENV]?.trim());
  const feedOff = env[CLAUDE_FEED_ENV]?.trim().toLowerCase() === "off";
  const feedWithheld = homeOverride !== undefined && !binaryNamed;
  const neverRun = feedOff || feedWithheld;

  const claudeHome = path.resolve(homeOverride ?? path.join(homeDir, ".claude"));
  const sessionsDir = path.join(claudeHome, "sessions");
  const homeName = tildify(claudeHome, homeDir);
  const registryName = tildify(sessionsDir, homeDir);

  /** The moment the last run of the command was due. Null until the first run. */
  let lastDue: number | null = null;
  /** What the last run came back with. It stands until the next run. */
  let lastRead: FeedRead | null = null;

  const noRegistry = (missing: boolean) =>
    missing
      ? `there is no session registry at ${registryName}`
      : `the session registry at ${registryName} could not be read`;

  const withheldNote = `The claude command is not run, because it would list the sessions of the usual Claude Code folder. Set ${CLAUDE_BIN_ENV} as well to name a command to run.`;
  const offNote = `${CLAUDE_FEED_ENV} is off, so the claude command is not run`;
  const noEndedJobs = "Background jobs whose process has ended are not listed.";
  const oddStatus = `a session in the registry at ${registryName} has a status Agent Lookout does not know`;

  function watching(registryRead: string, commandRun: string, plain: boolean): SourceFact[] {
    const args = plain ? FEED_ARGS_WITHOUT_ALL : FEED_ARGS;
    return [
      { label: "Registry folder", value: registryName },
      { label: "Registry read", value: registryRead },
      { label: "Command", value: `claude ${args.join(" ")}` },
      { label: "Command run", value: commandRun },
    ];
  }

  /**
   * Reads the registry and picks out its live sessions.
   *
   * A registry file that outlives its process is a leftover from a crash, so an
   * entry whose process has gone is not a session. An entry with no session id,
   * or of a kind that is not a session, is one of Claude Code's helper processes.
   */
  async function readRegistryNow(at: number): Promise<Reading> {
    const registry = await readRegistry(sessionsDir, options.registryIo);
    if (!registry.readable) return { registry, live: [], unknownStatus: false };

    const candidates = [...registry.entries.values()].filter(
      (entry) =>
        entry.sessionId !== undefined && isClaudeCodeSessionKind(entry.kind) && isAlive(entry.pid),
    );
    // A leftover whose pid has since been given to another program looks alive.
    // Its recorded start time gives it away.
    const reused = await startCheck.reused(candidates);
    const live = candidates.filter((entry) => !reused.has(entry.pid));

    // A session writes its registry file first and its status a moment later.
    // One that says nothing about its status yet and has only just started is
    // still starting. Any other status the mapping does not know means the
    // format is not the one this adapter was written for.
    const unknownStatus = live.some((entry) => {
      if (mapClaudeCodeStatus(entry, "registry").status !== "unknown") return false;
      const saysNothing = entry.status === undefined && entry.state === undefined;
      return !(saysNothing && startedAfter(entry, at - NEW_SESSION_GRACE_MS, at));
    });
    return { registry, live, unknownStatus };
  }

  /**
   * Whether the command listed a session, with a process that is alive now,
   * that is not among the registry's. A malformed registry file does this, and
   * so would a registry that had stopped being written the way it is today.
   */
  function lacksOne(entries: readonly FeedEntry[], live: readonly RegistryEntry[]): boolean {
    const pids = new Set(live.map((entry) => entry.pid));
    const sessionIds = new Set(live.map((entry) => entry.sessionId));
    return entries.some(
      (entry) =>
        entry.pid !== undefined &&
        !pids.has(entry.pid) &&
        !(entry.sessionId !== undefined && sessionIds.has(entry.sessionId)) &&
        isAlive(entry.pid),
    );
  }

  /** Why this reading cannot be relied on, or null when it can. */
  function problemWith(reading: Reading, read: FeedRead | null): RegistryProblem | null {
    if (!reading.registry.readable) return "unreadable";
    if (reading.unknownStatus) return "unknown-status";
    if (read?.feed.ok && lacksOne(read.feed.entries, reading.live)) return "lacks-a-session";
    return null;
  }

  /**
   * The moment a run of the command is due, when that moment has come.
   *
   * Runs are due at a steady beat counted from the first one, not from whenever
   * the last one happened to start. A poll comes every two seconds, so a run due
   * every 5 seconds happens at the first poll on or after each fifth second:
   * twelve a minute, not ten. When a whole beat was missed, as after the
   * computer slept, or the clock was set back, the beat starts again from now.
   */
  function dueAt(at: number, intervalMs: number): number | null {
    if (lastDue === null || at < lastDue - DUE_SLACK_MS) return at;
    const due = lastDue + intervalMs;
    if (at < due - DUE_SLACK_MS) return null;
    return at - due < intervalMs ? due : at;
  }

  async function runCommand(askedAt: number): Promise<FeedRead> {
    const binary = await findClaudeBinary({ env, homeDir, isExecutable: options.isExecutable });
    if (!binary.found) {
      return {
        askedAt,
        feed: { ok: false, problem: binary.looked },
        binaryFound: false,
        badVariable: binaryNamed,
        plain: false,
      };
    }
    const feed = await feedReader.read(binary.path, { timeoutMs: options.feedTimeoutMs, env });
    return {
      askedAt,
      feed,
      binaryFound: true,
      badVariable: false,
      plain: feedReader.readsPlainly(binary.path),
    };
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    const context: SessionContext = { now: checkedAt, isAlive };

    // How often the command is due depends on whether the registry can be relied
    // on, so the registry is read first. On the first poll the command is due
    // whatever the registry says.
    let reading = neverRun || lastDue !== null ? await readRegistryNow(checkedAt) : null;
    if (!neverRun) {
      const reliedOn = reading !== null && problemWith(reading, lastRead) === null;
      const due = dueAt(checkedAt, reliedOn ? feedIntervalMs : feedFallbackIntervalMs);
      if (due !== null) {
        lastDue = due;
        // Should the run break its promise not to throw, this is what is left of
        // it, and the next poll does not run it again ahead of time.
        lastRead = {
          askedAt: checkedAt,
          feed: { ok: false, problem: COULD_NOT_RUN },
          binaryFound: true,
          badVariable: false,
          plain: false,
        };
        lastRead = await runCommand(checkedAt);
        // An answer is newer than a reading made before it. Reading again keeps
        // a session that started in between from being taken for one the
        // registry lacks.
        if (lastRead.feed.ok) reading = null;
      }
    }
    reading ??= await readRegistryNow(checkedAt);

    const read = lastRead;
    const answer = read?.feed.ok ? read.feed.entries : null;
    const problem = problemWith(reading, read);
    const { registry, live } = reading;

    const fallbackEvery = every(feedFallbackIntervalMs);
    const facts = watching(
      registry.readable ? every(pollIntervalMs) : registry.missing ? "not found" : "cannot be read",
      neverRun
        ? "not run"
        : read !== null && !read.binaryFound
          ? "not found"
          : every(problem === null ? feedIntervalMs : feedFallbackIntervalMs),
      read?.plain ?? false,
    );
    const health = (state: SourceState, detail: string, advice?: string): SourceHealth => ({
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: facts,
      ...(advice !== undefined && { advice }),
      checkedAt,
    });

    if (answer !== null && read !== null && problem === null) {
      // The registry's sessions, checked against the answer. One the answer did
      // not list is believed only if it started too recently to be in it.
      const listedPids = new Set(answer.map((entry) => entry.pid));
      const listedSessionIds = new Set(answer.map((entry) => entry.sessionId));
      const tooNewSince = read.askedAt - NEW_SESSION_GRACE_MS;
      const fromRegistry = live.filter(
        (entry) =>
          listedPids.has(entry.pid) ||
          listedSessionIds.has(entry.sessionId) ||
          startedAfter(entry, tooNewSince, checkedAt),
      );

      // The background jobs only the answer knows: those with no live process.
      const livePids = new Set(live.map((entry) => entry.pid));
      const liveSessionIds = new Set(live.map((entry) => entry.sessionId));
      const jobs = answer
        .filter(
          (entry) =>
            (entry.id !== undefined || entry.state !== undefined) &&
            !(entry.pid !== undefined && livePids.has(entry.pid)) &&
            !(entry.sessionId !== undefined && liveSessionIds.has(entry.sessionId)),
        )
        .map((entry) => {
          // A job whose process has gone since the answer keeps the state the
          // answer gave it until the next one. Its live status went with the
          // process.
          const gone = entry.pid !== undefined && !isAlive(entry.pid);
          return sessionFromFeed(
            gone ? { ...entry, status: undefined } : entry,
            undefined,
            context,
          );
        });

      const sessions = [
        ...fromRegistry.map((entry) => sessionFromRegistry(entry, context)),
        ...jobs,
      ];
      const detail = `Sessions are read from Claude Code's session registry and checked against its own list of sessions.${
        read.plain
          ? " This version of Claude Code cannot list background jobs whose process has ended."
          : ""
      }`;
      return {
        health: health("ok", detail),
        sessions: finished.keepRecent(uniqueById(sessions), checkedAt),
        basis: "registry+feed",
      };
    }

    if (answer !== null && problem !== null) {
      // The registry is not relied on, so the answer decides what sessions exist
      // and what they are doing. Whatever the registry can still say about one
      // of them adds its app and its status time.
      const entries = registry.readable ? registry.entries : undefined;
      const sessions = answer.map((entry) =>
        sessionFromFeed(
          entry,
          entry.pid !== undefined ? entries?.get(entry.pid) : undefined,
          context,
        ),
      );
      let detail: string;
      if (problem === "unreadable") {
        detail = `${capitalise(noRegistry(!registry.readable && registry.missing))}, so sessions are listed with the claude command ${fallbackEvery} instead. Their apps and status times are unknown.`;
      } else if (problem === "unknown-status") {
        detail = `${capitalise(oddStatus)}, so sessions are listed with the claude command ${fallbackEvery} instead.`;
      } else {
        detail = `The claude command lists a running session that the registry at ${registryName} does not have, so sessions are listed with the claude command ${fallbackEvery} until the two agree.`;
      }
      return {
        health: health("ok", detail),
        sessions: finished.keepRecent(uniqueById(sessions), checkedAt),
        basis: "feed",
      };
    }

    // From here on there is no answer from the command: it is not run, it was
    // not found, or its last run failed. The finished jobs it listed before are
    // not shown, and the record of when each was first seen over is left alone,
    // so their 24 hours do not start again when the command next answers.

    // When both variables keep the command from running, the one that says so
    // outright is the one named.
    const withheld = feedWithheld && !feedOff;
    const whyNoAnswer = feedOff
      ? offNote
      : withheld
        ? `${CLAUDE_HOME_ENV} is set, so the claude command is not run`
        : read !== null && !read.feed.ok
          ? read.feed.problem
          : COULD_NOT_RUN;

    if (registry.readable) {
      const sessions = uniqueById(live.map((entry) => sessionFromRegistry(entry, context)));
      let detail: string;
      if (problem === "unknown-status") {
        detail = `${whyNoAnswer}, and ${oddStatus}. Sessions are read from the registry alone, and that status is shown as unknown.`;
      } else if (feedOff) {
        detail = `${CLAUDE_FEED_ENV} is off, so sessions are read from the session registry alone. ${noEndedJobs}`;
      } else if (withheld) {
        detail = `${CLAUDE_HOME_ENV} is set, so sessions are read from the registry in that folder alone. ${withheldNote}`;
      } else {
        detail = `${whyNoAnswer}, so sessions are read from the session registry alone. ${noEndedJobs}`;
      }
      return { health: health("ok", detail), sessions, basis: "registry" };
    }

    // Someone who names a directory means that directory. If it has no sessions
    // folder it holds no sessions, and that is an answer, not a failure.
    if (registry.missing && homeOverride !== undefined) {
      const emptyNote = `${CLAUDE_HOME_ENV} is set to ${homeName}, which has no sessions folder, so no sessions are listed`;
      const detail = feedOff
        ? `${emptyNote}. ${capitalise(offNote)}.`
        : withheld
          ? `${emptyNote}. ${withheldNote}`
          : `${whyNoAnswer}, and ${emptyNote}.`;
      return { health: health("ok", detail), sessions: [], basis: "registry" };
    }

    // Neither way of reading worked.
    const unread = "Claude Code sessions could not be read.";
    const detail = withheld
      ? `${unread} ${CLAUDE_HOME_ENV} is set, and ${noRegistry(registry.missing)}. ${withheldNote}`
      : `${unread} ${whyNoAnswer}, and ${noRegistry(registry.missing)}.`;
    // What to do about it is known in one case: the person named a program that
    // cannot be run. Installing Claude Code would not help them.
    const advice = read?.badVariable ? `Correct ${CLAUDE_BIN_ENV}, or unset it.` : undefined;
    return { health: health("unavailable", detail, advice), sessions: [] };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    lookingIn: neverRun
      ? `Looking for sessions in ${registryName}.`
      : `Looking for sessions in ${registryName} and with claude ${FEED_ARGS.join(" ")}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return {
          health: {
            id: SOURCE_ID,
            label: LABEL,
            state: "error",
            detail: "Something unexpected went wrong while reading Claude Code sessions.",
            watching: watching(
              every(pollIntervalMs),
              neverRun ? "not run" : every(feedIntervalMs),
              false,
            ),
            checkedAt: now(),
          },
          sessions: [],
        };
      }
    },
  };
}
