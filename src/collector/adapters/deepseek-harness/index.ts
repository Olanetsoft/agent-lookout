import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
  continuedDeepseekHarnessWait,
  deepseekHarnessStatusOf,
  type DeepseekHarnessChild,
  type DeepseekHarnessTurn,
  type DeepseekHarnessWait,
} from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { WRITE_TIME_STEP_MS } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import { runPs } from "../../processes/ps.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import type { RunPs } from "../antigravity/cli/agyProcesses.ts";
import { every } from "../words.ts";
import { DEEPSEEK_HARNESS_HOME_ENV, deepseekHarnessHome } from "./home.ts";
import type { DeepseekHarnessHeader } from "./lines.ts";
import { createLogFinder, NotAFolderError, type FoundLogs, type LogRef } from "./logFiles.ts";
import { createDeepseekHarnessLogReader, type DeepseekHarnessLog } from "./logReader.ts";
import {
  createDshProcessReader,
  DSH_TABLE_ARGS,
  dshWriter,
  guardDshClock,
  startDshClockGuard,
  usable,
  type DshPrograms,
} from "./processes.ts";
import { deepseekHarnessSession, lastWriteOf, sessionIdOf, SOURCE_ID } from "./toSession.ts";
import { zstdOf, type ZstdDecoder } from "./zstdFrames.ts";

export { DEEPSEEK_HARNESS_HOME_ENV, DSH_HOME_ENV, deepseekHarnessSessionsDirFor } from "./home.ts";
export { SOURCE_ID } from "./toSession.ts";
export { zstdOf } from "./zstdFrames.ts";

/**
 * The DeepSeek Harness adapter. DeepSeek Harness, `dsh`, is DeepSeek's coding
 * agent, run as a local web page, a desktop app or headless, which keeps an
 * event log for each session. See docs/adapters/deepseek-harness.md. Built
 * from DeepSeek Harness's source at dsh-v0.2.2-rc.3 (MIT), and not yet
 * checked on a computer running DeepSeek Harness.
 */

const LABEL = "DeepSeek Harness";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked which programs run, while a session's status depends on it. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it showed no
 * program that could write one, or up to 2 seconds before, as a disk can keep
 * a write's time rounded down, since one may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The most sessions shown, newest first. */
export const MAX_SESSIONS = 200;

/** The most subagents' logs of the sessions shown read past their first line, newest first. */
export const MAX_CHILD_LOGS = 200;

/** The most logs whose first line is read on one poll, newest first. The rest wait for the next. */
export const MAX_HEADER_READS = 400;

/** The most links followed from a subagent to the session it is of. */
export const MAX_PARENT_LINKS = 16;

/** The usual way this adapter reads, named for the poller: the logs, with `ps` able to say which programs run. */
export const BASIS = "files";

/**
 * The way it reads while `ps` cannot say which programs run, as its last
 * answer could not, and always on Windows: no session is finished then unless DeepSeek Harness closed it
 * mid-turn or it was last written before the computer started, and no wait
 * outlasts 30 quiet minutes. Named apart, so every finished session does not
 * seem to start again.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever DeepSeek Harness is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "A DeepSeek Harness session shows as working while its log, or a subagent's, has a turn under way, as needing you while a turn waits for an approval, an answer or a plan review, as idle or failed once its turn ends, and as finished when DeepSeek Harness closed it mid-turn. Nothing it writes marks an open session, so a session no program could still be writing, by ps or since the computer started, shows as finished, unless its last turn failed or its log cannot be followed. Its own turn shows as unknown once neither its log nor a subagent's has been written for 30 minutes, and so does a wait, unless the desktop app runs, and a subagent's turn quiet that long stops keeping it working.";

/** Said whenever DeepSeek Harness is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from DeepSeek Harness's source at dsh-v0.2.2-rc.3 and not yet checked on a computer running DeepSeek Harness, so a status can be wrong.";

/** Said when a session's newest log is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A DeepSeek Harness newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown, or shows as unknown.";

/** Said when a session has only logs of an older format. */
export const OLDER_FORMAT_NOTE =
  "A DeepSeek Harness from before 0.2.0 wrote a session in a format this does not read, so that session is not shown.";

/** Said when a log is longer than this reads. */
export const TOO_LONG_NOTE =
  "A DeepSeek Harness session's log is longer than Agent Lookout reads, 16 MiB compressed or 64 MiB not, so its status is unknown.";

/** Said when a log holds lines this cannot follow. */
export const UNREAD_NOTE =
  "Some DeepSeek Harness sessions hold lines Agent Lookout cannot follow, perhaps from a newer DeepSeek Harness, so they show as unknown.";

/** Said when `DSH_HOME` is set to a folder that is not absolute. */
export const RELATIVE_HOME_NOTE =
  "DSH_HOME is not an absolute folder, so it is passed over and ~/.dsh/sessions is read.";

/** Said while `ps` cannot say which programs run. */
export const PS_FAILED_NOTE =
  "ps could not tell which programs run, so a session shows as finished only when DeepSeek Harness closed it mid-turn or it was last written before the computer started.";

/** Said on Windows, where `ps` is not asked. */
export const WINDOWS_NOTE =
  "On Windows ps is not asked and the computer's start is not compared, so only a session DeepSeek Harness closed mid-turn shows as finished.";

/** Said on a system other than macOS, Linux and Windows. */
const OTHER_SYSTEM_NOTE =
  "On this system ps is not asked and the computer's start is not compared, so only a session DeepSeek Harness closed mid-turn shows as finished.";

/** The advice when this Node.js is older than the first that reads Zstandard. */
export const NO_ZSTD_ADVICE = "Update Node.js to 22.15 or later.";

/**
 * What a DeepSeek Harness session can show, from its logs, `ps` and when the
 * computer started. See docs/adapters/deepseek-harness.md for each. Built
 * from DeepSeek Harness's source at dsh-v0.2.2-rc.3 and not yet checked on a
 * computer running it.
 *
 * - Working while a turn of its own or a subagent's is under way, idle once
 *   it ends. Its own turn quiet for 30 minutes is unknown, as a crash leaves
 *   one open; a subagent's quiet that long no longer keeps it working.
 * - Needs you while a turn waits for an approval, an `ask_user_question`
 *   answer or an `exit_plan_mode` review. One left quiet for 30 minutes is
 *   unknown, unless the desktop app runs.
 * - Finished when DeepSeek Harness closed it mid-turn, or when no program
 *   that could write it runs, by `ps`, or the computer started since.
 * - Failed when its last turn ended on an error, until a new turn starts or
 *   it is reopened.
 * - The name is a title its model wrote or one marked as the person's, else
 *   the folder's. Its first title, the first words of a prompt, is never read.
 * - Quiet for is the time since its log, or a subagent's, was written.
 * - No Jump, Stop, Answer or Tokens: its logs name no process or window, and
 *   no line that holds a reply is read.
 */
export const DEEPSEEK_HARNESS_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From its own turn, or a subagent's written in the last 30 minutes. Its own, quiet for 30 minutes, can show as unknown.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While a turn waits for an approval, question or plan review. One a crash left can show 30 minutes, or while the desktop app runs.",
  },
  finished: {
    level: "partly",
    reason:
      "When DeepSeek Harness closed it mid-turn, or no program that could write its log runs, by ps or since the computer started.",
  },
  failed: {
    level: "partly",
    reason:
      "When its last turn ended on an error, until a new turn starts or it is reopened. A closing DeepSeek Harness can lose that end.",
  },
  names: {
    level: "partly",
    reason:
      "A title its model gave or one marked as yours, else the folder's. Its first title is the start of your prompt, never read.",
  },
  jump: { level: "no", reason: "DeepSeek Harness's logs name no terminal or window." },
  "quiet-for": {
    level: "partly",
    reason:
      "The time since its log, or a subagent's, was last written, while it works. A long command can write nothing until it ends.",
  },
  tokens: { level: "no", reason: "Agent Lookout reads no line that holds a reply." },
  stop: {
    level: "no",
    reason: "A log names no process Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to DeepSeek Harness, so it cannot send an answer.",
  },
};

/** Whether a Node.js version is older than 22.15, the first 22 that reads Zstandard. */
export function before2215(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 22 || (major === 22 && minor < 15);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface DeepseekHarnessAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system it runs on, which says whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What undoes a Zstandard frame, or null for a Node.js that cannot. Defaults to `node:zlib`'s, when it has one. */
  zstd?: ZstdDecoder | null;
  /** This Node.js's version, as `process.version` gives it, for what is said when it cannot read Zstandard. */
  nodeVersion?: string;
  /** What runs `ps`. */
  runPs?: RunPs;
  /** How long the computer has been on, in milliseconds. Defaults to `os.uptime()`'s. */
  uptimeMs?: () => number;
  /** Agent Lookout's own process ID, left out of what `ps` shows. */
  ownPid?: number;
  /**
   * How often the poller calls `poll()`, which is how often the logs are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every folder is listed and every log looked up. Defaults to a minute. */
  sweepMs?: number;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
}

/** A session to show, with its log and its subagents'. */
interface Family {
  folderName: string;
  ref: LogRef | null;
  header: DeepseekHarnessHeader;
  log: DeepseekHarnessLog | null;
  /** Its own log's last write, from the newer one when a newer format was written. */
  ownWrittenAt: number;
  /** For one a newer format has been written beside: its log is not read on. */
  newer: boolean;
  children: { ref: LogRef; header: DeepseekHarnessHeader; log: DeepseekHarnessLog | null }[];
}

/**
 * Finds DeepSeek Harness's sessions on this machine from the event logs it
 * keeps, with nothing installed, no setting changed and no program of
 * DeepSeek Harness's run. Built from DeepSeek Harness's source at
 * dsh-v0.2.2-rc.3, and not yet checked on a computer running it.
 *
 * Each poll finds the logs of format 4 written in the last day
 * (`logFiles.ts`), and reads the first line of each it has not read before,
 * at most 400 a poll. Of those, the 200 newest sessions that are not a
 * subagent's are shown, and their logs, and those of their subagents, the
 * 200 newest, are read on (`logReader.ts`), one at a time, as bytes
 * (`lines.ts`), undoing Zstandard with `node:zlib` one frame at a time
 * (`zstdFrames.ts`). While a session's status depends on it, it asks `ps`,
 * at most every 10 seconds, and sooner, though not within 2 seconds of the
 * last ask, when a session is written after `ps` showed no program that
 * could write one, or up to 2 seconds before, when each program that could
 * write a session started (`processes.ts`). Nothing else is opened: not `session.lock`, which
 * is never looked up, not DeepSeek Harness's settings or keys.
 *
 * A session's status is `deepseekHarnessStatusOf`'s. A Node.js that cannot
 * read Zstandard, as before 22.15, shows only uncompressed logs, and says so.
 * DeepSeek Harness not being installed costs nothing: when its folder is
 * missing, the adapter says so and looks again only once a minute. Someone
 * who sets `AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME` means that folder: if it
 * holds no sessions, that is an answer, not a missing DeepSeek Harness.
 */
export function createDeepseekHarnessAdapter(options: DeepseekHarnessAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const zstd = options.zstd === undefined ? zstdOf(zlib) : options.zstd;
  const nodeVersion = options.nodeVersion ?? process.version;
  const uptimeMs = options.uptimeMs ?? (() => os.uptime() * 1000);
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = createDshProcessReader({
    platform,
    run: options.runPs ?? runPs,
    ownPid: options.ownPid ?? process.pid,
  });

  const { sessionsDir, named, relativeHome } = deepseekHarnessHome(env, homeDir, platform);
  const sessionsName = tildify(sessionsDir, homeDir);
  const finder = createLogFinder({
    sessionsDir,
    io,
    readsCompressed: zstd !== null,
    sweepMs: options.sweepMs,
  });
  const reader = createDeepseekHarnessLogReader(io, zstd, platform);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastAnswer: DshPrograms | null = null;
  let answerAt = 0;
  /** Whether that answer was asked because the clock was set back. */
  let clockSetBack = false;
  /** What a clock set back keeps the start rule from finishing. */
  let clock = startDshClockGuard();
  /** Each session's wait on the last poll, so a wait that goes on keeps its time. */
  let waits = new Map<string, DeepseekHarnessWait>();

  const psRuns = platform === "darwin" || platform === "linux";
  const systemNote = psRuns ? null : platform === "win32" ? WINDOWS_NOTE : OTHER_SYSTEM_NOTE;
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no node or DeepSeek Harness`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;
  const homeNote = relativeHome ? ` ${RELATIVE_HOME_NOTE}` : "";
  const older = before2215(nodeVersion);
  const laterCan = older ? " Node.js 22.15 and later can." : "";

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessions: Session[] = [],
    basis: string = unaskedBasis,
    advice?: string,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        { label: "Zstandard", value: zstd !== null ? "node:zlib" : "not in this Node.js" },
        { label: "Process check", value: `ps ${DSH_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ] satisfies SourceFact[],
      checkedAt,
    };
    if (advice !== undefined) health.advice = advice;
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** DeepSeek Harness is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `DeepSeek Harness was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.${homeNote}`,
      "not found",
      checkedAt,
    );
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written
   * after an answer that listed no program that could write one, or up to 2
   * seconds before, as a disk can keep a write's time rounded down. A clock
   * set back counts as time enough.
   */
  async function programsFor(
    checkedAt: number,
    writes: readonly (number | null)[],
  ): Promise<DshPrograms> {
    const since = checkedAt - answerAt;
    let due = lastAnswer === null || since < 0 || since >= processCheckMs;
    if (
      !due &&
      since >= PROMPT_PROCESS_CHECK_MS &&
      usable(lastAnswer) &&
      lastAnswer.programs.length === 0
    ) {
      due = writes.some((at) => at !== null && at + WRITE_TIME_STEP_MS > answerAt);
    }
    if (lastAnswer === null || due) {
      clockSetBack = since < 0;
      lastAnswer = await processes.read();
      answerAt = checkedAt;
    }
    return lastAnswer;
  }

  /** The sessions to show, and the logs of their subagents, newest first. */
  async function familiesOf(found: FoundLogs, checkedAt: number): Promise<Family[]> {
    let reads = 0;
    const known: { ref: LogRef; header: DeepseekHarnessHeader }[] = [];
    for (const ref of found.logs) {
      if (reader.needsHeader(ref)) {
        if (reads >= MAX_HEADER_READS) continue;
        reads += 1;
      }
      const read = await reader.header(ref, checkedAt);
      if (read.state === "ok") known.push({ ref, header: read.header });
    }

    const families: Family[] = [];
    const ids = new Set<string>();
    const byId = new Map<string, Family>();
    const add = (family: Family) => {
      const id = sessionIdOf(family.folderName);
      if (ids.has(id) || families.length >= MAX_SESSIONS) return;
      ids.add(id);
      families.push(family);
      if (!byId.has(family.header.id)) byId.set(family.header.id, family);
    };
    for (const { ref, header } of known) {
      if (header.subagent) continue;
      add({
        folderName: path.basename(ref.folder),
        ref,
        header,
        log: null,
        ownWrittenAt: ref.info.mtimeMs,
        newer: false,
        children: [],
      });
    }
    // A session whose log was read before a newer format was written beside it stays, as unknown.
    for (const newer of found.newer) {
      const last = newer.current === null ? null : reader.last(newer.current);
      if (last === null || last.header.subagent) continue;
      add({
        folderName: path.basename(newer.folder),
        ref: null,
        header: last.header,
        log: last,
        ownWrittenAt: newer.info.mtimeMs,
        newer: true,
        children: [],
      });
    }

    const children = new Map<string, DeepseekHarnessHeader>();
    for (const { header } of known) {
      if (header.subagent && !children.has(header.id)) children.set(header.id, header);
    }
    /** The shown session a subagent's log is of, through its parents, or null. */
    const familyOf = (header: DeepseekHarnessHeader): Family | null => {
      const seen = new Set<string>();
      let parent = header.parentSession;
      for (let link = 0; link < MAX_PARENT_LINKS && parent !== null && !seen.has(parent); link++) {
        const family = byId.get(parent);
        if (family !== undefined) return family;
        seen.add(parent);
        parent = children.get(parent)?.parentSession ?? null;
      }
      return null;
    };
    for (const { ref, header } of known) {
      if (!header.subagent) continue;
      familyOf(header)?.children.push({ ref, header, log: null });
    }

    // One log at a time: each session's own, then the newest of its subagents'.
    for (const family of families) {
      if (family.ref !== null) family.log = await reader.readOn(family.ref, true, checkedAt);
    }
    const toRead = families
      .flatMap((family) => family.children)
      .sort(
        (a, b) => b.ref.info.mtimeMs - a.ref.info.mtimeMs || a.ref.path.localeCompare(b.ref.path),
      )
      .slice(0, MAX_CHILD_LOGS);
    for (const child of toRead) child.log = await reader.readOn(child.ref, false, checkedAt);
    return families;
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  function zstdNote(compressed: number): string {
    if (zstd !== null) return "";
    if (compressed === 0) {
      return ` DeepSeek Harness compresses its session logs with Zstandard, which this Node.js, ${nodeVersion}, cannot read, so a compressed log would not be shown.${laterCan}`;
    }
    const one = compressed === 1;
    return ` ${compressed} DeepSeek Harness session ${one ? "log is" : "logs are"} compressed with Zstandard, which this Node.js, ${nodeVersion}, cannot read, so ${one ? "it is" : "they are"} not shown.${laterCan}`;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    clock = guardDshClock(clock, platform, checkedAt);

    // A missing DeepSeek Harness is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time
    // enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let found: FoundLogs;
    try {
      found = await finder.find(checkedAt);
    } catch (error) {
      if (error instanceof NotAFolderError) {
        return result(
          "error",
          `DeepSeek Harness sessions could not be read: ${sessionsName} is not a folder.`,
          "cannot be read",
          checkedAt,
        );
      }
      if (!isMissing(error)) {
        return result(
          "error",
          `DeepSeek Harness sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      finder.forget();
      reader.keepOnly(new Set());
      waits = new Map();
      if (named) {
        return result(
          "ok",
          `${DEEPSEEK_HARNESS_HOME_ENV} is set, and there is no ${sessionsName} folder, so no DeepSeek Harness sessions are listed. ${alwaysNotes}${zstdNote(0)}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const families = await familiesOf(found, checkedAt);
    const keep = new Set(found.logs.map((ref) => ref.path));
    for (const newer of found.newer) if (newer.current !== null) keep.add(newer.current);
    reader.keepOnly(keep);

    const bootAt = psRuns ? checkedAt - uptimeMs() : null;
    const facts = families.map((family) => {
      const { header } = family;
      const own: DeepseekHarnessTurn | null =
        family.newer || family.log === null || family.log.mark !== "ok" ? null : family.log.turn;
      const writes = [
        lastWriteOf(
          Math.max(family.ownWrittenAt, family.log?.writtenAt ?? 0),
          header.createdAt,
          checkedAt,
        ),
      ];
      const children: DeepseekHarnessChild[] = [];
      for (const child of family.children) {
        const childWrite = lastWriteOf(
          Math.max(child.ref.info.mtimeMs, child.log?.writtenAt ?? 0),
          child.header.createdAt,
          checkedAt,
        );
        writes.push(childWrite);
        if (child.log?.mark === "ok" && child.log.turn.state !== "unsure") {
          children.push({ turn: child.log.turn, writtenAt: childWrite });
        }
      }
      const known = writes.filter((at): at is number => at !== null);
      const writtenAt = known.length === 0 ? null : Math.max(...known);
      // Whether `ps` could change its status: not when its own turns settle it, nor when it was last written before the computer started.
      const settled =
        own === null ||
        own.state === "unsure" ||
        (own.state === "ended" && (own.end === "error" || own.end === "disposed")) ||
        dshWriter({
          platform,
          writtenAt,
          bootAt,
          answer: null,
          answerAt: 0,
          startFloor: clock.startFloor,
        }) === "gone";
      return { family, own, children, writtenAt, settled };
    });

    const unsettled = facts.filter(({ settled }) => !settled);
    const answer =
      psRuns && unsettled.length > 0
        ? await programsFor(
            checkedAt,
            unsettled.map(({ writtenAt }) => writtenAt),
          )
        : null;

    const nextWaits = new Map<string, DeepseekHarnessWait>();
    let tooLong = false;
    let unread = false;
    const sessions = facts.map(({ family, own, children, writtenAt }) => {
      const writer = dshWriter({
        platform,
        writtenAt,
        bootAt,
        answer,
        answerAt,
        clockSetBack,
        startFloor: clock.startFloor,
      });
      const status = deepseekHarnessStatusOf({ own, children, writtenAt, writer, now: checkedAt });
      const id = sessionIdOf(family.folderName);
      if (status.wait !== undefined) {
        const wait = continuedDeepseekHarnessWait(waits.get(id), status.wait);
        nextWaits.set(id, wait);
        status.since = wait.since;
      }
      if (family.log?.mark === "too-long") tooLong = true;
      if (
        family.log?.mark === "stuck" ||
        own?.state === "unsure" ||
        (own?.state === "ended" && own.end === "other")
      ) {
        unread = true;
      }
      return deepseekHarnessSession({
        folderName: family.folderName,
        header: family.header,
        title: family.log?.title ?? null,
        status,
        writtenAt,
        now: checkedAt,
      });
    });
    waits = nextWaits;

    if (zstd === null && found.compressed > 0 && sessions.length === 0) {
      return result(
        "error",
        `This Node.js, ${nodeVersion}, cannot read Zstandard, which DeepSeek Harness compresses its session logs with, so no DeepSeek Harness sessions are listed.${laterCan}`,
        every(pollIntervalMs),
        checkedAt,
        [],
        unaskedBasis,
        older ? NO_ZSTD_ADVICE : undefined,
      );
    }

    let detail = `Sessions are read from the logs DeepSeek Harness keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    if (systemNote !== null) detail += ` ${systemNote}`;
    // A poll that does not ask `ps` is named as the last answer was, so a session that settles while ps cannot say is compared with that way's poll.
    else if (lastAnswer !== null && !usable(lastAnswer)) {
      detail += ` ${PS_FAILED_NOTE}`;
      basis = BASIS_WITHOUT_PROCESSES;
    }
    if (tooLong) detail += ` ${TOO_LONG_NOTE}`;
    if (unread) detail += ` ${UNREAD_NOTE}`;
    if (found.newer.length > 0) detail += ` ${NEWER_FORMAT_NOTE}`;
    if (found.older > 0) detail += ` ${OLDER_FORMAT_NOTE}`;
    detail += homeNote;
    detail += zstdNote(found.compressed);
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: DEEPSEEK_HARNESS_CAPABILITIES,
    lookingIn: `Looking for DeepSeek Harness sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading DeepSeek Harness sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
