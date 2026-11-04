import os from "node:os";
import path from "node:path";

import { projectOf } from "../../../core/sessions/project.ts";
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
import type { RunSqlite } from "../antigravity/app/summaries.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { readTimeUntil } from "../hermes-agent/sqlite.ts";
import type { ProcessAnswer } from "../opencode/processes.ts";
import { every } from "../words.ts";
import {
  createDatabaseReader,
  RETRY_MS,
  type DatabaseRead,
  type DatabaseReader,
  type DatabaseState,
} from "./database.ts";
import {
  createCrushProcessReader,
  CRUSH_TABLE_ARGS,
  type CrushProcessReader,
} from "./processes.ts";
import {
  createListReader,
  DATA_FOLDER,
  DATABASE_FILE,
  databaseOf,
  MAX_LIST_BYTES,
  PROJECT_LIST_FILE,
  type ListRead,
} from "./projects.ts";
import type { SessionRow } from "./sessionRows.ts";
import { crushSession, isListed, projectPrefix, SOURCE_ID } from "./toSession.ts";

/** The variable that names Crush's data folder, for Agent Lookout alone. */
export const CRUSH_HOME_ENV = "AGENT_LOOKOUT_CRUSH_HOME";

/** Crush's own variable for its data folder. */
export const CRUSH_OWN_DATA_ENV = "CRUSH_GLOBAL_DATA";

/** Where Crush keeps its data, under the home folder, when nothing names another place. */
export const DEFAULT_DATA_HOME = [".local", "share"] as const;

/** How long a data folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether a Crush program runs, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no Crush
 * program runs, since Crush may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/**
 * How much of a poll the databases' reads may take. No run of `sqlite3` starts
 * once it is used, as for Hermes Agent's profiles. A project left for the next
 * poll, or cut short, keeps its last read, and the next poll starts with it.
 */
export const READ_BUDGET_MS = 5_000;

/** The usual way this adapter reads, named for the poller: the databases while a Crush program runs. */
export const BASIS = "database";

/**
 * The way it reads while `ps` says no Crush program runs, when every session is
 * finished. Closing Crush finishes every session at once, and opening it again
 * shows them all as unknown, so such a poll is named apart and compared only
 * with the last time Crush was closed.
 */
export const BASIS_CLOSED = "database-closed";

/**
 * The way it reads while `ps` cannot say whether Crush runs, when no session is
 * shown as finished. Named apart, so every finished session does not seem to
 * start again and then finish.
 */
export const BASIS_WITHOUT_PROCESSES = "database-without-processes";

const LABEL = "Crush";

/** Said whenever Crush is watched, because it is what a person would otherwise expect to see. */
export const STATUS_NOTE =
  "Nothing Agent Lookout reads says whether a Crush session is working or waiting for you, and nothing ties a session to a process, so a session shows as unknown while a Crush program runs and as finished once none does.";

/** Said whenever Crush is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Crush's source at v0.99.0 and not yet checked on a computer running Crush, so a status can be wrong.";

/** Said on Linux when no sqlite3 was found, which Ubuntu and Debian do not install. */
export const NO_SQLITE_ADVICE = "On Ubuntu or Debian, install it with sudo apt install sqlite3.";

/** Said when Crush's folder holds no list of projects, which a Crush older than v0.25.0 does not write. */
export const OLD_CRUSH_ADVICE = "If your Crush is older than v0.25.0, update it.";

/** Said on Windows, where nothing of Crush's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read Crush's sessions on Windows: they are read with sqlite3, which it does not run there.";

/**
 * What a Crush session can show, from the databases this adapter reads with
 * `sqlite3`. See docs/adapters/crush.md for each. Built from Crush's source at
 * v0.99.0 and not yet checked on a computer running it.
 *
 * - No Working and idle: nothing ties a session to a process, so a turn a crash
 *   cut off cannot be told from one under way.
 * - No Needs you: Crush holds a permission request in its memory.
 * - Finished is every session while `ps` shows no Crush program, on macOS and
 *   Linux. Crush writes no end to a session.
 * - No Failed: Crush writes how a turn ended inside a message, which is not read.
 * - The name is the folder's. Crush's title can be the first 50 characters of the
 *   first prompt, and no field says when it is, so it is never asked for.
 * - No Jump, Stop or Answer: the database names no process or terminal.
 * - No Quiet for: the page says how quiet a working session is, and a Crush
 *   session is never shown as working.
 * - No Tokens: a session's row holds counts, and they are not read.
 */
export const CRUSH_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "no",
    reason:
      "Nothing ties a Crush session to a process, so a turn a crash cut off looks like one under way.",
  },
  "needs-you": {
    level: "no",
    reason: "Crush holds a permission request in its memory, and writes nothing of it to disk.",
  },
  finished: {
    level: "partly",
    reason:
      "Every session at once, when ps shows no Crush program, on macOS and Linux. Crush writes no end to one.",
  },
  failed: {
    level: "no",
    reason: "Crush writes how a turn ended inside a message, which is not read.",
  },
  names: {
    level: "partly",
    reason: "The folder's. Crush's title can be the start of your first prompt.",
  },
  jump: { level: "no", reason: "Crush's database names no process or terminal." },
  "quiet-for": {
    level: "no",
    reason: "It is shown for a working session, and a Crush session never shows as working.",
  },
  tokens: { level: "no", reason: "Agent Lookout does not read the counts on a session's row." },
  stop: {
    level: "no",
    reason: "Crush's database names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason: "Agent Lookout makes no request to Crush, so it cannot send an answer.",
  },
};

/** The command, as Sources shows it: its questions are fixed text. */
export const COMMAND_SHOWN =
  'sqlite3 -init /dev/null -batch -json -cmd "PRAGMA trusted_schema=OFF" <database> <fixed query>';

/**
 * Crush's data folder, worked out as Crush does (`GlobalConfigData` in
 * `internal/config/load.go`), on macOS as on Linux: the one
 * `AGENT_LOOKOUT_CRUSH_HOME` names, else `CRUSH_GLOBAL_DATA` when that is an
 * absolute path, else `crush` in `XDG_DATA_HOME` when that is one, else
 * `~/.local/share/crush`. On Windows it is `%LOCALAPPDATA%\crush`, which is never
 * read.
 */
export function crushDataDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[CRUSH_HOME_ENV]?.trim() || undefined;
  if (override !== undefined) return path.resolve(override);
  const own = env[CRUSH_OWN_DATA_ENV];
  if (own && path.isAbsolute(own)) return path.resolve(own);
  const xdg = env.XDG_DATA_HOME;
  const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, ...DEFAULT_DATA_HOME);
  return path.resolve(data, "crush");
}

/** Everything the adapter touches outside itself. Tests replace these. */
export interface CrushAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system, which says whether `sqlite3` and `ps` are run. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** Runs `sqlite3` with the two questions. Defaults to the real one. */
  run?: RunSqlite;
  /** Which `sqlite3` to run. Defaults to the first at the fixed places. */
  find?: () => Promise<string | null>;
  /** What asks whether a Crush program runs. Defaults to one that runs `ps`. */
  processes?: CrushProcessReader;
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
  /** How much of a poll the reads may take. Defaults to 5 seconds. */
  readBudgetMs?: number;
}

/** A project that was not read on a poll, and why. */
interface NotRead {
  folder: string;
  state: Exclude<DatabaseState, "read" | "missing" | "out-of-time" | "not-on-windows">;
}

/** Why a project was not read, in a few words. */
function shortReason(state: NotRead["state"]): string {
  switch (state) {
    case "not-safe":
      return `a link or something other than an ordinary file is in place of the folder, its ${DATA_FOLDER} or a file of its database, or its -wal file holds something but has no -shm file beside it`;
    case "not-looked-at":
      return `its folder, its ${DATA_FOLDER} or a file of its database could not be looked at`;
    case "no-sqlite":
      return "no sqlite3 program was found";
    case "unsupported":
      return "its database is laid out in a way Agent Lookout does not read";
    case "failed":
      return `sqlite3 could not read its database, which is tried again when it changes, or ${RETRY_MS / 1000} seconds on`;
  }
}

/** A result with each project read this poll, so one not read leaves its sessions as they were. */
function withParts(answer: AdapterResult, parts: Record<string, string>): AdapterResult {
  if (Object.keys(parts).length > 0) answer.health.parts = parts;
  return answer;
}

/**
 * Finds Crush's sessions on this machine from the databases Crush keeps, with
 * nothing installed, no setting changed and no program of Crush's run.
 *
 * Crush keeps each project's sessions in one SQLite database, `.crush/crush.db`
 * in the project's folder, and the list of those folders in `projects.json` in
 * its data folder. Its own listing is its `crush` command, which opens a database
 * for writing and migrates it. So the adapter reads that list when it changes
 * (`projects.ts`), takes its newest 20 folders, looks at each one's database and
 * the two files SQLite keeps beside it with `lstat` on every poll, and asks the
 * system's `sqlite3` a fixed question when one of them changes (`database.ts`,
 * `sessionRows.ts`). While there are sessions to show, it asks `ps` whether a
 * Crush program runs, at most every 10 seconds, and sooner, though not within 2
 * seconds of the last ask, when a session is written after `ps` said none runs
 * (`processes.ts`). Nothing is read on Windows.
 *
 * Each session that is no other session's child and has a message is listed for
 * 24 hours after Crush last wrote it. Nothing Crush writes says whether a session
 * is open: it shows as unknown while a Crush program runs, or while `ps` cannot
 * say, and as finished once none does. It never shows as working or as needing
 * you. A crash leaves a session as a quit does, and it is finished like the others
 * once no Crush runs.
 *
 * Crush not being installed costs nothing: when its data folder is missing, the
 * adapter says so and looks again only once a minute, with a single `stat`, and
 * runs neither `sqlite3` nor `ps`.
 *
 * The data folder is `AGENT_LOOKOUT_CRUSH_HOME` if set, otherwise as Crush works
 * it out (`crushDataDirFor`). Someone who sets the variable means that folder: if
 * it holds no list, that is an answer, not a missing Crush.
 *
 * Never read: anything in Crush's data folder but `projects.json`, such as
 * `crush.json`, which can hold a key, and anything in a project's `.crush` but the
 * database and the two files beside it.
 *
 * Built from Crush's source at v0.99.0, and not yet checked on a computer running
 * Crush.
 */
export function createCrushAdapter(options: CrushAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const readBudgetMs = options.readBudgetMs ?? READ_BUDGET_MS;
  const processes = options.processes ?? createCrushProcessReader({ platform });

  const named = Boolean(env[CRUSH_HOME_ENV]?.trim());
  const home = crushDataDirFor(env, homeDir);
  const homeName = tildify(home, homeDir);
  const listName = tildify(path.join(home, PROJECT_LIST_FILE), homeDir);
  const databaseName = `<project>/${DATA_FOLDER}/${DATABASE_FILE}`;
  const listReader = createListReader({ dataFolder: home, io });

  /** Each project's reader, and its last read, by the project's folder. */
  const readers = new Map<string, DatabaseReader>();
  const lastReads = new Map<string, DatabaseRead>();

  /** When the data folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the data folder has been seen, until the list goes missing. */
  let homeSeen = false;
  /** How many projects the last poll took from the list, for Sources. */
  let projectsSeen = 0;
  /** The project the last poll's time for reading ran out at, which the next poll reads first. */
  let resumeAt: string | null = null;
  /** What `ps` last said, null before it was first asked, and when it was asked. */
  let lastProcesses: ProcessAnswer | null = null;
  let processesAt = 0;

  const psRuns = platform === "darwin" || platform === "linux";
  const commandRun = platform === "win32" ? "not run on Windows" : "when a database changes";
  const sooner =
    processCheckMs > PROMPT_PROCESS_CHECK_MS
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no Crush`
      : "";
  const processCheckRun = psRuns
    ? `${every(processCheckMs)} at most${sooner}`
    : `not run on ${platform === "win32" ? "Windows" : "this system"}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Data folder", value: homeName },
      { label: "Project list", value: listName },
      { label: "Projects", value: projectsSeen === 0 ? "none found" : String(projectsSeen) },
      { label: "Database", value: databaseName },
      { label: "Read", value: read },
      { label: "Command", value: COMMAND_SHOWN },
      { label: "Command run", value: commandRun },
      { label: "Process check", value: `ps ${CRUSH_TABLE_ARGS.join(" ")}` },
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
   * it said no Crush program runs, since Crush may have been started since.
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

  /** Crush is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    projectsSeen = 0;
    return result(
      "unavailable",
      `Crush was not found: there is no ${homeName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /**
   * Whether the data folder is there. Only a folder that is missing, or is not a
   * folder, counts as not there. This `stat` follows a link, and says only what
   * kind of thing is there: the list's `lstat` then refuses a link to a folder.
   */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  const alwaysNotes = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;

  /** The card when the list gave no folders: nothing else is read, and no reader is kept. */
  async function withoutList(
    state: Exclude<ListRead["state"], "read">,
    checkedAt: number,
  ): Promise<AdapterResult> {
    projectsSeen = 0;
    readers.clear();
    lastReads.clear();
    resumeAt = null;
    const looked = every(pollIntervalMs);
    switch (state) {
      case "missing":
        if (named) {
          return result(
            "ok",
            `${CRUSH_HOME_ENV} is set to ${homeName}, which has no ${PROJECT_LIST_FILE}, so no Crush sessions are listed. ${alwaysNotes}`,
            looked,
            checkedAt,
          );
        }
        // The data folder may have gone with its list.
        homeSeen = false;
        if (!(await homeIsThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        homeSeen = true;
        return result(
          "ok",
          `Crush has not saved a list of projects at ${listName} yet. ${alwaysNotes}`,
          looked,
          checkedAt,
          BASIS,
          OLD_CRUSH_ADVICE,
        );
      case "not-safe":
        return result(
          "error",
          `Crush's list of projects, ${listName}, was not read: a link or something other than an ordinary file is in its place, or in place of its folder.`,
          looked,
          checkedAt,
        );
      case "too-large":
        return result(
          "error",
          `Crush's list of projects, ${listName}, is over ${MAX_LIST_BYTES / 1024 / 1024} MiB, so it was not read and no Crush sessions are listed.`,
          looked,
          checkedAt,
        );
      case "unreadable":
        return result(
          "error",
          `Crush's list of projects, ${listName}, could not be read, or is not laid out as Crush lays it out, so no Crush sessions are listed.`,
          looked,
          checkedAt,
        );
    }
  }

  /** The reader of a project's database, made the first time it is read. */
  function readerOf(folder: string): DatabaseReader {
    let reader = readers.get(folder);
    if (reader === undefined) {
      reader = createDatabaseReader({
        file: databaseOf(folder),
        io,
        platform,
        run: options.run,
        find: options.find,
      });
      readers.set(folder, reader);
    }
    return reader;
  }

  /**
   * Each project's database, read in turn, each run of `sqlite3` within the poll's
   * time for reading. Once that is used, the rest, and one cut short, keep their
   * last read until the next poll, which starts with the first of them, so a slow
   * database cannot keep the others from ever being read.
   */
  async function readProjects(
    folders: readonly string[],
    checkedAt: number,
  ): Promise<{ reads: Map<string, DatabaseRead>; waiting: boolean }> {
    const time = readTimeUntil(checkedAt + readBudgetMs, now);
    const start = resumeAt === null ? -1 : folders.indexOf(resumeAt);
    const order = start > 0 ? [...folders.slice(start), ...folders.slice(0, start)] : folders;
    resumeAt = null;
    const reads = new Map<string, DatabaseRead>();
    /** Whether a project was not read for want of time, and has no last read either. */
    let waiting = false;
    const keep = (folder: string) => {
      resumeAt ??= folder;
      const kept = lastReads.get(folder);
      if (kept === undefined) waiting = true;
      else reads.set(folder, kept);
    };
    for (const folder of order) {
      if (!(time.left() > 0)) {
        keep(folder);
        continue;
      }
      const read = await readerOf(folder).read(checkedAt, time);
      if (read.state === "out-of-time") {
        keep(folder);
        continue;
      }
      lastReads.set(folder, read);
      reads.set(folder, read);
    }
    return { reads, waiting };
  }

  /**
   * The projects not read, by why, as one sentence. An MCP answer holds this, so
   * each is named as a session's row names it, by its folder's name alone.
   */
  function notReadSentence(failures: readonly NotRead[]): string {
    const states = [...new Set(failures.map(({ state }) => state))];
    const each = states.map((state) => {
      const folders = failures.filter((failure) => failure.state === state);
      const names = folders.map(({ folder }) => projectOf(folder)).join(", ");
      return `${names}, because ${shortReason(state)}`;
    });
    return `Not read: ${each.join("; ")}.`;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (platform === "win32") {
      return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
    }

    // A missing Crush is believed missing for a while, so a machine without it
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

    const list = await listReader.read();
    if (list.state !== "read") return withoutList(list.state, checkedAt);
    const { folders } = list;
    projectsSeen = folders.length;
    for (const folder of [...readers.keys()]) {
      if (!folders.includes(folder)) {
        readers.delete(folder);
        lastReads.delete(folder);
      }
    }

    const { reads, waiting } = await readProjects(folders, checkedAt);
    const answered: string[] = [];
    const failures: NotRead[] = [];
    const found: { folder: string; row: SessionRow }[] = [];
    let databases = 0;
    for (const folder of folders) {
      const answer = reads.get(folder);
      if (answer === undefined) continue;
      switch (answer.state) {
        case "missing":
          answered.push(folder);
          continue;
        case "out-of-time":
          // Never kept: a read cut short leaves the last one in its place.
          continue;
        case "not-on-windows":
          return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
        case "read":
          break;
        default:
          failures.push({ folder, state: answer.state });
          continue;
      }
      answered.push(folder);
      databases += 1;
      for (const row of answer.rows) {
        if (isListed(row, checkedAt)) found.push({ folder, row });
      }
    }

    const looked = every(pollIntervalMs);
    const advice =
      platform === "linux" && failures.some(({ state }) => state === "no-sqlite")
        ? NO_SQLITE_ADVICE
        : undefined;
    if (databases === 0 && failures.length > 0) {
      return result(
        "error",
        `No Crush project could be read. ${notReadSentence(failures)}`,
        looked,
        checkedAt,
        BASIS,
        advice,
      );
    }
    // A database not read yet for want of time may hold sessions, so this is not yet an answer.
    if (databases === 0 && waiting) {
      return result(
        "searching",
        `The databases of the projects in ${listName} are still being read.`,
        looked,
        checkedAt,
      );
    }

    // `ps` is asked only while there is a session to show.
    const rows = found.map(({ row }) => row);
    const asked = rows.length > 0 ? await processesFor(rows, checkedAt) : null;
    const open = asked === null || !asked.ok || asked.running;
    const sessions: Session[] = found.map(({ folder, row }) =>
      crushSession({ folder, row, open, now: checkedAt }),
    );
    let detail =
      databases === 0
        ? `No project in Crush's list, ${listName}, holds a database yet. ${alwaysNotes}`
        : `Sessions are read from the database in each project in Crush's list, ${listName}, with sqlite3. ${alwaysNotes}`;
    let basis = BASIS;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether Crush runs, so no session is shown as finished."
        : " Agent Lookout cannot tell on this system whether Crush runs, so no session is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked?.ok && !asked.running) {
      detail += " No Crush program runs, so each session shows as finished.";
      basis = BASIS_CLOSED;
    }
    if (failures.length > 0) detail += ` ${notReadSentence(failures)}`;
    const parts = Object.fromEntries(answered.map((folder) => [projectPrefix(folder), basis]));
    return {
      ...withParts(result("ok", detail, looked, checkedAt, basis, advice), parts),
      sessions,
    };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: CRUSH_CAPABILITIES,
    lookingIn: `Looking for Crush sessions in the projects ${listName} names.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Crush sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
