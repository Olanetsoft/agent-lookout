import os from "node:os";

import { exitOf, ohMyPiStatusOf } from "../../../core/mapping/oh-my-pi/ohMyPiMapping.ts";
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
import { isDroidProjectFolder } from "../droid/sessionFile.ts";
import {
  createSessionFileFinder,
  type SessionFileFinder,
  type SessionFileRef,
} from "../pi/sessionFiles.ts";
import { every } from "../words.ts";
import {
  OMP_AGENT_DIR_ENV,
  OMP_HOME_ENV,
  OMP_SESSIONS_ENV,
  ompFoldersFor,
  ompXdgProbe,
  type OmpFolders,
} from "./folders.ts";
import {
  createOmpSessionReader,
  type OmpSessionFile,
  type OmpSessionReader,
} from "./sessionFile.ts";
import { ohMyPiSession, SOURCE_ID } from "./toSession.ts";

export { OMP_HOME_ENV, ompSessionsDirsFor } from "./folders.ts";
export { SOURCE_ID } from "./toSession.ts";

/**
 * The Oh My Pi adapter. Oh My Pi, `omp`, is a terminal coding agent made from
 * Pi's source, which keeps each session in one JSONL file. See
 * docs/adapters/oh-my-pi.md. Built from Oh My Pi's source at v19.0.0 (MIT),
 * and not yet checked on a computer running Oh My Pi.
 *
 * It is an adapter of its own, not a profile of Pi's: its file begins with a
 * title slot that it rewrites in place, then the header, it names no session
 * on a line of its own, its project folders begin with `-`, and it writes a
 * line when it stops and before each tool. It shares Pi's finder of session
 * files (`../pi/sessionFiles.ts`), with Droid's test of project folders, Pi's
 * reader of a header (`parseHeader` in `../pi/sessionFile.ts`), Autohand
 * Code's readers of bytes (`../autohand-code/jsonBytes.ts`), and DeepSeek
 * Harness's question to `ps` and its rules for the answer
 * (`../deepseek-harness/processes.ts`), with Oh My Pi's names.
 */

const LABEL = "Oh My Pi";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often the folder is worked out again, for an `XDG_DATA_HOME` folder made or removed since. */
export const FOLDERS_CHECK_MS = 60_000;

/** How often, at most, `ps` is asked which programs run, while a session's status depends on it. */
export const PROCESS_CHECK_MS = 10_000;

export { PROMPT_PROCESS_CHECK_MS };

/**
 * The names of a program that backs a session, as `ps -A -o pid=,lstart=,comm=`
 * prints them:
 *
 * omp           the command, as its installer, Homebrew and its released
 *               binaries name it, and as it names itself on Linux once it starts
 * .omp-wrapped  the command as Nix runs it on Linux, until it names itself
 */
export const OMP_PROGRAMS: ReadonlySet<string> = new Set(["omp", ".omp-wrapped"]);

/** On macOS, an `omp` installed with `bun install -g` runs as `bun`, which may write a session and backs none. */
export const BUN_PROGRAMS: ReadonlySet<string> = new Set(["bun"]);

/** The names `ps` is read for on a system: `bun` only on macOS. */
export function ompNamesFor(platform: NodeJS.Platform): DshNames {
  return { backing: OMP_PROGRAMS, maybe: platform === "darwin" ? BUN_PROGRAMS : new Set() };
}

/** The usual way this adapter reads, named for the poller: the files, with `ps` able to say which programs run. */
export const BASIS = "files";

/**
 * The way it reads while `ps` cannot say which programs run, as its last
 * answer could not, and always on Windows: a session is finished then only
 * when Oh My Pi wrote that it stopped, or it was last written before the
 * computer started, and none is working or needs you. Named apart, so every
 * finished session does not seem to start again.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever Oh My Pi is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "An Oh My Pi session shows as finished or failed once Oh My Pi writes, at a time that can be right, that it stopped, and on macOS and Linux as working while a turn is open and as needing you while its ask tool waits, while an omp that could have written it runs and it was written in the last 30 minutes, and as finished once no such program could still write it, by ps or since the computer started. Nothing it writes says a turn is over, so a session never shows as idle, and an approval it waits for is not written, so that shows as working. Anything else shows as unknown. No Oh My Pi program is run.";

/** Said whenever Oh My Pi is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Oh My Pi's source at v19.0.0 and not yet checked on a computer running Oh My Pi, so a status can be wrong.";

/** Said when a file in the sessions folder does not begin as an Oh My Pi session's does. */
export const NOT_A_SESSION_NOTE =
  "A .jsonl file in the sessions folder does not begin with the title slot Oh My Pi writes, so it is not shown: an older Oh My Pi's, which began with its header, or a Pi session's in a folder both use.";

/** Said when a session's file is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "An Oh My Pi newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/** Said when a session shown as unknown ends in a line this cannot read. */
export const UNREAD_NOTE =
  "Some Oh My Pi sessions end in a line Agent Lookout cannot read, perhaps from a newer Oh My Pi, so they show as unknown.";

/** Said when a session shown as unknown has its newest line that decides too far back. */
export const TOO_FAR_NOTE =
  "An Oh My Pi session's newest line that says what it does is more than 8 MiB from its file's end, or past a line longer than that, so it shows as unknown.";

/** Said on a Mac, where an `omp` installed with `bun install -g` runs as `bun`. */
export const BUN_NOTE =
  "On a Mac an omp installed with bun install -g runs as bun, which ps cannot tell from any other bun. While a bun that started before a session's last write, or within a minute after, runs, a session no omp backs shows as unknown, not as working or needing you, and not as finished until Oh My Pi writes that it stopped.";

/** Said when `PI_CODING_AGENT_SESSION_DIR` is set to a folder that is not absolute. */
export const SESSION_DIR_NOTE = `${OMP_SESSIONS_ENV} is not an absolute folder, so it is passed over: Oh My Pi finds it from the folder it was started in, which Agent Lookout cannot know.`;

/** Said when `PI_CODING_AGENT_DIR` is set to a folder that is not absolute. */
export const AGENT_DIR_NOTE = `${OMP_AGENT_DIR_ENV} is not an absolute folder, so it is passed over: Oh My Pi finds it from the folder it was started in, which Agent Lookout cannot know.`;

/** Said while `ps` cannot say which programs run. */
export const PS_FAILED_NOTE =
  "ps could not tell which programs run, so a session shows as finished only when Oh My Pi wrote that it stopped or it was last written before the computer started, and none shows as working or needing you.";

/** Said on Windows, where `ps` is not asked. */
export const WINDOWS_NOTE =
  "On Windows ps is not asked and the computer's start is not compared, so a session shows as finished or failed only once Oh My Pi writes that it stopped, and as unknown otherwise.";

/** Said on a system other than macOS, Linux and Windows. */
const OTHER_SYSTEM_NOTE =
  "On this system ps is not asked and the computer's start is not compared, so a session shows as finished or failed only once Oh My Pi writes that it stopped, and as unknown otherwise.";

/**
 * What an Oh My Pi session can show, from its file, `ps` and when the
 * computer started. See docs/adapters/oh-my-pi.md for each. Built from Oh My
 * Pi's source at v19.0.0 and not yet checked on a computer running it.
 *
 * - Working while a prompt, a tool's result or a tool's start is its newest
 *   line, an `omp` that started before its last write runs and it was written
 *   in the last 30 minutes, on macOS and Linux. Idle never shows.
 * - Needs you while its `ask` tool waits, on the same terms. An approval is
 *   not written, so a tool waiting for one shows as working.
 * - Finished when Oh My Pi writes that it stopped, or no `omp` that could
 *   have written it runs, by `ps`, or the computer started since.
 * - Failed when Oh My Pi writes that it stopped on an error of its own. A
 *   reply that failed is not read: it reads the same while Oh My Pi retries.
 * - The name is the title the person or a model gave it, else the folder's.
 *   A Codex session's copy's title, which can be the first prompt typed in
 *   Codex, is never turned into text from the slot, and the header's copy is
 *   dropped with the parsed header.
 * - Quiet for is the time since its file was written, while it works.
 * - No Jump, Stop, Answer or Tokens: its file names no process or window, and
 *   a request's counts sit beside its prompt and reply and are never parsed.
 */
export const OH_MY_PI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Working while a turn is open and an omp that could have written it runs, on macOS and Linux. Idle never shows.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "While its ask tool waits for you, for up to 30 minutes, on macOS and Linux. A tool waiting for your approval shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "When omp writes that the session ended, or once no omp started before its last write runs, on macOS and Linux.",
  },
  failed: {
    level: "partly",
    reason:
      "When omp writes that it stopped on an error of its own. A failed reply is not read: it reads the same while omp retries it.",
  },
  names: {
    level: "partly",
    reason:
      "The title you or a model gave it, else the folder's. A Codex import's title, which can be your first prompt there, is not shown.",
  },
  jump: {
    level: "no",
    reason:
      "An Oh My Pi session's file names no process, and the terminal records Oh My Pi keeps are not read.",
  },
  "quiet-for": {
    level: "partly",
    reason:
      "From the session file's last write, while it is working, for up to 30 minutes: after that it shows as unknown.",
  },
  tokens: {
    level: "no",
    reason:
      "Oh My Pi keeps counts beside the prompt and reply text of each request, and that is not parsed.",
  },
  stop: {
    level: "no",
    reason:
      "An Oh My Pi session's file names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Oh My Pi, so it cannot send an answer.",
  },
};

/** Everything the adapter touches outside itself. Tests replace these. */
export interface OhMyPiAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  /** A clock that is never set, for telling when the other one was. Defaults to `performance.now()`. */
  monotonic?: () => number;
  io?: ReadOnlyIo;
  /** The system it runs on, which says whether `ps` is asked and `XDG_DATA_HOME` counts. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What runs `ps`. */
  runPs?: RunPs;
  /** What asks `ps` which programs run. Defaults to one that runs it with Oh My Pi's names. */
  processes?: DshProcessReader;
  /** How long the computer has been on, in milliseconds. Defaults to `os.uptime()`'s. */
  uptimeMs?: () => number;
  /** Agent Lookout's own process ID, left out of what `ps` shows. */
  ownPid?: number;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How often every session file is looked up. Defaults to a minute. */
  sweepMs?: number;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
}

/** One session this poll lists. */
interface Found {
  ref: SessionFileRef;
  file: OmpSessionFile;
  writtenAt: number;
}

/** The folder read, with the finder and reader of its files. */
interface Watched {
  folders: OmpFolders;
  sessionsName: string;
  finder: SessionFileFinder;
  reader: OmpSessionReader;
}

/**
 * Finds Oh My Pi's sessions on this machine from the files it keeps, with
 * nothing installed, no setting changed and no program of Oh My Pi's run.
 *
 * Oh My Pi keeps each session in one JSONL file, `<time>_<id>.jsonl`, in a
 * folder for its project in its sessions folder (`folders.ts`), whose name
 * begins with `-`, or loose in the folder `PI_CODING_AGENT_SESSION_DIR`
 * names. So a poll looks up each project folder and each file written in the
 * last day, with `lstat`, as Pi's adapter does, and looks through every other
 * file once a minute. Of each file it reads the title slot, the header and the
 * start of the third line (`sessionFile.ts`), and its newest lines, as bytes
 * (`tail.ts`), and only when the file changed or its slot is not settled. The
 * 200 newest are shown, and of two files that hold one ID the newer.
 *
 * While a shown session's status depends on it, it asks `ps` when each
 * program that could write a session started, at most every 10 seconds, and
 * sooner, though not within 2 seconds of the last ask, when a session is
 * written after `ps` showed none, or up to 2 seconds before, on macOS and
 * Linux (`../deepseek-harness/processes.ts`). Nothing else is opened, listed
 * or probed: not the session-owner records in `run/`, nor any socket.
 *
 * Oh My Pi not being installed costs nothing: when its sessions folder is
 * missing, the adapter says so and looks again only once a minute. Someone
 * who sets `AGENT_LOOKOUT_OMP_HOME` means that folder: if it holds no
 * sessions, that is an answer, not a missing Oh My Pi.
 */
export function createOhMyPiAdapter(options: OhMyPiAdapterOptions = {}): Adapter {
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
      names: ompNamesFor(platform),
    });
  const asker = createDshProcessAsker({ processes, platform, processCheckMs, uptimeMs });

  /** The folder read, worked out on the first poll and once a minute after. */
  let watched: Watched | null = null;
  let foldersAt: number | null = null;
  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What a clock set back keeps the start rule from finishing. */
  let clock = startDshClockGuard();

  const psRuns = platform === "darwin" || platform === "linux";
  const systemNote = psRuns ? null : platform === "win32" ? WINDOWS_NOTE : OTHER_SYSTEM_NOTE;
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const names = platform === "darwin" ? "omp, .omp-wrapped or bun" : "omp or .omp-wrapped";
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no ${names}`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;
  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}${platform === "darwin" ? ` ${BUN_NOTE}` : ""}`;

  /** Where the folder is before the first poll: either of two, when an `XDG_DATA_HOME` folder decides. */
  function before(): string {
    const plain = tildify(ompFoldersFor(env, homeDir, platform, () => false).sessionsDir, homeDir);
    const probe = ompXdgProbe(env, homeDir, platform);
    if (probe === null) return plain;
    const xdg = tildify(ompFoldersFor(env, homeDir, platform, () => true).sessionsDir, homeDir);
    return `${xdg}, when ${tildify(probe, homeDir)} is there, or else ${plain}`;
  }

  /**
   * The folder read, worked out again once a minute, or on a poll whose
   * clock was set back: with `XDG_DATA_HOME` a whole path, by one `stat` of
   * the folder whose being there decides, as Oh My Pi's own look is. When it
   * moves, the finder and the reader start afresh.
   */
  async function watchedAt(checkedAt: number): Promise<Watched> {
    const since = foldersAt === null ? null : checkedAt - foldersAt;
    if (watched !== null && since !== null && since >= 0 && since < FOLDERS_CHECK_MS)
      return watched;
    const probe = ompXdgProbe(env, homeDir, platform);
    let there = false;
    if (probe !== null) {
      try {
        await io.stat(probe);
        there = true;
      } catch {
        there = false;
      }
    }
    const folders = ompFoldersFor(env, homeDir, platform, (dir) => there && dir === probe);
    foldersAt = checkedAt;
    if (
      watched === null ||
      watched.folders.sessionsDir !== folders.sessionsDir ||
      watched.folders.flat !== folders.flat
    ) {
      watched = {
        folders,
        sessionsName: tildify(folders.sessionsDir, homeDir),
        finder: createSessionFileFinder({
          sessionsDir: folders.sessionsDir,
          io,
          sweepMs: options.sweepMs,
          flat: folders.flat,
          isProjectFolder: isDroidProjectFolder,
        }),
        reader: createOmpSessionReader(folders.sessionsDir, io, platform),
      };
      absentAt = null;
    }
    return watched;
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    sessionsName: string,
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
            "Line 1 and line 2 of each .jsonl, the start of line 3, and its newest lines back to the one that decides, at most 8 MiB, as bytes. Only the title, line 2 and two times become text",
        },
        { label: "Process check", value: `ps ${DSH_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ] satisfies SourceFact[],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /** Oh My Pi is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number, sessionsName: string, settingNotes: string): AdapterResult {
    return result(
      "unavailable",
      `Oh My Pi was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.${settingNotes}`,
      "not found",
      checkedAt,
      sessionsName,
    );
  }

  /** Whether the last answer of `ps`, which this poll may not have asked, could not say which programs run. */
  const psCannotSay = () => asker.lastAnswer !== null && !usable(asker.lastAnswer);

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    clock = guardDshClock(clock, platform, checkedAt, monotonic());
    const { folders, sessionsName, finder, reader } = await watchedAt(checkedAt);
    const settingNotes = folders.passedOver
      .map((setting) => ` ${setting === "session-dir" ? SESSION_DIR_NOTE : AGENT_DIR_NOTE}`)
      .join("");

    // A missing Oh My Pi is believed missing for a while, so a machine without
    // it pays nothing on most polls. A clock set back counts as time enough.
    if (!folders.named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt, sessionsName, settingNotes);
    }

    let refs: SessionFileRef[];
    try {
      refs = await finder.recent(checkedAt);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Oh My Pi sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
          sessionsName,
        );
      }
      finder.forget();
      reader.keepOnly(new Set());
      if (folders.named) {
        const cannotSay = psCannotSay();
        return result(
          "ok",
          `${OMP_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Oh My Pi sessions are listed. ${alwaysNotes}${cannotSay ? ` ${PS_FAILED_NOTE}` : ""}`,
          "not found",
          checkedAt,
          sessionsName,
          [],
          cannotSay ? BASIS_WITHOUT_PROCESSES : unaskedBasis,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt, sessionsName, settingNotes);
    }
    absentAt = null;

    const found: Found[] = [];
    const ids = new Set<string>();
    let notASession = false;
    let newer = false;
    // Newest first, so of two files that hold one ID the newer is kept.
    for (const ref of refs) {
      const read = await reader.read(ref, checkedAt);
      if (read.state === "other") notASession = true;
      if (read.state === "newer") newer = true;
      if (read.state !== "ok" || ids.has(read.file.id)) continue;
      ids.add(read.file.id);
      found.push({ ref, file: read.file, writtenAt: read.writtenAt });
    }
    reader.keepOnly(new Set(refs.map((ref) => ref.path)));

    const bootAt = asker.bootAt(checkedAt);
    const facts = found.map((one) => {
      const { tail } = one.file;
      const newest = tail.state === "ok" ? tail.newest : null;
      const behind = tail.state === "ok" ? tail.behind : null;
      const cutOff = tail.state === "ok" ? tail.cutOff : null;
      const writtenAt = plausibleTime(Math.floor(one.writtenAt), checkedAt);
      const exit = exitOf({ newest, behind, cutOff, writtenAt });
      // Whether `ps` could change its status: not once Oh My Pi wrote that it stopped, nor when it was last written before the computer started.
      const settled =
        (exit !== null && plausibleTime(exit.at, checkedAt) !== null) ||
        dshWriter({
          platform,
          writtenAt,
          bootAt,
          answer: null,
          answerAt: 0,
          startFloor: clock.startFloor,
          lowAt: clock.lowAt,
        }) === "gone";
      return { ...one, newest, behind, cutOff, writtenAt, settled };
    });

    const unsettled = facts.filter(({ settled }) => !settled);
    const answer =
      psRuns && unsettled.length > 0
        ? await asker.programsFor(
            checkedAt,
            unsettled.map(({ writtenAt }) => writtenAt),
            refs,
          )
        : null;

    let unread = false;
    let tooFar = false;
    const sessions = facts.map(({ ref, file, newest, behind, cutOff, writtenAt }) => {
      const writer = dshWriter({
        platform,
        writtenAt,
        bootAt,
        answer,
        answerAt: asker.answerAt,
        // A file changed since that answer was asked may have been written after it.
        clockSetBack: asker.clockSetBack && asker.asAsked(ref),
        startFloor: clock.startFloor,
        lowAt: clock.lowAt,
      });
      const status = ohMyPiStatusOf({ newest, behind, cutOff, writtenAt, writer, now: checkedAt });
      if (status.status === "unknown") {
        if (newest === null) tooFar = true;
        else if (newest.sort === "unreadable") unread = true;
      }
      return ohMyPiSession({ file, status, writtenAt, now: checkedAt });
    });

    let detail = `Sessions are read from the files Oh My Pi keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    if (systemNote !== null) detail += ` ${systemNote}`;
    // A poll that does not ask `ps` is named as the last answer was, so a
    // session that settles while it cannot say is compared with that way's poll.
    else if (psCannotSay()) {
      detail += ` ${PS_FAILED_NOTE}`;
      basis = BASIS_WITHOUT_PROCESSES;
    }
    if (tooFar) detail += ` ${TOO_FAR_NOTE}`;
    if (unread) detail += ` ${UNREAD_NOTE}`;
    if (notASession) detail += ` ${NOT_A_SESSION_NOTE}`;
    if (newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    detail += settingNotes;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessionsName, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: OH_MY_PI_CAPABILITIES,
    get lookingIn() {
      return `Looking for Oh My Pi sessions in ${watched === null ? before() : watched.sessionsName}.`;
    },
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Oh My Pi sessions.",
          every(pollIntervalMs),
          now(),
          watched?.sessionsName ?? before(),
        );
      }
    },
  };
}
