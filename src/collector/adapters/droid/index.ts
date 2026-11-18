import os from "node:os";
import path from "node:path";

import type {
  Session,
  SourceCapabilities,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { WRITE_TIME_STEP_MS } from "../../../core/time.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo } from "../../files/readOnlyIo.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import type { ProcessAnswer } from "../opencode/processes.ts";
import type { PiAdapterOptions } from "../pi/index.ts";
import { createPiProcessReader, PI_TABLE_ARGS } from "../pi/processes.ts";
import { createSessionFileFinder, type SessionFileRef } from "../pi/sessionFiles.ts";
import { every } from "../words.ts";
import {
  createDroidSessionReader,
  isDroidProjectFolder,
  sessionIdOf,
  type DroidSessionFile,
} from "./sessionFile.ts";
import { createSettingsReader, settingsPathFor } from "./settingsFile.ts";
import { droidSession, SOURCE_ID } from "./toSession.ts";

/**
 * The Droid adapter. Droid is Factory's coding agent, in its command `droid`.
 * Its own program is not open source, so this was built from Factory's public
 * material alone: its documentation, in Factory-AI/factory at e6241cd, and its
 * two Droid SDKs under the Apache-2.0 licence, the Python droid-sdk 0.5.0 and
 * the TypeScript @factory/droid-sdk 0.11.0, whose session lists read Droid's
 * files as this does. It has not yet been checked on a computer running Droid.
 * See docs/adapters/droid.md.
 *
 * It is a small adapter of its own, not a profile of Pi's: Droid's first line,
 * its IDs and its project folders differ from Pi's, and it keeps a settings
 * file beside each session. It shares Pi's finder of session files
 * (`../pi/sessionFiles.ts`), with a test of its own for project folders, and
 * Pi's question to `ps` (`../pi/processes.ts`), with Droid's names.
 */

/** The variable that names Droid's folder, `~/.factory`, for Agent Lookout alone. */
export const DROID_HOME_ENV = "AGENT_LOOKOUT_DROID_HOME";

/** Droid's folder, in the home folder, on every system. */
export const DROID_DIR = ".factory";

/**
 * The names of Droid's program, as `ps -A -o comm=` prints them:
 *
 * droid      the command, `droid.exe` on Windows, where `ps` is not asked
 * droid-dev  the command the TypeScript SDK starts in place of `droid` when its
 *            caller asks for a development build
 */
export const DROID_PROGRAMS: ReadonlySet<string> = new Set(["droid", "droid-dev"]);

/** How long a sessions folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether a `droid` program runs, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no
 * `droid` program runs, or up to 2 seconds before, as a disk can keep a write's
 * time rounded down, since Droid may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the files while a `droid` program may run. */
export const BASIS = "files";

/**
 * The way it reads while `ps` says no `droid` program runs, when every session
 * is finished. Closing the last `droid` finishes every session at once, and
 * opening one shows them all as unknown, so such a poll is named apart and
 * compared only with the last time none ran.
 */
export const BASIS_CLOSED = "files-closed";

/**
 * The way it reads while `ps` cannot say whether Droid runs, and always on
 * Windows, when no session is shown as finished. Named apart, so every
 * finished session does not seem to start again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "files-without-processes";

/** Said whenever Droid is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Droid session is working or waiting for you, and nothing ties a session to a process, so a session shows as unknown while any droid program runs and as finished once none does, by a ps asked 2 seconds or more after the last write to any session shown, or after it when the clock was just set back. Factory's desktop app, Droid's background daemon and a droid computer ssh or port-forward tunnel run droid too, so while any of them runs every session shows as unknown.";

/** Said whenever Droid is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Factory's documentation, its Droid SDKs droid-sdk 0.5.0 and @factory/droid-sdk 0.11.0, and reports on Factory's issue tracker, not from Droid's own program, and not yet checked on a computer running Droid, so a status can be wrong.";

/** Said when a file in the sessions folder is not a Droid session's. */
export const NOT_A_SESSION_NOTE =
  "A file in the sessions folder does not begin as a Droid session does, so it is not shown. A newer Droid may keep its sessions differently.";

/**
 * What a Droid session can show, from the files this adapter reads. See
 * docs/adapters/droid.md for each. Built from Factory's documentation and its
 * Droid SDKs, and not yet checked on a computer running Droid.
 *
 * - No Working and idle: nothing ties a session to a process, and Droid writes
 *   no status to its files, so a turn a crash cut off cannot be told from one
 *   under way.
 * - No Needs you: nothing Droid writes to a session's files says it waits.
 * - Finished is every session while `ps` shows no `droid` program, asked 2
 *   seconds or more after the last write to any session shown, on macOS and
 *   Linux.
 * - No Failed: nothing on the first line says a turn failed, and nothing
 *   after it is read.
 * - The name is the folder's. Droid's title is made from the first prompt, or
 *   set by a rename, and is never read.
 * - No Jump, Stop or Answer: a session's file names no process or terminal.
 * - No Quiet for: a Droid session is never shown as working.
 * - No Tokens: Droid keeps a session's counts in its settings file, of which
 *   only `archivedAt` is read.
 */
export const DROID_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason:
      "Nothing ties a Droid session to a process, and Droid writes no status, so a turn a crash cut off looks like one under way.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Nothing Droid writes to a session's files says it waits for your approval or an answer.",
  },
  finished: {
    level: "partly",
    reason:
      "Every session at once, when ps shows no droid program 2 seconds or more after the last write to any, on macOS and Linux.",
  },
  failed: {
    level: "no",
    reason:
      "Nothing on a Droid session's first line says a turn failed, and nothing after it is read.",
  },
  names: {
    level: "partly",
    reason:
      "The folder's. Droid names a session from your first prompt, or you rename it, and that title is never read.",
  },
  jump: { level: "no", reason: "A Droid session's file names no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Droid session never shows as working.",
  },
  tokens: {
    level: "no",
    reason:
      "Droid keeps a session's counts in its settings file, of which only archivedAt is read.",
  },
  stop: {
    level: "no",
    reason: "A Droid session's file names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Droid, so it cannot send an answer.",
  },
};

/**
 * The folder this adapter reads: `sessions` in the folder
 * `AGENT_LOOKOUT_DROID_HOME` names, for Agent Lookout alone, else
 * `~/.factory/sessions`, which on Windows is `%USERPROFILE%\.factory\sessions`,
 * where both SDKs look. `FACTORY_HOME_OVERRIDE`, which Factory does not
 * document for sessions and neither SDK's list follows, is not either, and
 * neither is any setting or a process's arguments or environment.
 */
export function droidSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const own = env[DROID_HOME_ENV]?.trim();
  if (own) return path.resolve(own, "sessions");
  return path.resolve(homeDir, DROID_DIR, "sessions");
}

/** Everything the adapter touches outside itself. Tests replace these. */
export type DroidAdapterOptions = PiAdapterOptions;

/** One session this poll lists. */
interface Found {
  file: DroidSessionFile;
  writtenAt: number;
}

/**
 * Finds Droid's sessions on this machine from the files Droid keeps, with
 * nothing installed, no setting changed and no program of Droid's run.
 *
 * Droid keeps each session in one JSONL file, `<id>.jsonl`, in a folder for
 * its project in `~/.factory/sessions`, whose name begins with `-`, or loose
 * in that folder for older ones, with an `<id>.settings.json` beside it. So a
 * poll looks up each project folder and each file written in the last day,
 * with `lstat`, as Pi's adapter does, and looks through every other file once
 * a minute. Of each file whose name is one Droid gives it reads the first
 * line, and only when the file changed (`sessionFile.ts`), and of each that
 * shows a session the settings file beside it, only for `archivedAt`
 * (`settingsFile.ts`). The conversation after the first line is never read as
 * text.
 *
 * Of two files that hold one ID, the newer is opened first, and the older only
 * when the newer shows no session or an archived one, as in the Python SDK.
 * Archived sessions are left out, and so are files with nothing after their
 * first line, as Factory's app can leave for a session that never had a
 * prompt.
 *
 * While there are sessions to show, it asks `ps` whether a `droid` program
 * runs, at most every 10 seconds, and sooner, though not within 2 seconds of
 * the last ask, when a session is written after `ps` said none runs, or up to
 * 2 seconds before. A session shows as unknown while one does, or while `ps`
 * cannot say, as on Windows, and as finished once none does, by an answer
 * asked 2 seconds or more after the last write to any session shown, as a disk
 * can keep a write's time rounded down, or after it when that answer was asked
 * because the clock was set back. A write nearer the answer says a `droid` may
 * have started since, so until `ps` is asked again every session shows as
 * unknown, as while one runs, and closing the last `droid` still finishes every
 * session at once. It never shows as working, as needing you or as failed.
 *
 * Droid not being installed costs nothing: when the sessions folder is missing,
 * the adapter says so and looks again only once a minute, and runs nothing.
 * Someone who sets `AGENT_LOOKOUT_DROID_HOME` means that folder: if it holds no
 * sessions, that is an answer, not a missing Droid.
 */
export function createDroidAdapter(options: DroidAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes =
    options.processes ?? createPiProcessReader({ platform, programs: DROID_PROGRAMS });

  const named = Boolean(env[DROID_HOME_ENV]?.trim());
  const sessionsDir = droidSessionsDirFor(env, homeDir);
  const sessionsName = tildify(sessionsDir, homeDir);
  const files = createSessionFileFinder({
    sessionsDir,
    io,
    sweepMs: options.sweepMs,
    isProjectFolder: isDroidProjectFolder,
  });
  const reader = createDroidSessionReader(sessionsDir, io, platform);
  const settings = createSettingsReader(sessionsDir, io);

  /** When the folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastProcesses: ProcessAnswer | null = null;
  let processesAt = 0;
  /** Whether that answer was asked because the clock was set back: then nothing is allowed for a rounded write time. */
  let askedOnSetBack = false;

  const psRuns = platform === "darwin" || platform === "linux";
  /**
   * The way a poll that did not ask `ps` is read. Where `ps` is never run, every
   * poll that lists a session is read without it, so one that lists none is too,
   * and a session's leaving the list is compared with the poll that listed it.
   */
  const unaskedBasis = psRuns ? BASIS : BASIS_WITHOUT_PROCESSES;
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no droid`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;

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
      label: "Droid",
      state,
      detail,
      watching: [
        { label: "Sessions folder", value: sessionsName },
        { label: "Read", value: read },
        {
          label: "Files read",
          value:
            "The first line of each <id>.jsonl, and archivedAt from the <id>.settings.json beside it",
        },
        { label: "Process check", value: `ps ${PI_TABLE_ARGS.join(" ")}` },
        { label: "Process check run", value: processCheckRun },
      ],
      checkedAt,
    };
    return state === "ok" ? { health, sessions, basis } : { health, sessions: [] };
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written
   * after it said no `droid` program runs, or up to 2 seconds before, as a disk
   * can keep a write's time rounded down, since one may have been started
   * since. A clock set back counts as time enough.
   */
  async function processesFor(found: readonly Found[], checkedAt: number): Promise<ProcessAnswer> {
    const since = checkedAt - processesAt;
    let due = lastProcesses === null || since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastProcesses?.ok && !lastProcesses.running) {
      due = found.some(({ writtenAt }) => writtenAt + WRITE_TIME_STEP_MS > processesAt);
    }
    if (lastProcesses === null || due) {
      askedOnSetBack = lastProcesses !== null && since < 0;
      lastProcesses = await processes.read();
      processesAt = checkedAt;
    }
    return lastProcesses;
  }

  /**
   * Whether an answer that no `droid` runs was asked late enough to tell:
   * 2 seconds or more after the last write to every session shown, as a disk
   * can keep a write's time rounded down, or at or after it when the answer was
   * asked because the clock was set back. A write nearer says a `droid` may have
   * started since `ps` looked.
   */
  function answerTells(found: readonly Found[]): boolean {
    const step = askedOnSetBack ? 0 : WRITE_TIME_STEP_MS;
    return found.every(({ writtenAt }) => processesAt >= writtenAt + step);
  }

  /** Droid is not on this machine, or not where it was said to be. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Droid was not found: there is no ${sessionsName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();

    // A missing Droid is believed missing for a while, so a machine without it
    // pays nothing on most polls. A clock set back counts as time enough.
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
          `Droid sessions could not be read: the folder ${sessionsName} could not be listed.`,
          "cannot be read",
          checkedAt,
        );
      }
      files.forget();
      reader.keepOnly(new Set());
      settings.keepOnly(new Set());
      if (named) {
        return result(
          "ok",
          `${DROID_HOME_ENV} is set, and there is no ${sessionsName} folder, so no Droid sessions are listed. ${alwaysNotes}`,
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
    const keptSettings = new Set<string>();
    let notASession = false;
    // Newest first, so of two files that hold one ID the newer is opened first,
    // and the older is never opened once the newer shows a session that is listed.
    for (const ref of refs) {
      const id = sessionIdOf(path.basename(ref.path));
      if (id === null) {
        notASession = true;
        continue;
      }
      if (ids.has(id)) continue;
      const read = await reader.read(ref, id);
      if (read.state === "other") notASession = true;
      if (read.state !== "ok") continue;
      const settingsPath = settingsPathFor(ref.path, id);
      keptSettings.add(settingsPath);
      // Not taken: an older file with the ID can show it, as in the Python SDK.
      if (await settings.archived(settingsPath)) continue;
      ids.add(id);
      found.push({ file: read.session, writtenAt: read.writtenAt });
    }
    reader.keepOnly(new Set(refs.map((ref) => ref.path)));
    settings.keepOnly(keptSettings);

    // `ps` is asked only while there is a session to show.
    const asked = found.length > 0 ? await processesFor(found, checkedAt) : null;
    const closed = asked !== null && asked.ok && !asked.running && answerTells(found);
    const sessions = found.map(({ file, writtenAt }) =>
      droidSession({ file, open: !closed, writtenAt, now: checkedAt }),
    );

    let detail = `Sessions are read from the files Droid keeps in ${sessionsName}. ${alwaysNotes}`;
    let basis = unaskedBasis;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether Droid runs, so no session is shown as finished."
        : " Agent Lookout cannot tell on this system whether Droid runs, so no session is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (closed) {
      detail += " No droid program runs, so each session shows as finished.";
      basis = BASIS_CLOSED;
    }
    if (notASession) detail += ` ${NOT_A_SESSION_NOTE}`;
    return result("ok", detail, every(pollIntervalMs), checkedAt, sessions, basis);
  }

  return {
    id: SOURCE_ID,
    label: "Droid",
    capabilities: DROID_CAPABILITIES,
    lookingIn: `Looking for Droid sessions in ${sessionsName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Droid sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
