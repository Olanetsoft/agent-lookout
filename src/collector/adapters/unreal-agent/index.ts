import os from "node:os";
import path from "node:path";

import {
  guardUnrealAgentClock,
  startUnrealAgentClockGuard,
  unrealAgentLiveness,
  WRITE_TIME_STEP_MS,
  type UnrealAgentPrograms,
} from "../../../core/mapping/unreal-agent/unrealAgentLiveness.ts";
import {
  unrealAgentEnded,
  unrealAgentPhaseNow,
} from "../../../core/mapping/unreal-agent/unrealAgentMapping.ts";
import { runBeganBy } from "../../../core/mapping/unreal-agent/unrealAgentReplay.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { createSessionFileFinder, type SessionFileRef } from "../pi/sessionFiles.ts";
import { every } from "../words.ts";
import { isSessionFileName } from "./lines.ts";
import {
  createUnrealProcessReader,
  noUnrealIn,
  UNREAL_TABLE_ARGS,
  type UnrealProcessReader,
} from "./processes.ts";
import { createUnrealAgentSessionReader, type UnrealAgentSessionFile } from "./sessionFile.ts";
import { SOURCE_ID, unrealAgentSession } from "./toSession.ts";

export { SOURCE_ID } from "./toSession.ts";

/**
 * The Unreal Agent adapter. Unreal Agent is Unreal Labs' coding agent, a
 * terminal app and a runner built from Go, which keeps each session in one
 * file. See docs/adapters/unreal-agent.md. Built from Unreal Agent's source at
 * v0.3.1 (MIT), and not yet checked on a computer running Unreal Agent.
 */

const LABEL = "Unreal Agent";

/** The variable that names Unreal Agent's sessions folder, for Agent Lookout alone. */
export const UNREAL_AGENT_SESSION_DIR_ENV = "AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR";

/** Unreal Agent's own variable for the folder its sessions folder is in, when it is absolute. */
export const UNREAL_AGENT_STATE_ENV = "XDG_STATE_HOME";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked when Unreal Agent's programs started, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it showed no
 * Unreal Agent program, or up to 2 seconds before, as a disk can keep a
 * write's time rounded down, since one may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the files while `ps` shows an Unreal Agent program. */
export const BASIS = "files";

/**
 * The way it reads while `ps` shows no Unreal Agent program, when every
 * session is finished, except those whose last reply failed and those whose
 * end cannot be told. Closing the last program finishes them all at once, so
 * such a poll is named apart and compared only with the last time none ran.
 */
export const BASIS_CLOSED = "files-closed";

/**
 * The way it reads while `ps` cannot say which Unreal Agent programs run,
 * when no session is shown as idle, nor as finished unless its file says it
 * ended. Named apart, so every finished session does not seem to start again
 * and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever Unreal Agent is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Unreal Agent writes no lock or pid file, so a session is tied to a running program only by when each started: it is finished once no Unreal Agent program that started before its last write runs, and unknown when more sessions look open than such programs run.";

/** Said whenever Unreal Agent is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Unreal Agent's source at v0.3.1 and not yet checked on a computer running Unreal Agent, so a status can be wrong.";

/** Said when a file's first line is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "An Unreal Agent newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/** Said when a file holds a line this does not read. */
export const UNREAD_NOTE =
  "Some sessions hold a line Agent Lookout does not know, perhaps from a newer Unreal Agent, so they show as unknown.";

/** Said when a session that looks idle is too long to read from its start. */
export const LONG_NOTE =
  "Some sessions are longer than 64 MiB, too long to read from their start, so they show as unknown while Unreal Agent waits in them.";

/** Said when more sessions look open than programs that could hold them run. */
export const COUNT_NOTE =
  "More Unreal Agent sessions look open than Unreal Agent programs that could hold them, so some show as unknown.";

/** Said on Windows, where Unreal Agent does not run. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read Unreal Agent's sessions on Windows, where Unreal Agent does not run.";

/**
 * What an Unreal Agent session can show, from the files this adapter reads and
 * `ps`. See docs/adapters/unreal-agent.md for each. Built from Unreal Agent's
 * source at v0.3.1 and not yet checked on a computer running it.
 *
 * - Working and idle from its file, on macOS and Linux. A busy session is
 *   unknown after 30 quiet minutes, and an idle one when more sessions look
 *   open than programs run.
 * - No Needs you: Unreal Agent asks no approval before a command runs, and its
 *   tools, Bash, ViewImage and SkillUse, ask nothing (tool/registry.go:18-20).
 * - Finished on Ctrl+C, when a runner ends idle, or once `ps` shows no Unreal
 *   Agent program that started before the last write.
 * - Failed when the newest reply failed, was refused or hit its token limit.
 *   A request that fails outright is not written.
 * - The name is the folder's, once a command has run in it, else its id.
 * - No Jump, Stop or Answer: the file names no process or terminal, and
 *   Unreal Agent never asks for an approval.
 * - Quiet for is the time since the file was last written.
 * - No Tokens: a reply's counts are on its line, after its text.
 */
export const UNREAL_AGENT_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From its file, on macOS and Linux. Unknown after 30 quiet minutes, or when more sessions look open than programs run.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Unreal Agent asks no approval before a command runs and has no tool that asks you anything, so it never waits for you.",
  },
  finished: {
    level: "partly",
    reason:
      "On Ctrl+C, when a runner ends idle, or once ps shows no Unreal Agent program that started before the last write.",
  },
  failed: {
    level: "partly",
    reason:
      "When the newest reply failed, was refused or hit its token limit. A request that fails outright shows working, then finished.",
  },
  names: {
    level: "partly",
    reason:
      "The folder's, once a command has run in it, else the session's id. Unreal Agent gives a session no name.",
  },
  jump: { level: "no", reason: "A session's file names no process or terminal." },
  "quiet-for": { level: "yes" },
  tokens: {
    level: "no",
    reason: "A reply's counts are on its line, after its text, and are not read.",
  },
  stop: {
    level: "no",
    reason: "A session's file names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Unreal Agent never asks for an approval, so there is nothing to answer.",
  },
};

/**
 * The folder this adapter reads: the one
 * `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` names, for Agent Lookout alone;
 * else, as Unreal Agent works it out (`cmd/internal/xdgpath/directory.go`),
 * `unreal-agent/sessions` in `XDG_STATE_HOME` when that is an absolute path,
 * else `~/.local/state/unreal-agent/sessions`, on macOS too. A runner's
 * `-session-directory` is not followed: a process's arguments are never read.
 */
export function unrealAgentSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = env[UNREAL_AGENT_SESSION_DIR_ENV]?.trim();
  if (own) return path.resolve(own);
  const state = env[UNREAL_AGENT_STATE_ENV];
  if (state !== undefined && path.isAbsolute(state)) {
    return path.join(state, "unreal-agent", "sessions");
  }
  return path.join(homeDir, ".local", "state", "unreal-agent", "sessions");
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface UnrealAgentAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  /** A clock that is never set, for telling when the other one was. Defaults to `performance.now()`. */
  monotonic?: () => number;
  io?: ReadOnlyIo;
  /** The system it runs on, which says whether anything is read and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What asks `ps` when Unreal Agent's programs started. Defaults to one that runs `ps`. */
  processes?: UnrealProcessReader;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often the sessions folder is listed and every session file looked up. Defaults to a minute. */
  sweepMs?: number;
}

/** One file this poll read. */
interface Listed {
  file: UnrealAgentSessionFile;
  writtenAt: number;
}

/**
 * Finds Unreal Agent's sessions on this machine from the files Unreal Agent
 * keeps, with nothing installed, no setting changed and no program of Unreal
 * Agent's run. Built from Unreal Agent's source at v0.3.1, and not yet checked
 * on a computer running it.
 *
 * Unreal Agent keeps each session in `<id>.session.jsonl`, in one sessions
 * folder. A poll lists that folder, without going into any folder in it, and
 * looks up each name of a session file with `lstat`: those written in the
 * last day, the 200 newest (`../pi/sessionFiles.ts`). It opens a file only
 * when it changes or a whole read is due, and reads its first line, its last
 * 8 MiB, and then only what was added, and for a session that looks idle, or
 * did at a hard stop, and was not read from its start, the whole file once,
 * up to 64 MiB (`sessionFile.ts`). Each line is compared, as bytes, with the
 * shapes Unreal Agent writes (`lines.ts`).
 * Nothing else of Unreal Agent's is opened: not the `operations` folder that
 * holds every command's output, not a `.session-*.tmp` file, and no setting
 * or key. While there are sessions to show, it asks `ps` when each Unreal
 * Agent program started, at most every 10 seconds, and sooner, though not
 * within 2 seconds of the last ask, when a session is written after `ps`
 * showed none (`processes.ts`).
 *
 * A session's status is `unrealAgentMapping.ts`'s: working while a turn is
 * open, an input waits or a command runs, idle once its newest regular turn
 * is answered with nothing left to run, failed when that reply failed,
 * finished when the terminal app quit with Ctrl+C, a runner went idle, or no
 * Unreal Agent program that started before its last write runs, and unknown
 * when that cannot be told. It never shows as needing you.
 *
 * Unreal Agent runs on macOS and Linux only, so nothing is read on Windows.
 * Unreal Agent not being installed costs nothing: when its folder is missing,
 * the adapter says so and looks again only once a minute, and runs nothing.
 * Someone who sets `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` means that
 * folder: if it holds no sessions, that is an answer, not a missing Unreal
 * Agent.
 */
export function createUnrealAgentAdapter(options: UnrealAgentAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createUnrealProcessReader({ platform });

  const named = Boolean(env[UNREAL_AGENT_SESSION_DIR_ENV]?.trim());
  const sessionsDir = unrealAgentSessionsDirFor(env, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const finder = createSessionFileFinder({
    sessionsDir,
    io,
    sweepMs: options.sweepMs,
    flat: true,
    fileName: isSessionFileName,
  });
  const reader = createUnrealAgentSessionReader(io, platform);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastAnswer: UnrealAgentPrograms | null = null;
  let processesAt = 0;
  /** When `ps` last showed no Unreal Agent program, in memory only. */
  let noUnrealAt: number | null = null;
  let clockGuard = startUnrealAgentClockGuard();

  const windows = platform === "win32";
  const psRuns = platform === "darwin" || platform === "linux";
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no Unreal Agent`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${windows ? "Windows" : "this system"}`;

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
    basis: string = unaskedBasis,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        { label: "Process check", value: `ps ${UNREAL_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ] satisfies SourceFact[],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** Unreal Agent is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Unreal Agent was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written
   * after it showed no Unreal Agent program, or up to 2 seconds before, as a
   * disk can keep a write's time rounded down. A clock set back counts as
   * time enough.
   */
  async function processesFor(
    listed: readonly Listed[],
    checkedAt: number,
  ): Promise<UnrealAgentPrograms> {
    const since = checkedAt - processesAt;
    let due = lastAnswer === null || since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastAnswer !== null && noUnrealIn(lastAnswer)) {
      due = listed.some(({ writtenAt }) => writtenAt > processesAt - WRITE_TIME_STEP_MS);
    }
    if (lastAnswer === null || due) {
      lastAnswer = await processes.read();
      processesAt = checkedAt;
      if (noUnrealIn(lastAnswer)) noUnrealAt = checkedAt;
    }
    // A time ahead of this poll's is from a clock set back.
    if (noUnrealAt !== null && noUnrealAt > checkedAt) noUnrealAt = null;
    return lastAnswer;
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (windows) return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
    clockGuard = guardUnrealAgentClock(clockGuard, {
      platform,
      wall: checkedAt,
      mono: monotonic(),
    });

    // A missing Unreal Agent is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time
    // enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let refs: SessionFileRef[];
    try {
      refs = await finder.recent(checkedAt);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Unreal Agent sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      finder.forget();
      reader.keepOnly(new Set());
      if (named) {
        return result(
          "ok",
          `${UNREAL_AGENT_SESSION_DIR_ENV} is set, and there is no ${sessionsName} folder, so no Unreal Agent sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const listed: Listed[] = [];
    let newer = false;
    for (const ref of refs) {
      const read = await reader.read(ref, checkedAt);
      if (read.state === "newer") newer = true;
      if (read.state === "ok") listed.push({ file: read.file, writtenAt: ref.info.mtimeMs });
    }
    reader.keepOnly(new Set(refs.map((ref) => ref.path)));

    // `ps` is asked only while there is a session to show.
    const asked = listed.length > 0 ? await processesFor(listed, checkedAt) : null;
    const ended = listed.map(({ file, writtenAt }) =>
      unrealAgentEnded(file.replay, writtenAt, checkedAt),
    );
    const liveness = unrealAgentLiveness(
      { programs: asked, processesAt, noUnrealAt, l3Floor: clockGuard.l3Floor },
      listed.map(({ file, writtenAt }, index) => ({
        writtenAt,
        key: runBeganBy(file.replay) ?? writtenAt,
        ended: ended[index] ?? false,
      })),
    );

    let unread = false;
    let long = false;
    let counted = false;
    const sessions = listed.map(({ file, writtenAt }, index) => {
      const held = liveness[index] ?? { liveness: "cannot-tell", rule: "L0" };
      const session = unrealAgentSession({
        file,
        liveness: held.liveness,
        writtenAt,
        now: checkedAt,
      });
      const { phase } = unrealAgentPhaseNow(file.replay, writtenAt, checkedAt);
      if (phase === "unread") unread = true;
      if (phase === "unsure" && file.tooLong) long = true;
      if (session.status === "unknown" && held.rule === "L4" && phase === "waiting") counted = true;
      return session;
    });

    let detail = `Sessions are read from the files Unreal Agent keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether Unreal Agent runs, so no session is shown as idle, nor as finished unless Unreal Agent wrote that it ended."
        : " Agent Lookout cannot tell on this system whether Unreal Agent runs, so no session is shown as idle, nor as finished unless Unreal Agent wrote that it ended.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked !== null && noUnrealIn(asked)) {
      detail +=
        " No Unreal Agent program runs, so each session shows as finished, unless its last reply failed or Agent Lookout cannot tell how it ended.";
      basis = BASIS_CLOSED;
    }
    if (long) detail += ` ${LONG_NOTE}`;
    if (unread) detail += ` ${UNREAD_NOTE}`;
    if (counted) detail += ` ${COUNT_NOTE}`;
    if (newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: UNREAL_AGENT_CAPABILITIES,
    lookingIn: `Looking for Unreal Agent sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Unreal Agent sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
