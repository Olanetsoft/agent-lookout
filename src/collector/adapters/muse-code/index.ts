import os from "node:os";

import {
  continuedDeepseekHarnessWait,
  type DeepseekHarnessWait,
} from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import {
  decidedAtOf,
  museCodeStatusOf,
  settledByLog,
} from "../../../core/mapping/muse-code/museCodeMapping.ts";
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
import { runPs } from "../../processes/ps.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import type { RunPs } from "../antigravity/cli/agyProcesses.ts";
import {
  createDshProcessAsker,
  createDshProcessReader,
  DSH_TABLE_ARGS,
  dshWriter,
  guardDshClock,
  PROMPT_PROCESS_CHECK_MS,
  startDshClockGuard,
  usable,
  type DshNames,
  type DshProcessReader,
} from "../deepseek-harness/processes.ts";
import { every } from "../words.ts";
import { MUSE_CODE_HOME_ENV, museCodeHome } from "./home.ts";
import { createMuseLogReader, type MuseLog } from "./logReader.ts";
import { createSessionFinder, NotAFolderError, type SessionRef } from "./sessionFolders.ts";
import { museCodeId, museCodeSession, SOURCE_ID } from "./toSession.ts";

export { MUSE_CODE_HOME_ENV, museCodeSessionsDirFor } from "./home.ts";
export { SOURCE_ID } from "./toSession.ts";

/**
 * The Muse Code adapter. Muse Code, `muse`, is Meta's terminal coding agent,
 * which keeps an append-only log for each session. See
 * docs/adapters/muse-code.md. Its own program is not open source, so this
 * was built from Meta's documentation, its MIT-licensed Muse Code SDK and
 * protocol schema at 1.4.24 and its cookbook, and from open-source readers of
 * Muse Code's files, not from Muse Code's own program, and has not yet been
 * checked on a computer running it.
 *
 * It reads the logs alone, as Meta's docs call their layout an
 * implementation detail and ask programs to ask a running host, whose start
 * can delete empty and expired sessions. It shares DeepSeek Harness's
 * question to `ps` and its rules for the answer
 * (`../deepseek-harness/processes.ts`), with Muse Code's names, and its way
 * of keeping a wait across polls (`continuedDeepseekHarnessWait`), Pi's check
 * of a folder (`folder` in `../pi/sessionFile.ts`), Pi's limits of 200 logs
 * and a sweep once a minute (`../pi/sessionFiles.ts`) and Autohand Code's
 * decoder of one JSON string (`literalOf` in `../autohand-code/jsonBytes.ts`).
 */

const LABEL = "Muse Code";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked which programs run, while a session's status depends on it. */
export const PROCESS_CHECK_MS = 10_000;

export { PROMPT_PROCESS_CHECK_MS };

/**
 * The names of a Muse Code program, as `ps -A -o pid=,lstart=,comm=` prints
 * them: `muse`, its command (Meta's overview, the SDKs' discovery, the
 * cookbook's `pkill -9 -x muse`), `muse.exe`, and any name that begins
 * `muse-`, as open-source readers report `muse-bin-<version>` and the
 * Homebrew cask installs `muse-<arch>-<os>`. Linux cuts a name to its first
 * 15 bytes, which still begin `muse-`. The match is case-sensitive, so a Mac
 * app named `Muse` does not count. Each backs a session: none only may.
 */
export const MUSE_NAMES: DshNames = {
  backing: new Set(["muse", "muse.exe"]),
  backingPrefix: "muse-",
  maybe: new Set(),
};

/** The usual way this adapter reads, named for the poller: the logs, with `ps` able to say which programs run. */
export const BASIS = "files";

/**
 * The way it reads while `ps` cannot say which programs run, as its last
 * answer could not, and always on Windows: a session is finished then only
 * when Muse Code wrote that it let it go, or it was last written before the
 * computer started, and none is working, idle or needs you. Named apart, so
 * every finished session does not seem to start again.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever Muse Code is watched. */
export const STATUS_ENDS =
  "A session shows as failed when Muse Code writes that its last turn failed, and as finished when it writes it let the session go.";
export const STATUS_TIMES =
  "Either needs a time that can be right, and a failure stands until a new turn starts, even after the session is let go.";
export const STATUS_READONLY =
  "Agent Lookout reads the session logs alone, runs no Muse Code program, and leaves Muse Code's locks, databases and sockets alone.";

/** Said whenever Muse Code is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_BUILT =
  "This was built from Meta's documentation, its MIT-licensed Muse Code SDK and protocol schema at 1.4.24 and its cookbook.";
export const UNCHECKED_READERS =
  "It also draws on open-source readers of Muse Code's files, not on Muse Code's own program.";
export const UNCHECKED_NOT =
  "It has not yet been checked on a computer running Muse Code, so a status can be wrong.";

/** Said on macOS and Linux, where `ps` is asked. */
export const STATUS_GONE =
  "Otherwise it shows as finished once no Muse Code that started before its newest status record, or a minute after, runs, by ps.";
export const STATUS_BOOT =
  "A session last written before the computer started shows as finished as well.";
export const STATUS_HELD =
  "While such a Muse Code runs, it shows as working while a turn runs, for up to 30 quiet minutes, and as idle between turns.";
export const STATUS_WAITS =
  "It shows as needing you while that turn asks you a question or waits for your approval, for as long as it waits.";
export const STATUS_REVIEWER =
  "An approval the automated reviewer holds shows as working, until the reviewer hands it to you or gives no answer in 2 minutes.";
export const STATUS_FIRST_SECONDS =
  "An approval with no phase this knows and no word of a reviewer shows as working for its first 6 seconds.";
export const STATUS_ANY =
  "A program named muse, muse.exe or starting muse- that started before a session's newest status record counts, whatever it holds.";
export const STATUS_WRONG =
  "So while another runs, a session whose own Muse Code was killed can show as idle, needing you, or working for up to 30 minutes.";
export const STATUS_UNKNOWN = "Anything else shows as unknown.";

/** Said on Windows: of the folder, only when no setting names it, and of `ps`. */
export const WINDOWS_FOLDER =
  "On Windows it looks in %USERPROFILE%\\.local\\share\\muse, a folder Meta does not document for Windows, so that folder is assumed.";
export const WINDOWS_PS =
  "On Windows ps is not run, so a session shows as unknown unless Muse Code wrote that its last turn failed or that it let it go.";

/** Said on a system other than macOS, Linux and Windows. */
export const OTHER_SYSTEM =
  "On this system ps is not run, so a session shows as unknown unless Muse Code wrote that its last turn failed or that it let it go.";

/** Said when this poll found it. */
export const PS_FAILED =
  "While ps cannot tell which programs run, no session shows as working, idle or needing you, and the ps rule finishes none.";
export const TOO_FAR =
  "A Muse Code session's newest turn began more than 8 MiB before its log's end, so it shows as unknown.";
export const UNREAD =
  "Some Muse Code sessions hold a line Agent Lookout cannot read, perhaps from a newer Muse Code, so they show as unknown.";
export const NEWER_FORMAT =
  "A Muse Code newer than this Agent Lookout wrote lines in a newer format, so some sessions show as unknown.";
export const XDG_RELATIVE =
  "XDG_DATA_HOME is not an absolute folder, so it is passed over and ~/.local/share/muse is read.";
export const LINK =
  "A link in the sessions folder, or at it, is not followed, so the sessions behind it are not read.";

/**
 * What a Muse Code session can show, from its log, `ps` and when the
 * computer started. See docs/adapters/muse-code.md for each. Built from
 * Meta's documentation, its MIT-licensed Muse Code SDK and protocol schema at
 * 1.4.24 and its cookbook, and from open-source readers of Muse Code's files,
 * and not yet checked on a computer running it.
 */
export const MUSE_CODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "From its log while any Muse Code that started before its newest status record runs, on macOS and Linux, whatever session it holds.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "On macOS and Linux: its questions, and approvals that wait for you or that the reviewer holds past 2 minutes. Not a subagent's.",
  },
  finished: {
    level: "partly",
    reason:
      "When Muse Code writes that it let the session go, or once no Muse Code that started before its newest status record runs, by ps.",
  },
  failed: {
    level: "partly",
    reason:
      "When Muse Code writes that the last turn failed, until a new turn starts. A turn cut off by a crash may not be written so.",
  },
  names: {
    level: "partly",
    reason:
      "The workspace folder's. A session's name and title are typed by you or made from your words, and are never read.",
  },
  jump: {
    level: "no",
    reason:
      "Nothing Agent Lookout turns into text names a Muse Code session's process or terminal.",
  },
  "quiet-for": {
    level: "partly",
    reason:
      "The time since its log was last written, while it works. A long command, or a subagent with a log of its own, may write nothing.",
  },
  tokens: {
    level: "no",
    reason: "Muse Code's counts are on lines Agent Lookout steps over without reading them.",
  },
  stop: {
    level: "no",
    reason: "A Muse Code session's log names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Muse Code, so it cannot send an answer.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface MuseCodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  /** A clock that is never set, for telling when the other one was. Defaults to `performance.now()`. */
  monotonic?: () => number;
  io?: ReadOnlyIo;
  /** The system it runs on, which says whether `ps` is asked and how a workspace folder is judged. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What runs `ps`. */
  runPs?: RunPs;
  /** What asks `ps` which programs run. Defaults to one that runs it with Muse Code's names. */
  processes?: DshProcessReader;
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
  /** How often every folder is listed and every session looked up. Defaults to a minute. */
  sweepMs?: number;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /** The most logs read at once. Defaults to 200. */
  maxSessions?: number;
}

/** One session this poll lists. */
interface Found {
  ref: SessionRef;
  log: MuseLog & { view: Exclude<MuseLog["view"], { state: "none" }> };
}

/**
 * Finds Muse Code's sessions on this machine from the logs it keeps, with
 * nothing installed, no setting changed and no program of Muse Code's run.
 *
 * Each poll finds the logs of the newest day folders and the ones written in
 * the last day (`sessionFolders.ts`), the 200 newest, and reads each that
 * changed, as bytes (`logReader.ts`, `records.ts`, `jsonWalker.ts`). While a
 * listed session's status depends on it, it asks `ps` when each Muse Code
 * program started, at most every 10 seconds, and sooner, though not within 2
 * seconds of the last ask, when a session is written after `ps` showed none,
 * or up to 2 seconds before, on macOS and Linux. Nothing else is opened,
 * listed or probed: not `.session.lock`, `session-index.db`, any other
 * database, any socket, `subagent/`, `local-tracing/`, `plugins/` or
 * `~/.config/muse`.
 *
 * Muse Code not being installed costs nothing: when its sessions folder is
 * missing, the adapter says so and looks again only once a minute. Someone
 * who sets `AGENT_LOOKOUT_MUSE_CODE_HOME` means that folder: if it holds no
 * sessions, that is an answer, not a missing Muse Code.
 */
export function createMuseCodeAdapter(options: MuseCodeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const uptimeMs = options.uptimeMs ?? (() => os.uptime() * 1000);
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes =
    options.processes ??
    createDshProcessReader({
      platform,
      run: options.runPs ?? runPs,
      ownPid: options.ownPid ?? process.pid,
      names: MUSE_NAMES,
    });
  /** When `ps` is asked, its last answer, and the earliest the computer's start has been worked out to be while this runs. */
  const asker = createDshProcessAsker({ processes, platform, processCheckMs, uptimeMs });

  const { sessionsDir, named, set, xdgRelative } = museCodeHome(env, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const finder = createSessionFinder({
    sessionsDir,
    io,
    sweepMs: options.sweepMs,
    maxSessions: options.maxSessions,
  });
  const reader = createMuseLogReader(io, platform);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What a clock set back keeps the start rule from finishing. */
  let clock = startDshClockGuard();
  /**
   * Each session's wait on the last poll, kept through polls that cannot tell
   * whether a Muse Code holds it, so a wait that goes on keeps its time and its
   * approvals keep waiting.
   */
  let waits = new Map<string, DeepseekHarnessWait>();
  /** The logs of the sessions that needed the person at the last poll that could judge them, looked up however old. */
  let needed = new Set<string>();

  const psRuns = platform === "darwin" || platform === "linux";
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no Muse Code program`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;
  const windowsFolder = platform === "win32" && !set ? ` ${WINDOWS_FOLDER}` : "";
  const systemNotes = psRuns
    ? [
        STATUS_GONE,
        STATUS_BOOT,
        STATUS_HELD,
        STATUS_WAITS,
        STATUS_REVIEWER,
        STATUS_FIRST_SECONDS,
        STATUS_ANY,
        STATUS_WRONG,
        STATUS_UNKNOWN,
      ].join(" ")
    : platform === "win32"
      ? `${windowsFolder.trimStart()}${windowsFolder === "" ? "" : " "}${WINDOWS_PS}`
      : OTHER_SYSTEM;
  const alwaysNotes = [
    STATUS_ENDS,
    STATUS_TIMES,
    systemNotes,
    STATUS_READONLY,
    UNCHECKED_BUILT,
    UNCHECKED_READERS,
    UNCHECKED_NOT,
  ].join(" ");
  const xdgNote = xdgRelative ? ` ${XDG_RELATIVE}` : "";

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
        {
          label: "Files read",
          value:
            "session.jsonl of each session, as bytes: its first 64 KiB and its newest lines back to the newest turn's start, at most 8 MiB. Only its workspace folder and record IDs become text",
        },
        { label: "Process check", value: `ps ${DSH_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ] satisfies SourceFact[],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** Muse Code is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Muse Code was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.${xdgNote}${windowsFolder}`,
      "not found",
      checkedAt,
    );
  }

  /** Whether the last answer of `ps`, which this poll may not have asked, could not say which programs run. */
  const psCannotSay = () => psRuns && asker.lastAnswer !== null && !usable(asker.lastAnswer);

  function forgetAll() {
    finder.forget();
    reader.keepOnly(new Set());
    waits = new Map();
    needed = new Set();
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    clock = guardDshClock(clock, platform, checkedAt, monotonic());

    // A missing Muse Code is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time
    // enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let found: Awaited<ReturnType<typeof finder.find>>;
    try {
      found = await finder.find(checkedAt, needed);
    } catch (error) {
      if (error instanceof NotAFolderError) {
        forgetAll();
        return result(
          "error",
          `Muse Code sessions could not be read: ${sessionsName} is not a folder. ${LINK}`,
          "cannot be read",
          checkedAt,
        );
      }
      if (!isMissing(error)) {
        return result(
          "error",
          `Muse Code sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      forgetAll();
      if (named) {
        const cannotSay = psCannotSay();
        return result(
          "ok",
          `${MUSE_CODE_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Muse Code sessions are listed. ${alwaysNotes}${cannotSay ? ` ${PS_FAILED}` : ""}`,
          "not found",
          checkedAt,
          [],
          cannotSay ? BASIS_WITHOUT_PROCESSES : unaskedBasis,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const listed: Found[] = [];
    for (const ref of found.refs) {
      const log = await reader.read(ref);
      if (log.view.state === "none") continue;
      listed.push({ ref, log: log as Found["log"] });
    }
    reader.keepOnly(new Set(found.refs.map((ref) => ref.path)));

    const bootAt = asker.bootAt(checkedAt);
    const facts = listed.map((one) => {
      const { view } = one.log;
      const writtenAt = plausibleTime(Math.floor(one.log.writtenAt), checkedAt);
      const decidedAt = decidedAtOf(view.state === "ok" ? view.fold : null, writtenAt, checkedAt);
      // Whether `ps` could change its status: not once the log settles it, nor when it was last written before the computer started.
      const settled =
        settledByLog(view) ||
        dshWriter({
          platform,
          writtenAt: decidedAt,
          bootAt,
          answer: null,
          answerAt: 0,
          startFloor: clock.startFloor,
          lowAt: clock.lowAt,
        }) === "gone";
      return { ...one, writtenAt, decidedAt, settled };
    });

    const unsettled = facts.filter(({ settled }) => !settled);
    // Each file's own last write, never earlier than the time judged, so a write after an answer that listed no Muse Code is asked about sooner.
    const answer =
      psRuns && unsettled.length > 0
        ? await asker.programsFor(
            checkedAt,
            unsettled.map(({ writtenAt }) => writtenAt),
            facts.map(({ ref, log }) => ({ path: ref.path, info: log.info })),
          )
        : null;

    const nextWaits = new Map<string, DeepseekHarnessWait>();
    const nextNeeded = new Set<string>();
    let tooFar = false;
    let unread = false;
    let newer = false;
    const sessions = facts.map(({ ref, log, writtenAt, decidedAt, settled }) => {
      const writer = dshWriter({
        platform,
        writtenAt: decidedAt,
        bootAt,
        answer,
        answerAt: asker.answerAt,
        // A log read at another size, time or identity than when that answer was asked may have been written after it, even when its `lstat` this poll was not.
        clockSetBack: asker.clockSetBack && asker.asAsked({ path: ref.path, info: log.info }),
        startFloor: clock.startFloor,
        lowAt: clock.lowAt,
      });
      const id = museCodeId(ref.id);
      const before = waits.get(id);
      const waited = new Set(
        (before?.ids ?? [])
          .filter((wait) => wait.startsWith("approval:"))
          .map((wait) => wait.slice("approval:".length)),
      );
      const status = museCodeStatusOf({
        view: log.view,
        writer,
        writtenAt,
        decidedAt,
        now: checkedAt,
        waited,
      });
      if (log.view.state === "too-far") tooFar = true;
      if (log.view.state === "unsure") {
        if (log.view.why === "newer") newer = true;
        else if (log.view.why === "unreadable") unread = true;
      }
      // A poll that cannot judge whether a Muse Code holds the session, while
      // its log does not settle it, keeps what the last poll knew of its wait,
      // for the questions and approvals its log still shows open.
      const unjudged = writer === "maybe" && !settled;
      if (status.wait !== undefined) {
        const wait = continuedDeepseekHarnessWait(before, status.wait);
        nextWaits.set(id, wait);
        status.since = wait.since;
      } else if (unjudged && before !== undefined && log.view.state === "ok") {
        const { prompts, approvals } = log.view.fold;
        const open = before.ids.filter((wait) =>
          wait.startsWith("question:")
            ? prompts.has(wait.slice("question:".length))
            : approvals.has(wait.slice("approval:".length)),
        );
        if (open.length > 0) nextWaits.set(id, { since: before.since, ids: open });
      }
      // A session that needed the person is looked up however old its log, until a poll can judge it does not.
      if (status.status === "needs-you" || (unjudged && needed.has(ref.path))) {
        nextNeeded.add(ref.path);
      }
      return museCodeSession({
        folderName: ref.id,
        cwd: log.cwd,
        metadataAt: log.metadataAt,
        status,
        writtenAt,
        now: checkedAt,
      });
    });
    waits = nextWaits;
    needed = nextNeeded;

    let detail = `Sessions are read from the logs Muse Code keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    // A poll that does not ask `ps` is named as the last answer was, so a
    // session that settles while it cannot say is compared with that way's poll.
    if (psCannotSay()) {
      detail += ` ${PS_FAILED}`;
      basis = BASIS_WITHOUT_PROCESSES;
    }
    if (tooFar) detail += ` ${TOO_FAR}`;
    if (unread) detail += ` ${UNREAD}`;
    if (newer) detail += ` ${NEWER_FORMAT}`;
    detail += xdgNote;
    if (found.link) detail += ` ${LINK}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: MUSE_CODE_CAPABILITIES,
    lookingIn: `Looking for Muse Code sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Muse Code sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
