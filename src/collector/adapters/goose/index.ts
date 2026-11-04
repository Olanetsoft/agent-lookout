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
import { createDatabaseReader, RETRY_MS, type DatabaseReader } from "./database.ts";
import {
  createGooseProcessReader,
  GOOSE_TABLE_ARGS,
  type GooseProcessReader,
} from "./processes.ts";
import { DATABASE_FILE, DATABASE_FOLDER, type SessionRow } from "./sessionRows.ts";
import { gooseSession, isListed, SOURCE_ID } from "./toSession.ts";

/** The variable that names Goose's data folder, for Agent Lookout alone. */
export const GOOSE_HOME_ENV = "AGENT_LOOKOUT_GOOSE_HOME";

/** Goose's own variable for the root of its folders. Its data folder is `data` in it. */
export const GOOSE_OWN_ROOT_ENV = "GOOSE_PATH_ROOT";

/** Where Goose keeps its data, under the home folder, when nothing names another place. */
export const DEFAULT_DATA_HOME = [".local", "share"] as const;

/** How long a data folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether a Goose program runs, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no Goose
 * program runs, since Goose may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the database while a Goose program runs. */
export const BASIS = "database";

/**
 * The way it reads while `ps` says no Goose program runs, when every session is
 * finished. Closing Goose finishes every session at once, and opening it again
 * shows them all as unknown, so such a poll is named apart and compared only
 * with the last time Goose was closed.
 */
export const BASIS_CLOSED = "database-closed";

/**
 * The way it reads while `ps` cannot say whether Goose runs, when no session is
 * shown as finished. Named apart, so every finished session does not seem to
 * start again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "database-without-processes";

const LABEL = "Goose";

/** Said whenever Goose is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Goose session is working or waiting for you, and nothing ties a session to a process, so a session shows as unknown while a Goose program runs and as finished once none does.";

/** Said whenever Goose is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Goose's source at v1.57.0 and not yet checked on a computer running Goose, so a status can be wrong.";

/** Said on Linux when no sqlite3 was found, which Ubuntu and Debian do not install. */
export const NO_SQLITE_ADVICE = "On Ubuntu or Debian, install it with sudo apt install sqlite3.";

/** Said when a database is laid out as a version older than the adapter reads. */
export const UNSUPPORTED_ADVICE = "If your Goose is older than v1.34.0, update it.";

/** Said on Windows, where nothing of Goose's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read Goose's sessions on Windows: they are read with sqlite3, which it does not run there.";

/**
 * What a Goose session can show, from the database this adapter reads with
 * `sqlite3`. See docs/adapters/goose.md for each. Built from Goose's source at
 * v1.57.0 and not yet checked on a computer running it.
 *
 * - No Working and idle: nothing ties a session to a process, so a turn a crash
 *   cut off cannot be told from one under way.
 * - No Needs you: Goose writes a tool's approval into a message, which is not
 *   read, and that message stays behind when a crash ends the wait.
 * - Finished is every session while `ps` shows no Goose program, on macOS and
 *   Linux. Goose writes no end to a session.
 * - No Failed: Goose writes no field that says a turn failed.
 * - The name is one `user_set_name` marks, which the person gave the session or
 *   an ACP client sent, else the folder's. Goose's title can be the first four
 *   words of the first prompt, and no field says when it is not, so it is never
 *   asked for.
 * - No Jump, Stop or Answer: the database names no process or terminal.
 * - No Quiet for: the page says how quiet a working session is, and a Goose
 *   session is never shown as working.
 * - No Tokens: a session's row holds counts, which a compaction replaces with an
 *   estimate, and they are not read.
 */
export const GOOSE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason:
      "Nothing ties a Goose session to a process, so a turn a crash cut off looks like one under way.",
  },
  "needs-you": {
    level: "no",
    reason:
      "Goose writes a tool's approval inside a message, which is not read, and a crash leaves it there.",
  },
  finished: {
    level: "partly",
    reason:
      "Every session at once, when ps shows no Goose program, on macOS and Linux. Goose writes no end to one.",
  },
  failed: { level: "no", reason: "Goose writes no field that says a turn failed." },
  names: {
    level: "partly",
    reason:
      "The folder's, or one you gave the session. Goose's title can be the start of your first prompt.",
  },
  jump: { level: "no", reason: "Goose's database names no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Goose session never shows as working.",
  },
  tokens: { level: "no", reason: "Agent Lookout does not read the counts on a session's row." },
  stop: {
    level: "no",
    reason: "Goose's database names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Goose, so it cannot send an answer.",
  },
};

/** The command, as Sources shows it: its questions are fixed text. */
export const COMMAND_SHOWN = "sqlite3 -init /dev/null -batch -json <database> <fixed query>";

/**
 * Goose's data folder, worked out as Goose does (`config/paths.rs`), on macOS as
 * on Linux: the one `AGENT_LOOKOUT_GOOSE_HOME` names, else `data` in
 * `GOOSE_PATH_ROOT` when that is an absolute path, else `goose` in
 * `XDG_DATA_HOME` when that is one, else `~/.local/share/goose`. On Windows it
 * is `%APPDATA%\Block\goose\data`, which is never read.
 */
export function gooseDataDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[GOOSE_HOME_ENV]?.trim() || undefined;
  if (override !== undefined) return path.resolve(override);
  const root = env[GOOSE_OWN_ROOT_ENV];
  if (root && path.isAbsolute(root)) return path.resolve(root, "data");
  const xdg = env.XDG_DATA_HOME;
  const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, ...DEFAULT_DATA_HOME);
  return path.resolve(data, "goose");
}

/** The database the adapter reads: `sessions/sessions.db` in Goose's data folder. */
export function gooseDatabaseFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.join(gooseDataDirFor(env, homeDir), DATABASE_FOLDER, DATABASE_FILE);
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface GooseAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system, which says whether `sqlite3` and `ps` are run. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What reads the database. Defaults to one that runs `sqlite3`. */
  reader?: DatabaseReader;
  /** What asks whether a Goose program runs. Defaults to one that runs `ps`. */
  processes?: GooseProcessReader;
  /** How often, at most, `ps` is asked. Defaults to 10 seconds. */
  processCheckMs?: number;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing data folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
}

/**
 * Finds Goose's sessions on this machine from the database Goose keeps, with
 * nothing installed, no setting changed and no program of Goose's run.
 *
 * Goose keeps every session of its command and its desktop app in one SQLite
 * database, `sessions/sessions.db` in its data folder. Its own listing is its
 * `goose` command, which opens that database and may migrate it. So the adapter
 * looks at the database and the two files SQLite keeps beside it with `lstat`
 * on every poll, and asks the system's `sqlite3` a fixed question when the
 * database or its `-wal` changes (`database.ts`, `sessionRows.ts`). While there
 * are sessions to show, it asks `ps` whether a Goose program runs, at most every
 * 10 seconds, and sooner, though not within 2 seconds of the last ask, when a
 * session is written after `ps` said none runs (`processes.ts`). Nothing is read
 * on Windows.
 *
 * Each session of the kinds Goose lists to people that has a message and is not
 * archived is listed for 24 hours after Goose last wrote it. Nothing Goose writes
 * says whether a session is open: it shows as unknown while a Goose program runs,
 * or while `ps` cannot say, and as finished once none does. It never shows as
 * working or as needing you. A crash leaves a session as a quit does, and it is
 * finished like the others once no Goose runs.
 *
 * Goose not being installed costs nothing: when its data folder is missing, the
 * adapter says so and looks again only once a minute, with a single `stat`, and
 * runs neither `sqlite3` nor `ps`.
 *
 * The data folder is `AGENT_LOOKOUT_GOOSE_HOME` if set, otherwise as Goose works
 * it out (`gooseDataDirFor`). Someone who sets the variable means that folder: if
 * it holds no database, that is an answer, not a missing Goose.
 *
 * Built from Goose's source at v1.57.0, and not yet checked on a computer
 * running Goose.
 */
export function createGooseAdapter(options: GooseAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createGooseProcessReader({ platform });

  const named = Boolean(env[GOOSE_HOME_ENV]?.trim());
  const home = gooseDataDirFor(env, homeDir);
  const database = gooseDatabaseFor(env, homeDir);
  const homeName = tildify(home, homeDir);
  const databaseName = tildify(database, homeDir);
  const reader = options.reader ?? createDatabaseReader({ file: database, io, platform });

  /** When the data folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the data folder has been seen, until the database goes missing. */
  let homeSeen = false;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastProcesses: ProcessAnswer | null = null;
  let processesAt = 0;

  const psRuns = platform === "darwin" || platform === "linux";
  const commandRun = platform === "win32" ? "not run on Windows" : "when the database changes";
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no Goose`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Data folder", value: homeName },
      { label: "Database", value: databaseName },
      { label: "Read", value: read },
      { label: "Command", value: COMMAND_SHOWN },
      { label: "Command run", value: commandRun },
      { label: "Process check", value: `ps ${GOOSE_TABLE_ARGS.join(" ")}` },
      { label: "Process check run", value: processCheckRun },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
    basis: string = BASIS,
    advice?: string,
  ): AdapterResult {
    const health: SourceHealth = {
      id: SOURCE_ID,
      label: LABEL,
      state,
      detail,
      watching: watching(read),
      checkedAt,
    };
    if (advice !== undefined) health.advice = advice;
    return state === "ok" ? { health, sessions: [], basis } : { health, sessions: [] };
  }

  /**
   * What `ps` says, asked again when it is due: every 10 seconds, and sooner,
   * though not within 2 seconds of the last ask, when a session was written after
   * it said no Goose program runs, since Goose may have been started since.
   * `updated_at` is in whole seconds, so a session is taken as written at the end
   * of its second: one written in the same second as that ask counts as after it,
   * which costs at most one more ask. A clock set back counts as time enough.
   */
  async function processesFor(
    listed: readonly SessionRow[],
    checkedAt: number,
  ): Promise<ProcessAnswer> {
    const since = checkedAt - processesAt;
    let due = lastProcesses === null || since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastProcesses?.ok && !lastProcesses.running) {
      due = listed.some((row) => (row.updatedAt ?? -Infinity) + 999 > processesAt);
    }
    if (lastProcesses === null || due) {
      lastProcesses = await processes.read();
      processesAt = checkedAt;
    }
    return lastProcesses;
  }

  /** Goose is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `Goose was not found: there is no ${homeName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /**
   * Whether the data folder is there. Only a folder that is missing, or is not a
   * folder, counts as not there. This `stat` follows a link, and says only what
   * kind of thing is there: the reader's `lstat` then refuses a link to a folder.
   */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (platform === "win32") {
      return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
    }

    // A missing Goose is believed missing for a while, so a machine without it
    // pays nothing on most polls. A clock set back counts as time enough.
    if (!named) {
      if (absentAt !== null) {
        const since = checkedAt - absentAt;
        if (since >= 0 && since < recheckMs) return notFound(checkedAt);
      }
      if (!homeSeen) {
        if (!(await homeIsThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        absentAt = null;
        homeSeen = true;
      }
    }

    const read = await reader.read(checkedAt);
    const looked = every(pollIntervalMs);
    switch (read.state) {
      case "not-on-windows":
        return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
      case "missing": {
        if (named) {
          return result(
            "ok",
            `${GOOSE_HOME_ENV} is set to ${homeName}, which has no ${DATABASE_FOLDER}/${DATABASE_FILE}, so no Goose sessions are listed. ${alwaysNotes}`,
            looked,
            checkedAt,
          );
        }
        // The data folder may have gone with its database.
        homeSeen = false;
        if (!(await homeIsThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        homeSeen = true;
        return result(
          "ok",
          `Goose has not saved a database at ${databaseName} yet. ${alwaysNotes}`,
          looked,
          checkedAt,
        );
      }
      case "not-safe":
        return result(
          "error",
          `Goose's database, ${databaseName}, was not read: a link or something other than an ordinary file is in its place, beside it or in place of a folder above it, or its -wal file holds something but has no -shm file beside it, so it cannot be read without following a link or writing to it.`,
          looked,
          checkedAt,
        );
      case "no-sqlite":
        return result(
          "error",
          `No sqlite3 program was found to read Goose's database, ${databaseName}, so no Goose sessions are listed.`,
          looked,
          checkedAt,
          BASIS,
          platform === "linux" ? NO_SQLITE_ADVICE : undefined,
        );
      case "failed":
        return result(
          "error",
          `sqlite3 could not read Goose's database, ${databaseName}, so no Goose sessions are listed. Agent Lookout tries again when it changes, or ${RETRY_MS / 1000} seconds on.`,
          looked,
          checkedAt,
        );
      case "unsupported":
        return result(
          "error",
          `Goose's database, ${databaseName}, is laid out as a version of Goose that Agent Lookout does not read. It reads those of Goose v1.34.0 and later.`,
          looked,
          checkedAt,
          BASIS,
          UNSUPPORTED_ADVICE,
        );
      case "read":
        break;
    }

    // `ps` is asked only while there is a session to show.
    const listed = read.rows.filter((row) => isListed(row, checkedAt));
    const asked = listed.length > 0 ? await processesFor(listed, checkedAt) : null;
    const open = asked === null || !asked.ok || asked.running;
    const sessions: Session[] = listed.map((row) => gooseSession({ row, open, now: checkedAt }));
    let detail = `Sessions are read from Goose's database, ${databaseName}, with sqlite3. ${alwaysNotes}`;
    let basis = BASIS;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether Goose runs, so no session is shown as finished."
        : " Agent Lookout cannot tell on this system whether Goose runs, so no session is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked?.ok && !asked.running) {
      detail += " No Goose program runs, so each session shows as finished.";
      basis = BASIS_CLOSED;
    }
    return { ...result("ok", detail, looked, checkedAt, basis), sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: GOOSE_CAPABILITIES,
    lookingIn: `Looking for Goose sessions in ${databaseName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Goose sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
