import os from "node:os";
import path from "node:path";

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
import type { ProcessAnswer } from "../opencode/processes.ts";
import { every } from "../words.ts";
import { createPiProcessReader, PI_TABLE_ARGS, type PiProcessReader } from "./processes.ts";
import { createSessionFileReader, type PiSessionFile } from "./sessionFile.ts";
import { createSessionFileFinder, type SessionFileRef } from "./sessionFiles.ts";
import { piSession, SOURCE_ID } from "./toSession.ts";

/** The variable that names Pi's agent folder, for Agent Lookout alone. */
export const PI_HOME_ENV = "AGENT_LOOKOUT_PI_HOME";

/** Pi's own variables for its agent folder and its sessions folder. */
export const PI_OWN_HOME_ENV = "PI_CODING_AGENT_DIR";
export const PI_OWN_SESSIONS_ENV = "PI_CODING_AGENT_SESSION_DIR";

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether a `pi` program runs, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no `pi`
 * program runs, since Pi may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the files while a `pi` program runs. */
export const BASIS = "files";

/**
 * The way it reads while `ps` says no `pi` program runs, when every session is
 * finished. Closing the last `pi` finishes every session at once, and opening one
 * shows them all as unknown, so such a poll is named apart and compared only with
 * the last time none ran.
 */
export const BASIS_CLOSED = "files-closed";

/**
 * The way it reads while `ps` cannot say whether Pi runs, when no session is
 * shown as finished. Named apart, so every finished session does not seem to
 * start again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

const LABEL = "Pi";

/** Said whenever Pi is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Pi session is working or waiting for you, and nothing ties a session to a process, so a session shows as unknown while a pi program runs and as finished once none does.";

/** Said whenever Pi is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Pi's source at v1.5.0 and not yet checked on a computer running Pi, so a status can be wrong.";

/** Said when a file is of a newer format than this reads. */
export const NEWER_FORMAT_NOTE =
  "A Pi newer than this Agent Lookout wrote a session in a format it does not read, so that session is not shown.";

/**
 * What a Pi session can show, from the files this adapter reads. See
 * docs/adapters/pi.md for each. Built from Pi's source at v1.5.0 and not yet
 * checked on a computer running it.
 *
 * - No Working and idle: nothing ties a session to a process, so a turn a crash
 *   cut off cannot be told from one under way.
 * - No Needs you: Pi itself asks for no approval before a tool runs, and nothing
 *   on disk says when it waits for you.
 * - Finished is every session while `ps` shows no `pi` program, on macOS and
 *   Linux. Pi writes no end to a session.
 * - No Failed: a failed turn is written inside a message, which is not parsed.
 * - The name is one a person or an extension gave, else the folder's. Pi names no
 *   session by itself.
 * - No Jump, Stop or Answer: a session's file names no process or terminal.
 * - No Quiet for: the page says how quiet a working session is, and a Pi session
 *   is never shown as working.
 * - No Tokens: a reply's counts are on the line with its text, which is never
 *   parsed.
 */
export const PI_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason:
      "Nothing ties a Pi session to a process, so a turn a crash cut off looks like one under way.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Pi itself asks for no approval before a tool runs, and nothing on disk says when it waits for you.",
  },
  finished: {
    level: "partly",
    reason:
      "Every session at once, when ps shows no pi program, on macOS and Linux. Pi writes no end to one.",
  },
  failed: { level: "no", reason: "Pi writes a failed turn inside a message, which is not parsed." },
  names: {
    level: "partly",
    reason: "One you or an extension gave the session, else the folder's. Pi gives it none itself.",
  },
  jump: { level: "no", reason: "A Pi session's file names no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Pi session never shows as working.",
  },
  tokens: {
    level: "no",
    reason: "A reply's counts are on the line with its text, which is not parsed.",
  },
  stop: {
    level: "no",
    reason: "A Pi session's file names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Pi, so it cannot send an answer.",
  },
};

/** One of Pi's own settings as a folder: `~` is the home folder, and a relative one cannot be followed. */
function ownFolder(value: string | undefined, homeDir: string): string | undefined {
  const folder = value?.trim();
  if (!folder) return undefined;
  if (folder === "~") return homeDir;
  if (folder.startsWith("~/") || folder.startsWith("~\\")) {
    return path.join(homeDir, folder.slice(2));
  }
  return path.isAbsolute(folder) ? folder : undefined;
}

/**
 * The folder this adapter reads. `AGENT_LOOKOUT_PI_HOME` names Pi's agent folder,
 * for Agent Lookout alone. Otherwise it is worked out as Pi does (`config.ts`,
 * and `main.ts` for the order): `PI_CODING_AGENT_SESSION_DIR`, else `sessions` in
 * `PI_CODING_AGENT_DIR` or `~/.pi/agent`, on every system. `--session-dir` and the
 * `sessionDir` setting are not followed: the settings file is never read, and a
 * process's arguments are not either.
 */
export function piSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = env[PI_HOME_ENV]?.trim();
  if (own) return path.resolve(own, "sessions");
  const sessions = ownFolder(env[PI_OWN_SESSIONS_ENV], homeDir);
  if (sessions !== undefined) return path.resolve(sessions);
  const home = ownFolder(env[PI_OWN_HOME_ENV], homeDir) ?? path.join(homeDir, ".pi", "agent");
  return path.resolve(home, "sessions");
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface PiAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system's rules for folders, and whether `ps` is asked. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What asks whether a `pi` program runs. Defaults to one that runs `ps`. */
  processes?: PiProcessReader;
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
  /** How often every session file is looked up. Defaults to a minute. */
  sweepMs?: number;
}

/** One file this poll read. */
interface Found {
  file: PiSessionFile;
  writtenAt: number;
}

/**
 * Finds Pi's sessions on this machine from the files Pi keeps, with nothing
 * installed, no setting changed and no program of Pi's run. Built from Pi's source
 * at v1.5.0, and not yet checked on a computer running it.
 *
 * Pi keeps each session in one JSONL file, in a folder for its working directory
 * under `~/.pi/agent/sessions`, and removes none by itself. So a poll looks up
 * each project folder and each file written in the last day, with `lstat`, and
 * looks through every other file once a minute (`sessionFiles.ts`).
 * It opens a file only when it changes, and reads the first line and the lines
 * that name the session, from the bytes at each end (`sessionFile.ts`). The rest
 * of the file, which is the conversation, is never read as text. While there are
 * sessions to show, it asks `ps` whether a `pi` program runs, at most every 10
 * seconds, and sooner, though not within 2 seconds of the last ask, when a session
 * is written after `ps` said none runs (`processes.ts`).
 *
 * Each session whose file was written in the last 24 hours is listed. Nothing Pi
 * writes says whether a session is open: it shows as unknown while a `pi` program
 * runs, or while `ps` cannot say, as on Windows, and as finished once none does.
 * It never shows as working or as needing you. A crash leaves a session as a quit
 * does, and it is finished like the others once no `pi` runs.
 *
 * Pi not being installed costs nothing: when the sessions folder is missing, the
 * adapter says so and looks again only once a minute, and runs nothing. Someone
 * who sets `AGENT_LOOKOUT_PI_HOME` means that folder: if it holds no sessions, that
 * is an answer, not a missing Pi.
 */
export function createPiAdapter(options: PiAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createPiProcessReader({ platform });

  const named = Boolean(env[PI_HOME_ENV]?.trim());
  const sessionsDir = piSessionsDirFor(env, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const files = createSessionFileFinder({ sessionsDir, io, sweepMs: options.sweepMs });
  const reader = createSessionFileReader(sessionsDir, io, platform);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastProcesses: ProcessAnswer | null = null;
  let processesAt = 0;

  const psRuns = platform === "darwin" || platform === "linux";
  /**
   * The way a poll that did not ask `ps` is read. Where `ps` is never run, every
   * poll that lists a session is read without it, so one that lists none is too,
   * and a session's leaving the list is compared with the poll that listed it.
   */
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no pi`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Sessions folder", value: sessionsName },
      { label: "Read", value: read },
      { label: "Process check", value: `ps ${PI_TABLE_ARGS.join(" ")}` },
      { label: "Process check run", value: processCheckRun },
    ];
  }

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
      watching: watching(read),
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written after
   * it said no `pi` program runs, since Pi may have been started since. A clock
   * set back counts as time enough.
   */
  async function processesFor(found: readonly Found[], checkedAt: number): Promise<ProcessAnswer> {
    const since = checkedAt - processesAt;
    let due = lastProcesses === null || since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastProcesses?.ok && !lastProcesses.running) {
      due = found.some(({ writtenAt }) => writtenAt > processesAt);
    }
    if (lastProcesses === null || due) {
      lastProcesses = await processes.read();
      processesAt = checkedAt;
    }
    return lastProcesses;
  }

  /** Pi is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Pi was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Pi is believed missing for a while, so a machine without it pays
    // nothing on most polls. A clock set back counts as time enough.
    if (!named && absentAt !== null) {
      const since = checkedAt - absentAt;
      if (since >= 0 && since < recheckMs) return notFound(checkedAt);
    }

    let refs: SessionFileRef[];
    try {
      refs = await files.recent(checkedAt);
    } catch (error) {
      if (!isMissing(error)) {
        return result(
          "error",
          `Pi sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      files.forget();
      reader.keepOnly(new Set());
      if (named) {
        return result(
          "ok",
          `${PI_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Pi sessions are listed. ${alwaysNotes}`,
          "not found",
          checkedAt,
        );
      }
      absentAt = checkedAt;
      return notFound(checkedAt);
    }
    absentAt = null;

    const found: Found[] = [];
    const ids = new Set<string>();
    let newer = false;
    // Newest first, so of two files that hold one id, the newest is kept.
    for (const ref of refs) {
      const read = await reader.read(ref);
      if (read.state === "newer") newer = true;
      if (read.state !== "ok" || ids.has(read.session.id)) continue;
      ids.add(read.session.id);
      found.push({ file: read.session, writtenAt: ref.info.mtimeMs });
    }
    reader.keepOnly(new Set(refs.map((ref) => ref.path)));

    // `ps` is asked only while there is a session to show.
    const asked = found.length > 0 ? await processesFor(found, checkedAt) : null;
    const open = asked === null || !asked.ok || asked.running;
    const sessions = found.map(({ file, writtenAt }) =>
      piSession({ file, open, writtenAt, now: checkedAt }),
    );

    let detail = `Sessions are read from the files Pi keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether Pi runs, so no session is shown as finished."
        : " Agent Lookout cannot tell on this system whether Pi runs, so no session is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked?.ok && !asked.running) {
      detail += " No pi program runs, so each session shows as finished.";
      basis = BASIS_CLOSED;
    }
    if (newer) detail += ` ${NEWER_FORMAT_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: PI_CAPABILITIES,
    lookingIn: `Looking for Pi sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Pi sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
