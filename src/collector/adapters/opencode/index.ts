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
import { every } from "../words.ts";
import { createDatabaseReader, type DatabaseReader } from "./database.ts";
import {
  createOpencodeProcessReader,
  OPENCODE_TABLE_ARGS,
  opencodeLiveness,
  type OpencodeProcessReader,
  type ProcessAnswer,
} from "./processes.ts";
import { DATABASE_FILE, type SessionRow } from "./sessionRows.ts";
import { isListed, lastActivity, opencodeSession, SOURCE_ID } from "./toSession.ts";

/** The variable that replaces OpenCode's data folder, for Agent Lookout alone. */
export const OPENCODE_HOME_ENV = "AGENT_LOOKOUT_OPENCODE_HOME";

/** OpenCode's own variable for its database: a path, one in its data folder, or `:memory:`. */
export const OPENCODE_DB_ENV = "OPENCODE_DB";

/** Where OpenCode keeps its data, under the home folder, when `XDG_DATA_HOME` names no other place. */
export const DEFAULT_DATA_HOME = [".local", "share"] as const;

/**
 * OpenCode's data folder: the one `AGENT_LOOKOUT_OPENCODE_HOME` names, else
 * `opencode` in `XDG_DATA_HOME` when that is an absolute path, else
 * `~/.local/share/opencode`, on macOS as on Linux.
 */
export function opencodeHomeFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[OPENCODE_HOME_ENV]?.trim() || undefined;
  if (override !== undefined) return path.resolve(override);
  const xdg = env.XDG_DATA_HOME;
  const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, ...DEFAULT_DATA_HOME);
  return path.resolve(data, "opencode");
}

/**
 * The database the adapter reads, or null when OpenCode keeps its sessions in
 * memory. With `AGENT_LOOKOUT_OPENCODE_HOME`, `opencode.db` in that folder.
 * Otherwise OpenCode's own `OPENCODE_DB`, as OpenCode takes it: `:memory:`, an
 * absolute path as it is, or a path in the data folder. Without it,
 * `opencode.db` in the data folder.
 */
export function opencodeDatabaseFor(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const home = opencodeHomeFor(env, homeDir);
  if (env[OPENCODE_HOME_ENV]?.trim()) return path.join(home, DATABASE_FILE);
  const own = env[OPENCODE_DB_ENV];
  if (!own) return path.join(home, DATABASE_FILE);
  if (own === ":memory:") return null;
  return path.isAbsolute(own) ? own : path.join(home, own);
}

/** How long a data folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/** How often, at most, `ps` is asked whether an OpenCode program runs, while there are sessions to show. */
export const PROCESS_CHECK_MS = 10_000;

/**
 * How soon `ps` is asked again when a session is written after it said no
 * OpenCode program runs, since OpenCode may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** The usual way this adapter reads, named for the poller: the database while an OpenCode program runs. */
export const BASIS = "database";

/**
 * The way it reads while `ps` says no OpenCode program runs, when every
 * session is finished. Closing OpenCode finishes every session at once, and
 * opening it again shows them all as open, so such a poll is named apart and
 * compared only with the last time OpenCode was closed.
 */
export const BASIS_CLOSED = "database-closed";

/**
 * The way it reads while `ps` cannot say whether OpenCode runs, when no
 * session is shown as finished, so one that had finished shows as idle. Named
 * apart, so every finished session does not seem to start again and then
 * finish.
 */
export const BASIS_WITHOUT_PROCESSES = "database-without-processes";

const LABEL = "OpenCode";

/** Said whenever OpenCode is watched, because it is what a person would otherwise expect to see. */
export const NEEDS_YOU_NOTE =
  "OpenCode does not record when it waits for your approval or an answer, so a session waiting for you shows as working.";

/** Said whenever OpenCode is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from OpenCode 1.19.0's source and not yet checked on a computer running OpenCode, so a status can be wrong.";

/** Said when the database holds OpenCode 2's table, whose sessions are not read yet. */
export const OPENCODE_2_NOTE = "OpenCode 2's sessions are not read yet.";

/** Said when a session's newest message is one this adapter does not know. */
export const UNKNOWN_MESSAGE_NOTE =
  "Some sessions end with a message Agent Lookout does not know, perhaps from a newer OpenCode, so they show as unknown.";

/** Said on Linux when no sqlite3 was found, which Ubuntu and Debian do not install. */
export const NO_SQLITE_ADVICE = "On Ubuntu or Debian, install it with sudo apt install sqlite3.";

/** Said on Windows, where nothing of OpenCode's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read OpenCode's sessions on Windows: they are read with sqlite3, which it does not run there.";

/**
 * What an OpenCode session can show, from the database this adapter reads
 * with `sqlite3`. See docs/adapters/opencode.md for each.
 *
 * - Working and idle are the newest message of each root session
 *   (`opencodeMapping.ts`), on macOS and Linux only.
 * - Needs you never: OpenCode keeps its approval waits and questions in memory.
 * - Finished is every session while `ps` shows no program named `opencode`
 *   (`processes.ts`), on macOS and Linux.
 * - Failed is a reply that ends on an error OpenCode records.
 * - The name is OpenCode's title, or the folder's name while the title is a
 *   placeholder.
 * - No Jump, Stop or Answer: the database names no process or terminal.
 * - No Quiet for: every session is in one file, so no file's modified time
 *   says when one was last written.
 * - No Tokens yet.
 */
export const OPENCODE_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Read with sqlite3 on macOS and Linux. Agent Lookout reads nothing of OpenCode's on Windows.",
  },
  "needs-you": {
    level: "no",
    reason:
      "OpenCode keeps approval waits and questions in memory, so a session waiting for you shows as working.",
  },
  finished: {
    level: "partly",
    reason:
      "Once ps shows no program named opencode, on macOS and Linux. While only the desktop app runs, its sessions show as finished.",
  },
  failed: {
    level: "partly",
    reason:
      "When a reply ends on an error OpenCode records. One that fails before a reply begins shows as working.",
  },
  names: { level: "yes" },
  jump: {
    level: "no",
    reason:
      "OpenCode's database names no process or terminal, and OpenCode documents no link to a session.",
  },
  "quiet-for": {
    level: "no",
    reason:
      "OpenCode keeps every session in one database, so no file shows when one session was last written.",
  },
  tokens: { level: "no", reason: "Agent Lookout does not read OpenCode's token counts yet." },
  stop: {
    level: "no",
    reason: "OpenCode's database names no process that Agent Lookout could confirm and stop.",
  },
  answer: {
    level: "no",
    reason:
      "OpenCode keeps its approvals and questions in memory, so there is nothing to answer from here.",
  },
};

/** The command, as Sources shows it: its two questions are fixed text. */
export const COMMAND_SHOWN = "sqlite3 -init /dev/null -batch -json <database> <fixed query>";

/** Everything the adapter touches outside itself. Tests replace these. */
export interface OpencodeAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system, which says whether `sqlite3` is run. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** What reads the database. Defaults to one that runs `sqlite3`. */
  reader?: DatabaseReader;
  /** What asks whether an OpenCode program runs. Defaults to one that runs `ps`. */
  processes?: OpencodeProcessReader;
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

/** Where the data folder was named. */
type HomeFrom = "agent-lookout" | "default";

/**
 * Finds OpenCode's sessions on this machine from the database OpenCode keeps,
 * with nothing installed, no setting changed and no program of OpenCode's run.
 *
 * OpenCode 1.x keeps every session, message and part in one SQLite database,
 * `opencode.db` in its data folder, and documents no listing a reader outside
 * it can use without starting OpenCode, which writes to that folder. So the
 * adapter looks at the database and the two files SQLite keeps beside it with
 * `lstat` on every poll, and asks the system's `sqlite3` two fixed questions
 * when the database or its `-wal` changes (`database.ts`, `sessionRows.ts`).
 * While there are sessions to show, it asks `ps` whether an OpenCode program
 * runs, at most every 10 seconds, and sooner, though not within 2 seconds of
 * the last ask, when a session is written after `ps` said none runs
 * (`processes.ts`). Nothing is read on Windows.
 *
 * Each root session that is not archived is listed for 24 hours after
 * anything of it was last written. Its status is working, idle, failed,
 * finished or unknown, never "needs-you": OpenCode keeps its approval waits
 * and its questions in memory.
 *
 * OpenCode not being installed costs nothing: when its data folder is
 * missing, the adapter says so and looks again only once a minute, with a
 * single `stat`, and runs neither `sqlite3` nor `ps`.
 *
 * The data folder is `AGENT_LOOKOUT_OPENCODE_HOME` if set, otherwise
 * `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`. Someone who sets the
 * variable means that folder: if it holds no database, that is an answer, not
 * a missing OpenCode.
 *
 * This was built from OpenCode's source at v1.19.0, and has not yet been
 * checked on a computer running OpenCode.
 */
export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const processCheckMs = options.processCheckMs ?? PROCESS_CHECK_MS;
  const processes = options.processes ?? createOpencodeProcessReader({ platform });

  const homeFrom: HomeFrom = env[OPENCODE_HOME_ENV]?.trim() ? "agent-lookout" : "default";
  const home = opencodeHomeFor(env, homeDir);
  const database = opencodeDatabaseFor(env, homeDir);
  const homeName = tildify(home, homeDir);
  const databaseName = database === null ? ":memory:" : tildify(database, homeDir);
  const reader =
    options.reader ??
    (database === null ? null : createDatabaseReader({ file: database, io, platform }));

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
      ? `, ${every(PROMPT_PROCESS_CHECK_MS)} at most while sessions are written and ps shows no OpenCode`
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
      { label: "Process check", value: `ps ${OPENCODE_TABLE_ARGS.join(" ")}` },
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
   * though not within 2 seconds of the last ask, when a session was written
   * after it said no OpenCode program runs, since OpenCode may have been
   * started since. Until it is asked again, such a session is not held open,
   * so one a program `ps` does not see writes stays finished. A clock set
   * back counts as time enough.
   */
  async function processesFor(
    listed: readonly SessionRow[],
    checkedAt: number,
  ): Promise<ProcessAnswer> {
    const since = checkedAt - processesAt;
    let due = lastProcesses === null || since < 0 || since >= processCheckMs;
    if (!due && since >= PROMPT_PROCESS_CHECK_MS && lastProcesses?.ok && !lastProcesses.running) {
      due = listed.some((row) => (lastActivity(row, checkedAt) ?? -Infinity) > processesAt);
    }
    if (lastProcesses === null || due) {
      lastProcesses = await processes.read();
      processesAt = checkedAt;
    }
    return lastProcesses;
  }

  /** OpenCode is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    return result(
      "unavailable",
      `OpenCode was not found: there is no ${homeName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** Whether the data folder is there. Only a folder that is missing, or is not a folder, counts as not there. */
  async function homeIsThere(): Promise<boolean> {
    try {
      return (await io.stat(home)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  const alwaysNotes = `${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (platform === "win32") {
      return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
    }

    // A missing OpenCode is believed missing for a while, so a machine without
    // it pays nothing on most polls. A clock set back counts as time enough.
    if (homeFrom !== "agent-lookout") {
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

    if (reader === null) {
      return result(
        "ok",
        `${OPENCODE_DB_ENV} is set to :memory:, so OpenCode keeps its sessions in memory, where Agent Lookout cannot read them. ${alwaysNotes}`,
        "in memory, not read",
        checkedAt,
      );
    }

    const read = await reader.read(checkedAt);
    const looked = every(pollIntervalMs);
    switch (read.state) {
      case "not-on-windows":
        return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
      case "missing": {
        if (homeFrom === "agent-lookout") {
          return result(
            "ok",
            `${OPENCODE_HOME_ENV} is set to ${homeName}, which has no ${DATABASE_FILE}, so no OpenCode sessions are listed. ${alwaysNotes}`,
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
          `OpenCode has not saved a database at ${databaseName} yet. ${alwaysNotes}`,
          looked,
          checkedAt,
        );
      }
      case "not-safe":
        return result(
          "error",
          `OpenCode's database, ${databaseName}, was not read: its -wal file holds something but has no -shm file beside it, or one of them is not an ordinary file, so it cannot be read without writing to it.`,
          looked,
          checkedAt,
        );
      case "no-sqlite":
        return result(
          "error",
          `No sqlite3 program was found to read OpenCode's database, ${databaseName}, so no OpenCode sessions are listed.`,
          looked,
          checkedAt,
          BASIS,
          platform === "linux" ? NO_SQLITE_ADVICE : undefined,
        );
      case "failed":
        return result(
          "error",
          `sqlite3 could not read OpenCode's database, ${databaseName}, so no OpenCode sessions are listed.`,
          looked,
          checkedAt,
        );
      case "unsupported":
        return result(
          "error",
          `OpenCode's database, ${databaseName}, is laid out as a version of OpenCode that Agent Lookout does not read.`,
          looked,
          checkedAt,
        );
      case "read":
        break;
    }

    // `ps` is asked only while there is a session to show.
    const listed: SessionRow[] = read.rows.filter((row) => isListed(row, checkedAt));
    const asked = listed.length > 0 ? await processesFor(listed, checkedAt) : null;
    const open = asked === null || opencodeLiveness(asked) !== false;
    const sessions: Session[] = [];
    let unknown = false;
    for (const row of listed) {
      const session = opencodeSession({ row, open, now: checkedAt });
      if (session === null) continue;
      if (session.status === "unknown") unknown = true;
      sessions.push(session);
    }
    let detail = `Sessions are read from OpenCode's database, ${databaseName}, with sqlite3. ${alwaysNotes}`;
    let basis = BASIS;
    if (asked !== null && !asked.ok) {
      detail += psRuns
        ? " ps could not be run to tell whether OpenCode runs, so no session is shown as finished."
        : " Agent Lookout cannot tell on this system whether OpenCode runs, so no session is shown as finished.";
      basis = BASIS_WITHOUT_PROCESSES;
    } else if (asked?.ok && !asked.running) {
      detail +=
        " No OpenCode program runs, so each session shows as finished, unless it failed or cannot be read.";
      basis = BASIS_CLOSED;
    }
    if (read.opencode2) detail += ` ${OPENCODE_2_NOTE}`;
    if (unknown) detail += ` ${UNKNOWN_MESSAGE_NOTE}`;
    const answer = result("ok", detail, looked, checkedAt, basis);
    return { ...answer, sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: OPENCODE_CAPABILITIES,
    lookingIn: `Looking for OpenCode sessions in ${databaseName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading OpenCode sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
