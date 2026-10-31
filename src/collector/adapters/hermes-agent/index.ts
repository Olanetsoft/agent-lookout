import os from "node:os";

import type {
  Session,
  SourceCapabilities,
  SourceFact,
  SourceHealth,
  SourceState,
} from "../../../core/sessions/session.ts";
import { tildify } from "../../files/paths.ts";
import { isMissing, nodeIo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isProcessAlive } from "../../processes/pids.ts";
import { POLL_INTERVAL_MS } from "../../poller.ts";
import type { RunSqlite, SqliteAnswer } from "../antigravity/app/summaries.ts";
import type { Adapter, AdapterResult } from "../adapter.ts";
import { every } from "../words.ts";
import {
  createDatabaseReader,
  RETRY_MS,
  type DatabaseRead,
  type DatabaseReader,
  type DatabaseState,
} from "./database.ts";
import {
  createProfileLister,
  DEFAULT_PROFILE,
  hermesRootFor,
  HERMES_HOME_ENV,
  profileDatabase,
  PROFILES_LIST_MS,
} from "./home.ts";
import {
  createPidNamespaceReader,
  leaseHolderAlive,
  type PidNamespace,
  type PidNamespaceReader,
} from "./processes.ts";
import { DATABASE_FILE, type HermesRow, type LeaseRow } from "./sessionRows.ts";
import {
  createSqliteFinder,
  readTimeUntil,
  versionText,
  type SqliteFinder,
  type SqlitePick,
  type SqliteVersion,
} from "./sqlite.ts";
import { chainsOf, hermesAgentSession, profilePrefix, SOURCE_ID } from "./toSession.ts";

export { HERMES_HOME_ENV, hermesRootFor } from "./home.ts";

/** How long a root folder that was not there is taken to be still missing before it is looked for again. */
export const RECHECK_MS = 60_000;

/**
 * How much of a poll the profiles' reads may take. No profile, and no run of
 * `sqlite3`, is started once it is used. The first run of a poll gets its
 * whole 5 seconds, so one that does not answer in them is known not to work,
 * and each later run gets at most what is left. So a poll's reads end within
 * it, or within one run's 5 seconds when the poll's first run starts late or
 * a run outlasts its timeout: well within the poller's own limit for an
 * answer. A profile left for the next poll, or cut short, keeps its last
 * read, and the next poll starts with it.
 */
export const READ_BUDGET_MS = 5_000;

/** The way this adapter reads, named for the poller, and for each profile it read, or found with no database, in `parts`. */
export const BASIS = "database";

const LABEL = "Hermes Agent";

/** Said whenever Hermes Agent is watched, because it is what a person would otherwise expect to see. */
export const LATE_NOTE =
  "Hermes Agent saves an approval wait at most once a minute, so it shows 10 to 70 seconds late, and a session whose Hermes Agent or gateway was killed stays idle.";

/** Said whenever Hermes Agent is watched, until the adapter has been checked on a computer running it. */
export const UNCHECKED_NOTE =
  "This was built from Hermes Agent v0.22.5's source and not yet checked on a computer running Hermes Agent, so a status can be wrong.";

/** Said when a conversation's newest row is one this adapter does not know. */
export const UNKNOWN_ROW_NOTE =
  "Some sessions end with a row Agent Lookout does not know, perhaps from a newer Hermes Agent, so they show as unknown.";

/** Said on Linux when no sqlite3 was found, which Ubuntu and Debian do not install. */
export const NO_SQLITE_ADVICE = "On Ubuntu or Debian, install it with sudo apt install sqlite3.";

/** Said on a Mac when every sqlite3 found has SQLite's WAL-reset bug. */
export const VULNERABLE_SQLITE_ADVICE_MAC =
  "Install SQLite 3.51.3 or newer with brew install sqlite, which Agent Lookout finds in /opt/homebrew/opt/sqlite or /usr/local/opt/sqlite.";

/** Said elsewhere when every sqlite3 found has SQLite's WAL-reset bug. */
export const VULNERABLE_SQLITE_ADVICE =
  "Put a sqlite3 of version 3.51.3 or newer, such as sqlite.org's precompiled tools, at /usr/local/bin/sqlite3.";

/** Said when a database is laid out as a version older than the adapter reads. */
export const UNSUPPORTED_ADVICE = "If your Hermes Agent is older than v0.21.6, update it.";

/** Said on Windows, where nothing of Hermes Agent's is read. */
export const WINDOWS_DETAIL =
  "Agent Lookout does not read Hermes Agent's sessions on Windows: they are read with sqlite3, which it does not run there.";

/**
 * What a Hermes Agent session can show, from the databases this adapter reads
 * with `sqlite3`. See docs/adapters/hermes-agent.md for each.
 *
 * - Working is a turn lease that has not run out and whose process exists,
 *   on macOS and Linux only.
 * - Needs you is a `clarify` question with no answer yet, or the label Hermes
 *   Agent saves at most once a minute while an approval waits.
 * - Finished is Hermes Agent's own end stamp: a session whose process was
 *   killed is never stamped.
 * - Failed is a turn Hermes Agent closed on an error. One that overflows the
 *   context writes no such row.
 * - The name is Hermes Agent's title, else the folder's name.
 * - No Jump, Stop or Answer: turns run in a gateway shared by every session,
 *   and approvals and questions are kept in its memory.
 * - No Quiet for: every session of a profile is in one file.
 * - No Tokens yet.
 */
export const HERMES_AGENT_CAPABILITIES: SourceCapabilities = {
  "working-and-idle": {
    level: "partly",
    reason:
      "Read from Hermes Agent's turn leases with sqlite3 on macOS and Linux. Nothing of Hermes Agent's is read on Windows.",
  },
  "needs-you": {
    level: "partly",
    reason:
      "From an open question, and from an approval label Hermes Agent saves at most once a minute, so that wait shows late.",
  },
  finished: {
    level: "partly",
    reason:
      "When Hermes Agent ends a session. One whose process was killed, or whose gateway stopped, shows as idle.",
  },
  failed: {
    level: "partly",
    reason:
      "When a turn ends on an error Hermes Agent records. One that overflows the model's context shows as idle.",
  },
  names: { level: "yes" },
  jump: {
    level: "no",
    reason:
      "Hermes Agent's database names no terminal or tab, and its turns run in a gateway shared by other sessions.",
  },
  "quiet-for": {
    level: "no",
    reason:
      "Hermes Agent keeps every session in one database, so no file shows when one session was last written.",
  },
  tokens: { level: "no", reason: "Agent Lookout does not read Hermes Agent's token counts yet." },
  stop: {
    level: "no",
    reason:
      "A Hermes Agent turn runs in a gateway process other sessions share, so no session can be stopped alone.",
  },
  answer: {
    level: "no",
    reason:
      "Hermes Agent keeps approvals and questions in its own memory, and Agent Lookout does not talk to its gateway.",
  },
};

/** The command, as Sources shows it: its two questions are fixed text, and a rollback-journal read waits a second. */
export const COMMAND_SHOWN =
  'sqlite3 -init /dev/null -batch -json [-cmd ".timeout 1000"] <database> <fixed query>';

/** Everything the adapter touches outside itself. Tests replace these. */
export interface HermesAgentAdapterOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  now?: () => number;
  io?: ReadOnlyIo;
  /** The system, which says whether `sqlite3` is run. Defaults to this one. */
  platform?: NodeJS.Platform;
  /** Runs `sqlite3` with the two questions. Defaults to the real one. */
  run?: RunSqlite;
  /** Which `sqlite3` to run. Defaults to one built from the three below. */
  finder?: SqliteFinder;
  /** Whether a place holds a program this user may run. */
  isExecutable?: (candidate: string) => Promise<boolean>;
  /** Runs `<candidate> -init /dev/null --version`, within this timeout. */
  runVersion?: (candidate: string, timeoutMs: number) => Promise<SqliteAnswer>;
  /** A program's identity and modified time, or null, so a changed one is asked its version again. */
  binaryIdentity?: (candidate: string) => Promise<string | null>;
  /** Whether a process exists. Defaults to signal 0. */
  isAlive?: (pid: number) => boolean;
  /** Agent Lookout's own pid namespace. Defaults to `/proc/self/ns/pid` on Linux. */
  pidNamespace?: PidNamespaceReader;
  /**
   * How often the poller calls `poll()`, which is how often the files are
   * looked at. The adapter keeps no timer of its own: this is only stated in
   * `watching`.
   */
  pollIntervalMs?: number;
  /** How long a missing root folder is believed missing before one more look. Defaults to a minute. */
  recheckMs?: number;
  /** How long after a read that did not work a database is read again. Defaults to 10 seconds. */
  retryMs?: number;
  /** How long the list of named profiles stands. Defaults to a minute. */
  profilesEveryMs?: number;
  /**
   * How much of a poll the reads may take: no profile is started, and no run
   * of `sqlite3`, once it is used, and each run but the poll's first gets at
   * most what is left. Defaults to 5 seconds.
   */
  readBudgetMs?: number;
}

/** Where the root folder was named. */
type RootFrom = "agent-lookout" | "default";

/** A profile that was not read on a poll, and why. */
interface NotRead {
  profile: string;
  state: Exclude<DatabaseState, "read" | "missing" | "out-of-time" | "not-on-windows">;
  vulnerable?: { path: string; version: SqliteVersion | null };
}

/** A version as a sentence says it. */
function versionWords(version: SqliteVersion | null): string {
  return version === null ? "a version it did not say" : `version ${versionText(version)}`;
}

/** The sqlite3 used for a live -wal, as Sources shows it. */
function walSqliteFact(picked: SqlitePick | null): string {
  if (picked === null) return "not needed yet";
  if (picked.kind === "none") return "none found";
  const version = picked.version === null ? "" : ` ${versionText(picked.version)}`;
  if (picked.kind === "found") return `${picked.path}${version}`;
  return `none trusted: ${picked.path}${version} fails Hermes Agent's WAL-reset test`;
}

/**
 * A result with the profiles read this poll, each named by the start of its
 * sessions' ids, so the poller compares each profile's sessions apart and the
 * sessions of a profile not read on one poll are not told as ended.
 */
function withParts(answer: AdapterResult, parts: Record<string, string>): AdapterResult {
  if (Object.keys(parts).length > 0) answer.health.parts = parts;
  return answer;
}

/** "the default profile", "the coder profile". */
function profileWords(profile: string): string {
  return `the ${profile} profile`;
}

/** Why a profile was not read, in a few words. */
function shortReason(failure: NotRead): string {
  switch (failure.state) {
    case "not-safe":
      return "its -wal file has no -shm file beside it, or one of them is not an ordinary file";
    case "no-sqlite":
      return "no sqlite3 program was found";
    case "vulnerable-sqlite":
      return "its -wal file holds something, and no sqlite3 found passes Hermes Agent's WAL-reset test";
    case "unsupported":
      return "it is laid out as a version of Hermes Agent that Agent Lookout does not read";
    case "failed":
      return "sqlite3 could not read it";
  }
}

/** Each profile not read, with why, as one sentence. */
function notReadSentence(failures: readonly NotRead[]): string {
  const each = failures.map(
    (failure) => `${profileWords(failure.profile)}, because ${shortReason(failure)}`,
  );
  return `Not read: ${each.join("; ")}.`;
}

/**
 * Finds Hermes Agent's sessions on this machine from the databases it keeps,
 * with nothing installed, no setting changed and no program of Hermes Agent's
 * run.
 *
 * Hermes Agent keeps each profile's sessions in one SQLite database,
 * `state.db`: the default profile's in its root folder, and each named
 * profile's in `profiles/<name>`. Its only listing is its own `hermes`
 * command, which runs Hermes Agent's code and can start its gateway. So the
 * adapter looks at each database and the two files SQLite keeps beside it
 * with `lstat` on every poll, reads a database's first 20 bytes when it
 * changed, to tell its journal mode, and asks the system's `sqlite3` two fixed
 * questions when it or its `-wal` changed (`database.ts`, `sessionRows.ts`).
 * While a turn runs, it checks the turn's process with signal 0
 * (`processes.ts`). Nothing is read on Windows.
 *
 * Each conversation that is not a subagent's run, archived, hidden, or of
 * the sources Hermes Agent hides from people is listed for 24 hours after
 * anything of it was last written. Its status is needs you, working, idle,
 * failed, finished or unknown, judged again on every poll, so a turn whose
 * lease runs out stops showing as working though no file changed.
 *
 * Hermes Agent not being installed costs nothing: when its root folder is
 * missing, the adapter says so and looks again only once a minute, with a
 * single `stat`, and runs no `sqlite3`.
 *
 * The root is `AGENT_LOOKOUT_HERMES_HOME` if set, otherwise as Hermes Agent's
 * own `HERMES_HOME` gives it, or `~/.hermes`. Someone who sets the variable
 * means that folder: if it holds no database, that is an answer, not a
 * missing Hermes Agent.
 *
 * Never read: `runtime/active_sessions.json`, or any other file of Hermes
 * Agent's but the three database files of each profile, and a
 * `state.db-journal` an unfinished change left, which `sqlite3` opens as part
 * of the database.
 *
 * This was built from Hermes Agent's source at v0.22.5, and has not yet been
 * checked on a computer running Hermes Agent.
 */
export function createHermesAgentAdapter(options: HermesAgentAdapterOptions = {}): Adapter {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const now = options.now ?? Date.now;
  const io = options.io ?? nodeIo;
  const platform = options.platform ?? process.platform;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const recheckMs = options.recheckMs ?? RECHECK_MS;
  const retryMs = options.retryMs ?? RETRY_MS;
  const readBudgetMs = options.readBudgetMs ?? READ_BUDGET_MS;
  const isAlive = options.isAlive ?? isProcessAlive;
  const pidNamespace = options.pidNamespace ?? createPidNamespaceReader({ platform });
  const finder =
    options.finder ??
    createSqliteFinder({
      isExecutable: options.isExecutable,
      runVersion: options.runVersion,
      identity: options.binaryIdentity,
    });

  const rootFrom: RootFrom = env[HERMES_HOME_ENV]?.trim() ? "agent-lookout" : "default";
  const root = hermesRootFor(env, homeDir);
  const rootName = tildify(root, homeDir);
  const lister = createProfileLister({
    io,
    root,
    everyMs: options.profilesEveryMs ?? PROFILES_LIST_MS,
  });
  const databaseName = (profile: string) => tildify(profileDatabase(root, profile), homeDir);

  /** Each profile's reader, and its last read, by the profile's name. */
  const readers = new Map<string, DatabaseReader>();
  const lastReads = new Map<string, DatabaseRead>();

  /** When the root folder was last found missing. Null while it is there, or before the first look. */
  let absentAt: number | null = null;
  /** True once the root folder has been seen, until every database goes missing. */
  let rootSeen = false;
  /** The profiles of the last poll that saw the root, for Sources. */
  let profilesSeen: readonly string[] = [];
  /**
   * The profile the last poll's time for reading ran out at, cut short or not
   * reached, which the next poll reads first. Null when every one was reached.
   */
  let resumeAt: string | null = null;

  const commandRun = platform === "win32" ? "not run on Windows" : "when a database changes";
  const processCheck =
    platform === "win32"
      ? "not run on Windows"
      : `signal 0 to a running turn's process, ${every(pollIntervalMs)}`;

  function watching(read: string): SourceFact[] {
    return [
      { label: "Hermes folder", value: rootName },
      {
        label: "Profiles",
        value: profilesSeen.length === 0 ? "none found" : profilesSeen.join(", "),
      },
      { label: "Read", value: read },
      { label: "Command", value: COMMAND_SHOWN },
      { label: "Command run", value: commandRun },
      { label: "sqlite3 for a live -wal", value: walSqliteFact(finder.lastWalSafe()) },
      { label: "Process check", value: processCheck },
    ];
  }

  function result(
    state: SourceState,
    detail: string,
    read: string,
    checkedAt: number,
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
    return state === "ok" ? { health, sessions: [], basis: BASIS } : { health, sessions: [] };
  }

  /** Hermes Agent is not on this machine. Said calmly, with no advice. */
  function notFound(checkedAt: number): AdapterResult {
    profilesSeen = [];
    lister.forget();
    return result(
      "unavailable",
      `Hermes Agent was not found: there is no ${rootName} folder. Agent Lookout looks again ${every(recheckMs)}.`,
      "not found",
      checkedAt,
    );
  }

  /** Whether the root folder is there. Only a folder that is missing, or is not a folder, counts as not there. */
  async function rootIsThere(): Promise<boolean> {
    try {
      return (await io.stat(root)).kind === "directory";
    } catch (error) {
      return !isMissing(error);
    }
  }

  /** The advice for a profile that was not read, if there is any. */
  function adviceFor(failure: NotRead): string | undefined {
    if (failure.state === "no-sqlite") return platform === "linux" ? NO_SQLITE_ADVICE : undefined;
    if (failure.state === "vulnerable-sqlite") {
      return platform === "darwin" ? VULNERABLE_SQLITE_ADVICE_MAC : VULNERABLE_SQLITE_ADVICE;
    }
    if (failure.state === "unsupported") return UNSUPPORTED_ADVICE;
    return undefined;
  }

  /** The whole card's detail when the one profile with a database could not be read. */
  function failureDetail(failure: NotRead): string {
    const database = databaseName(failure.profile);
    switch (failure.state) {
      case "not-safe":
        return `Hermes Agent's database, ${database}, was not read: its -wal file holds something but has no -shm file beside it, or one of them is not an ordinary file, so it cannot be read without writing to it.`;
      case "no-sqlite":
        return `No sqlite3 program was found to read Hermes Agent's database, ${database}, so no Hermes Agent sessions are listed.`;
      case "vulnerable-sqlite": {
        const found = failure.vulnerable;
        const which =
          found === undefined ? "" : ` ${found.path} is ${versionWords(found.version)}.`;
        return `Hermes Agent's database, ${database}, was not read: its -wal file holds something, and no sqlite3 found passes Hermes Agent's test for SQLite's WAL-reset bug.${which} Hermes Agent refuses such a sqlite3 on a live database, since it can lose what was saved.`;
      }
      case "unsupported":
        return `Hermes Agent's database, ${database}, is laid out as a version of Hermes Agent that Agent Lookout does not read. It reads those of Hermes Agent v0.21.6 and later.`;
      case "failed":
        return `sqlite3 could not read Hermes Agent's database, ${database}, so no Hermes Agent sessions are listed. Agent Lookout tries again when it changes, or ${retryMs / 1000} seconds on.`;
    }
  }

  /**
   * Agent Lookout's own pid namespace, read only when some lease of a
   * profile is live, since only a live lease's process is checked.
   */
  async function namespaceFor(
    rows: readonly HermesRow[],
    at: number,
  ): Promise<PidNamespace | null> {
    const live = rows.some(
      (row) => row.lease !== null && typeof row.lease.until === "number" && row.lease.until > at,
    );
    return live ? pidNamespace.read() : null;
  }

  async function poll(): Promise<AdapterResult> {
    const checkedAt = now();
    if (platform === "win32") {
      return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
    }

    // A missing Hermes Agent is believed missing for a while, so a machine
    // without it pays nothing on most polls. A clock set back counts as time
    // enough.
    if (rootFrom !== "agent-lookout") {
      if (absentAt !== null) {
        const since = checkedAt - absentAt;
        if (since >= 0 && since < recheckMs) return notFound(checkedAt);
      }
      if (!rootSeen) {
        if (!(await rootIsThere())) {
          absentAt = checkedAt;
          return notFound(checkedAt);
        }
        absentAt = null;
        rootSeen = true;
      }
    }

    const profiles = [DEFAULT_PROFILE, ...(await lister.list(checkedAt))];
    profilesSeen = profiles;
    for (const profile of [...readers.keys()]) {
      if (!profiles.includes(profile)) {
        readers.delete(profile);
        lastReads.delete(profile);
      }
    }

    // Each profile is read in turn, and each run of sqlite3 within the reads'
    // share of the poll. Once that is used, the rest, and one cut short, keep
    // their last read until the next poll, which starts with the first of
    // them, so one slow profile cannot keep the others from ever being read.
    const time = readTimeUntil(checkedAt + readBudgetMs, now);
    const start = resumeAt === null ? -1 : profiles.indexOf(resumeAt);
    const order = start > 0 ? [...profiles.slice(start), ...profiles.slice(0, start)] : profiles;
    resumeAt = null;
    const reads = new Map<string, DatabaseRead>();
    /** Profiles not read this poll for want of time that have no last read either. */
    const unread: string[] = [];
    const keep = (profile: string) => {
      resumeAt ??= profile;
      const kept = lastReads.get(profile);
      if (kept === undefined) unread.push(profile);
      else reads.set(profile, kept);
    };
    for (const profile of order) {
      if (!(time.left() > 0)) {
        keep(profile);
        continue;
      }
      let reader = readers.get(profile);
      if (reader === undefined) {
        reader = createDatabaseReader({
          file: profileDatabase(root, profile),
          io,
          platform,
          finder,
          run: options.run,
          retryMs,
        });
        readers.set(profile, reader);
      }
      const read = await reader.read(checkedAt, time);
      if (read.state === "out-of-time") {
        keep(profile);
        continue;
      }
      lastReads.set(profile, read);
      reads.set(profile, read);
    }

    const sessions: Session[] = [];
    const parts: Record<string, string> = {};
    const failures: NotRead[] = [];
    let read = 0;
    let unknown = false;
    for (const profile of profiles) {
      const answer = reads.get(profile);
      if (answer === undefined) continue;
      switch (answer.state) {
        case "missing":
          parts[profilePrefix(profile)] = BASIS;
          continue;
        case "out-of-time":
          // Never kept: a read cut short leaves the last one in its place.
          continue;
        case "not-on-windows":
          return result("unavailable", WINDOWS_DETAIL, "not on Windows", checkedAt);
        case "read":
          break;
        default: {
          const failure: NotRead = { profile, state: answer.state };
          if (answer.vulnerable !== undefined) failure.vulnerable = answer.vulnerable;
          failures.push(failure);
          continue;
        }
      }
      read += 1;
      parts[profilePrefix(profile)] = BASIS;
      const namespace = await namespaceFor(answer.rows, checkedAt);
      const holderAlive = (lease: LeaseRow) =>
        namespace !== null && typeof lease.until === "number" && lease.until > checkedAt
          ? leaseHolderAlive(lease, namespace, isAlive)
          : null;
      for (const chain of chainsOf(answer.rows).values()) {
        const session = hermesAgentSession({ profile, chain, holderAlive, now: checkedAt });
        if (session === null) continue;
        if (session.status === "unknown") unknown = true;
        sessions.push(session);
      }
    }

    const looked = every(pollIntervalMs);
    const notes = `${LATE_NOTE} ${UNCHECKED_NOTE}`;
    const advice = failures.map(adviceFor).find((text) => text !== undefined);

    if (read === 0 && failures.length === 0) {
      // A database not read yet for want of time may hold sessions, so this is
      // not yet an answer.
      if (unread.length > 0) {
        return result(
          "searching",
          `Hermes Agent's databases in ${rootName} are still being read.`,
          looked,
          checkedAt,
        );
      }
      if (rootFrom === "agent-lookout") {
        return withParts(
          result(
            "ok",
            `${HERMES_HOME_ENV} is set to ${rootName}, which has no ${DATABASE_FILE} in it or in a profile, so no Hermes Agent sessions are listed. ${notes}`,
            looked,
            checkedAt,
          ),
          parts,
        );
      }
      // The root may have gone with its databases.
      rootSeen = false;
      if (!(await rootIsThere())) {
        absentAt = checkedAt;
        return notFound(checkedAt);
      }
      rootSeen = true;
      return withParts(
        result(
          "ok",
          `Hermes Agent has not saved a database in ${rootName} yet. ${notes}`,
          looked,
          checkedAt,
        ),
        parts,
      );
    }

    if (read === 0) {
      const detail =
        failures.length === 1
          ? failureDetail(failures[0] as NotRead)
          : `No Hermes Agent profile in ${rootName} could be read. ${notReadSentence(failures)}`;
      return result("error", detail, looked, checkedAt, advice);
    }

    let detail = `Sessions are read from Hermes Agent's databases in ${rootName}, with sqlite3. ${notes}`;
    if (failures.length > 0) detail += ` ${notReadSentence(failures)}`;
    if (unknown) detail += ` ${UNKNOWN_ROW_NOTE}`;
    return { ...withParts(result("ok", detail, looked, checkedAt, advice), parts), sessions };
  }

  return {
    id: SOURCE_ID,
    label: LABEL,
    capabilities: HERMES_AGENT_CAPABILITIES,
    lookingIn: `Looking for Hermes Agent sessions in ${rootName}.`,
    async poll() {
      try {
        return await poll();
      } catch {
        // Nothing above is expected to throw. If it does, the poller still gets an
        // answer, and the person sees a sentence, not a stack trace.
        return result(
          "error",
          "Something unexpected went wrong while reading Hermes Agent sessions.",
          every(pollIntervalMs),
          now(),
        );
      }
    },
  };
}
