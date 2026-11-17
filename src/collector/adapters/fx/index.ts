import os from "node:os";

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
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import { createLogReader, type FxLog } from "./logFile.ts";
import { createLogFinder } from "./logFiles.ts";
import {
  fxFolderFor,
  sessionsDirOf,
  sessionsFolder,
  FX_HOME_ENV,
  SESSIONS_FOLDERS,
} from "./paths.ts";
import {
  createAbsenceTracker,
  createFxProcessReader,
  FX_TABLE_ARGS,
  programsOf,
  WRITE_TIME_STEP_MS,
  type FxProcessAnswer,
  type FxProcessReader,
} from "./processes.ts";
import { fxSession, SOURCE_ID } from "./toSession.ts";

export { FX_HOME_ENV, FX_OWN_HOME_ENV } from "./paths.ts";
export { MAX_SESSIONS, SWEEP_MS } from "./logFiles.ts";
export { SOURCE_ID } from "./toSession.ts";

/**
 * The fx adapter. fx is Vercel Labs' coding agent, one program built from Zig,
 * which keeps each session in a log of its own. See docs/adapters/fx.md.
 * Built from fx's source at v0.0.17 (Apache-2.0), and not yet checked on a
 * computer running fx.
 */

const LABEL = "fx";

/** How long a sessions folder that was not there, or not a real folder, is believed so before it is looked at again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked which fx programs run, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no fx
 * program runs, or up to 2 seconds before, as a disk can keep a write's time
 * rounded down, since fx may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the logs while `ps` shows an fx program. */
export const BASIS = "files";

/**
 * The way it reads while `ps` shows no fx program, when every session is
 * finished, except those that failed and those that cannot be read, which
 * stay as they are. Closing the last fx finishes every session at once, so
 * such a poll is named apart and compared only with the last time none ran.
 */
export const BASIS_CLOSED = "files-closed";

/**
 * The way it reads while `ps` cannot say which fx programs run, when no
 * session is shown as working or finished. Named apart, so every finished
 * session does not seem to start again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever fx is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "fx writes when a turn starts and ends, and nothing while it waits for you or between turns. So a session waiting for your answer shows as working for up to 30 quiet minutes and then as unknown, and a session between turns shows as unknown while an fx program runs and as finished once none does. Any other program named fx, such as a JSON viewer of that name, can keep sessions from showing as finished.";

/** Said whenever fx is watched: why fx's own list of open sessions is not asked. */
export const FILES_ONLY_NOTE =
  "fx's own list of open sessions, fx sessions --live, tries each session's lock and can write to fx's index, so Agent Lookout reads fx's files alone.";

/** Said whenever fx is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from fx's source at v0.0.17 and not yet checked on a computer running fx, so a status can be wrong.";

/** Said when a log's first line is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "An fx newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/** Said when a log ends in a way this does not read. */
export const UNKNOWN_END_NOTE =
  "Some sessions end in a way Agent Lookout does not know, perhaps from a newer fx, so they show as unknown.";

/** Said on Windows, where fx does not run. */
export const WINDOWS_DETAIL =
  "fx runs on macOS and Linux only, so Agent Lookout reads nothing of fx's on Windows.";

/** Said on a system that is neither macOS, Linux nor Windows. */
export const OTHER_SYSTEM_DETAIL =
  "fx runs on macOS and Linux only, so Agent Lookout reads nothing of fx's here.";

/** Said when `FX_HOME` names fx's folder through a `.` or a `..`. */
export const DOTTED_DETAIL =
  "FX_HOME names fx's folder through . or .., which Agent Lookout does not follow, so it reads nothing of fx's. AGENT_LOOKOUT_FX_HOME can name the folder instead.";

/**
 * What an fx session can show, from the logs this adapter reads and `ps`.
 * See docs/adapters/fx.md for each. Built from fx's source at v0.0.17 and
 * not yet checked on a computer running it.
 *
 * - Working while the log has an open turn and an fx program runs that could
 *   hold it. Never idle: fx writes nothing between turns.
 * - No Needs you: fx keeps its approvals and questions in memory.
 * - Finished once `ps` shows no fx program, or once every fx program running
 *   was missing from `ps` more than 2 seconds after a cut-off turn's last
 *   write.
 * - Failed when fx ends a turn as failed.
 * - The name is the folder's. fx's titles are most often the first line of
 *   the person's prompt.
 * - No Jump, Stop or Answer: the log names no process or terminal, and no
 *   request is made to fx.
 * - Quiet for is the time since the log was last written, for up to 30
 *   minutes.
 * - No Tokens: fx keeps a session's running totals, which are not read.
 */
export const FX_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Working while fx's log has an open turn and an fx program that could hold it runs. Idle never shows: fx writes nothing for it.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Approvals and questions stay in fx's memory, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no fx, or ps missed every fx running over 2 seconds after a cut-off turn's last write. Another fx can hold it off.",
  },
  failed: {
    level: "partly",
    reason:
      "When fx ends a turn as failed. fx records a turn a crash cut off as a crash, which does not show as failed.",
  },
  names: {
    level: "partly",
    reason:
      "The folder's. Most fx titles are the first line of your prompt, and no line says which, so none is read.",
  },
  jump: { level: "no", reason: "The log fx keeps names no process or terminal." },
  "quiet-for": {
    level: "partly",
    reason:
      "From each session's own log, for up to 30 minutes: after that a working session shows as unknown.",
  },
  tokens: {
    level: "no",
    reason:
      "The log keeps a session's running totals, not a reply's counts, and they are not read.",
  },
  stop: {
    level: "no",
    reason: "The log fx keeps names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to fx, and fx keeps its approvals in memory.",
  },
};

/**
 * The folder of fx's session folders, `<fx's folder>/sessions/v2`, as this
 * adapter works it out: in the folder `AGENT_LOOKOUT_FX_HOME` names, for
 * Agent Lookout alone, else in the one `FX_HOME` names, as fx takes it, else
 * in `~/.fx`. Null when `FX_HOME` names it through a `.` or a `..`, when
 * nothing is read.
 */
export function fxSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const folder = fxFolderFor(env, homeDir);
  return folder.from === "dotted" ? null : sessionsDirOf(folder.folder);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface FxAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system it runs on, which says whether anything is read. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What asks `ps` which fx programs run. Defaults to one that runs `ps`. */
  processes?: FxProcessReader;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /**
   * How often the poller calls `poll()`, which is how often the logs are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often `v2` is listed and every log looked up. Defaults to a minute. */
  sweepMs?: number;
}

/** One log this poll listed. */
interface Listed {
  log: FxLog;
  writtenAt: number;
}

/**
 * Finds fx's sessions on this machine from the logs fx keeps, with nothing
 * installed, no setting changed and no program of fx's run. Built from fx's
 * source at v0.0.17, and not yet checked on a computer running it.
 *
 * fx keeps each session in `~/.fx/sessions/v2/<id>/log.jsonl`, or under the
 * folder `FX_HOME` names. A poll looks up `v2`, lists it when it changed or
 * once a minute, and looks up each session's folder and log written in the
 * last day, with `lstat` (`logFiles.ts`). It opens a log only when it
 * changes, and reads its first line once and, from its end, the lines that
 * say how its last turn stands, judged as bytes with fx's own checksum
 * (`logFile.ts`, `logLines.ts`). Nothing else of fx's is opened: not its
 * list of sessions, which holds their titles, not a session's lock or its
 * blobs, and no setting or key. While there are sessions to show, it asks
 * `ps` which fx programs run, at most every 10 seconds, and sooner, though
 * not within 2 seconds of the last ask, when a session is written after `ps`
 * said none runs, or up to 2 seconds before, as a disk can keep a write's
 * time rounded down (`processes.ts`).
 *
 * fx's own list of open sessions, `fx sessions --live`, is never run: it
 * tries each session's lock, which can make an fx that opens the session at
 * that moment fail, and its listing can write to fx's index.
 *
 * Each session written in the last day is listed, except a subagent's, which
 * fx keeps beside its parent's. Its status is `fxMapping.ts`'s: working
 * while its turn is open and an fx program runs, failed when fx ended its
 * turn as failed, finished once no fx program runs, or, while its turn is
 * open, once each one running was missing from `ps` more than 2 seconds
 * after the last write, and unknown otherwise. It never shows as idle or as
 * needing you.
 *
 * fx runs on macOS and Linux only, so nothing is read on any other system.
 * fx not being installed costs nothing: when its folder is missing, the
 * adapter says so and looks again only once a minute, and runs nothing.
 * Someone who sets `AGENT_LOOKOUT_FX_HOME` means that folder: if it holds no
 * sessions, that is an answer, not a missing fx.
 */
export function createFxAdapter(options: FxAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createFxProcessReader({ platform });

  const fxFolder = fxFolderFor(env, homeDir);
  const named = fxFolder.from === "agent-lookout";
  const sessionsDir = sessionsDirOf(fxFolder.folder);
  // A dotted FX_HOME is named as it is given: Node's join would apply its `..`
  // and name another folder.
  const sessionsName = tildify(
    fxFolder.from === "dotted" ? [fxFolder.folder, ...SESSIONS_FOLDERS].join("/") : sessionsDir,
    homeDir,
  );
  const finder = createLogFinder({ sessionsDir, io, sweepMs: options.sweepMs });
  const reader = createLogReader(io);
  const tracker = createAbsenceTracker();

  /** When the folder was last found missing, or not a real folder, and which. Null while it is there. */
  let away: { at: number; why: "missing" | "not-real" } | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastAnswer: FxProcessAnswer | null = null;
  let answeredAt = 0;

  const reads = platform === "darwin" || platform === "linux";
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no fx`
      : "";
  const processCheckRun = reads
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
    basis: string = BASIS,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        { label: "Process check", value: `ps ${FX_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ] satisfies SourceFact[],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** fx is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `fx was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  function notReal(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `${sessionsName}, or a folder above it in fx's folder, is a link or not a folder. fx itself will not keep sessions there, and Agent Lookout does not follow it. It looks again ${every(recheckMs)}.`,
      "not followed",
      checkedAt,
    );
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written
   * after it said no fx program runs, or up to 2 seconds before, as a disk
   * can keep a write's time rounded down, since one may have been started
   * since. A clock set back counts as time enough. Each answer is noted by the
   * tracker, at the time taken before `ps` ran.
   */
  async function processesFor(listed: readonly Listed[], checkedAt: number) {
    const since = checkedAt - answeredAt;
    let due = lastAnswer === null || since < 0 || since >= processCheckMs;
    if (
      !due &&
      since >= PROMPT_PROCESS_CHECK_MS &&
      lastAnswer !== null &&
      programsOf(lastAnswer) === "none"
    ) {
      due = listed.some(({ writtenAt }) => writtenAt + WRITE_TIME_STEP_MS > answeredAt);
    }
    if (lastAnswer === null || due) {
      lastAnswer = await processes.read();
      answeredAt = checkedAt;
      tracker.note(lastAnswer, checkedAt);
    }
    return lastAnswer;
  }

  const alwaysNotes = `${STATUS_NOTE} ${FILES_ONLY_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (!reads) {
      const detail = platform === "win32" ? WINDOWS_DETAIL : OTHER_SYSTEM_DETAIL;
      const read = platform === "win32" ? "not on Windows" : "not on this system";
      return result("unavailable", detail, read, checkedAt);
    }
    if (fxFolder.from === "dotted") {
      return result("unavailable", DOTTED_DETAIL, "not followed", checkedAt);
    }

    // A missing fx is believed missing for a while, so a machine without it
    // pays nothing on most polls. A clock set back counts as time enough.
    if (away !== null && !(named && away.why === "missing")) {
      const since = checkedAt - away.at;
      if (since >= 0 && since < recheckMs) {
        return away.why === "missing" ? notFound(checkedAt) : notReal(checkedAt);
      }
    }

    let v2: FileInfo | "not-real";
    try {
      v2 = await sessionsFolder(fxFolder.folder, io);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `fx sessions could not be read: ${sessionsName} could not be looked at.`,
          "cannot be read",
          checkedAt,
        );
      }
      finder.forget();
      reader.keepOnly(new Set());
      if (named) {
        away = null;
        return result(
          "ok",
          `${FX_HOME_ENV} is set, and there is no ${sessionsName} folder, so no fx sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      away = { at: checkedAt, why: "missing" };
      return notFound(checkedAt);
    }
    if (v2 === "not-real") {
      finder.forget();
      reader.keepOnly(new Set());
      away = { at: checkedAt, why: "not-real" };
      return notReal(checkedAt);
    }
    away = null;

    let found;
    try {
      found = await finder.recent(checkedAt, v2, reader.isChild);
    } catch {
      return result(
        "error",
        `fx sessions could not be read: the folder ${sessionsName} could not be listed.`,
        "cannot be read",
        checkedAt,
      );
    }

    const listed: Listed[] = [];
    let newer = false;
    let unknownEnd = false;
    for (const ref of found.refs) {
      const read = await reader.read(ref);
      if (read.state === "newer") newer = true;
      if (read.state !== "ok") continue;
      // A converted session keeps the times of the one it was made from.
      if (!isWithinRetention(read.log.newestTs, checkedAt)) continue;
      // A later line of a newer format leaves the session listed, as unknown.
      if (read.log.why === "newer" || read.log.why === "unknown-end") unknownEnd = true;
      // The time the log had as it was opened, so a write since its `lstat` counts
      // with the lines it added, or the `lstat`'s when what was read is older.
      listed.push({ log: read.log, writtenAt: Math.max(ref.info.mtimeMs, read.writtenAt) });
    }
    reader.keepOnly(found.ids);

    // `ps` is asked only while there is a session to show.
    const asked = listed.length > 0 ? await processesFor(listed, checkedAt) : null;
    const programs = asked === null ? "some" : programsOf(asked);
    const sessions = listed.map(({ log, writtenAt }) =>
      fxSession({
        log,
        programs,
        writerGone: tracker.writerGone(writtenAt),
        writtenAt,
        now: checkedAt,
      }),
    );

    let detail = `Sessions are read from the log fx keeps for each in ${sessionsName}. ${alwaysNotes}`;
    let basis = BASIS;
    if (programs === "unknown") {
      detail +=
        " ps could not be run to tell whether fx runs, so no session is shown as working or finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked !== null && programs === "none") {
      detail +=
        " No fx program runs, so each session shows as finished, unless it failed or cannot be read.";
      basis = BASIS_CLOSED;
    }
    if (unknownEnd) detail += ` ${UNKNOWN_END_NOTE}`;
    if (newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: FX_CAPABILITIES,
    lookingIn: `Looking for fx sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading fx sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
