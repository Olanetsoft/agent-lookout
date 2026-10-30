// The Hermes Agent adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, a
// stand-in for `sqlite3` that answers the probe and the sessions query of
// each profile's database with what the test gives it, says what version
// each program at the fixed places is, and keeps every argument list it was
// given, a stand-in for signal 0, a stand-in for Agent Lookout's own pid
// namespace, and an adapter built from them with a clock the test moves by
// hand. Nothing here touches a real file, runs a program or asks after a
// real process.

import type { SqliteAnswer } from "@collector/adapters/antigravity/app/summaries";
import {
  createHermesAgentAdapter,
  type HermesAgentAdapterOptions,
} from "@collector/adapters/hermes-agent/index";
import type { PidNamespace, PidNamespaceReader } from "@collector/adapters/hermes-agent/processes";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/hermes-agent/sessionRows";
import { createSqliteFinder } from "@collector/adapters/hermes-agent/sqlite";
import {
  databaseHeader,
  GATEWAY_PID,
  HOME,
  NOW,
  PID_NAMESPACE,
  probeJson,
  sqliteJson,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";
import { asWritten } from "@tests/support/paths";

export { handClock, memoryFiles, type MemoryFiles };

/** What `sqlite3 --version` prints for a version. */
export const versionLine = (version: string) =>
  `${version} 2026-01-01 00:00:00 0000000000000000000000000000000000000000000000000000000000000000 (64-bit)\n`;

/** The database a run of `sqlite3` was given, from its address `file:<path>?…`, as the tests write it. */
export function databaseOf(args: readonly string[]): string {
  const address = args.find((arg) => arg.startsWith("file:")) ?? "";
  const end = address.indexOf("?");
  const encoded = address.slice("file:".length, end === -1 ? undefined : end);
  return asWritten(encoded.split("/").map(decodeURIComponent).join("/"));
}

/** A program at one of the fixed places: what it says of its version, or null when it says nothing, and its identity. */
interface Program {
  version: string | null;
  identity: string | null;
}

/**
 * A stand-in for `sqlite3`: the rows the sessions query prints for each
 * database, by its path, which the test changes, what the probe prints, the
 * programs at the fixed places with their versions, every run with its
 * arguments, every `--version` asked, and ways to make a run fail or throw.
 * Unless the test says otherwise, `/usr/bin/sqlite3` is there, at 3.53.0,
 * which passes Hermes Agent's WAL-reset test.
 */
export function standInSqlite(
  initial: Record<string, Record<string, unknown>[] | string> = {},
  options: { onRun?: (database: string, query: string) => void } = {},
) {
  const answers = new Map<string, Record<string, unknown>[] | string>(Object.entries(initial));
  const probes = new Map<string, string>();
  let probe = probeJson();
  const failing = new Set<string>();
  let failAll = false;
  let throwing = false;
  const programs = new Map<string, Program>([
    ["/usr/bin/sqlite3", { version: "3.53.0", identity: "usr-bin-1" }],
  ]);
  const runs: { binary: string; args: readonly string[]; database: string }[] = [];
  const versionRuns: string[] = [];
  let nextIdentity = 1;

  async function run(binary: string, args: readonly string[]): Promise<SqliteAnswer> {
    const database = databaseOf(args);
    runs.push({ binary, args, database });
    options.onRun?.(database, args.at(-1) ?? "");
    if (throwing) throw new Error("A stand-in that throws.");
    if (failAll || failing.has(database)) return { ok: false };
    if (args.at(-1) === PROBE_QUERY) return { ok: true, stdout: probes.get(database) ?? probe };
    if (args.at(-1) === SESSIONS_QUERY) {
      const rows = answers.get(database) ?? [];
      return { ok: true, stdout: typeof rows === "string" ? rows : sqliteJson(rows) };
    }
    return { ok: false };
  }
  async function isExecutable(candidate: string): Promise<boolean> {
    return programs.has(candidate);
  }
  async function runVersion(candidate: string): Promise<SqliteAnswer> {
    versionRuns.push(candidate);
    const program = programs.get(candidate);
    if (program === undefined || program.version === null) return { ok: false };
    return { ok: true, stdout: versionLine(program.version) };
  }
  async function identity(candidate: string): Promise<string | null> {
    return programs.get(candidate)?.identity ?? null;
  }

  return {
    run,
    isExecutable,
    runVersion,
    identity,
    /** A finder over these programs, as the adapter makes one, at these places. */
    finder(locations?: readonly string[]) {
      return createSqliteFinder({ locations, isExecutable, runVersion, identity });
    },
    /** The rows a database's sessions query prints from now on, or what it prints for them as it is. */
    set(database: string, next: Record<string, unknown>[] | string) {
      answers.set(database, next);
    },
    /** What the probe prints from now on, for one database or for every one. */
    probe(next: string, database?: string) {
      if (database === undefined) probe = next;
      else probes.set(database, next);
    },
    /** Whether runs on one database, or on every one, fail from now on. */
    fail(database?: string, next = true) {
      if (database === undefined) failAll = next;
      else if (next) failing.add(database);
      else failing.delete(database);
    },
    /** Whether it throws from now on, which the real one never does. */
    throw(next = true) {
      throwing = next;
    },
    /** A program at a place from now on, saying this version, or nothing. A new program each time. */
    install(place: string, version: string | null) {
      programs.set(place, { version, identity: `${place}-${nextIdentity++}` });
    },
    /** No program at a place from now on. */
    uninstall(place: string) {
      programs.delete(place);
    },
    /** The program at a place cannot be looked at from now on, so its identity is not known. */
    unreadable(place: string) {
      const program = programs.get(place);
      if (program) programs.set(place, { ...program, identity: null });
    },
    runs,
    versionRuns,
    /** The runs that asked for the sessions. */
    queries: () => runs.filter((run) => run.args.at(-1) === SESSIONS_QUERY),
    /** The runs that asked for the tables. */
    probes: () => runs.filter((run) => run.args.at(-1) === PROBE_QUERY),
  };
}

export type StandInSqlite = ReturnType<typeof standInSqlite>;

/** A stand-in for signal 0: the pids that run, which the test changes, and each pid it was asked about. */
export function standInProcesses(running: Iterable<number> = [GATEWAY_PID]) {
  const alive = new Set(running);
  const asked: number[] = [];
  return {
    isAlive(pid: number) {
      asked.push(pid);
      return alive.has(pid);
    },
    start(pid: number) {
      alive.add(pid);
    },
    stop(pid: number) {
      alive.delete(pid);
    },
    asked,
  };
}

/** A stand-in for Agent Lookout's own pid namespace: what it says, and how many times it was asked. */
export function standInNamespace(answer: PidNamespace = { supported: false }) {
  let current = answer;
  let asked = 0;
  const reader: PidNamespaceReader & { asked(): number; set(next: PidNamespace): void } = {
    async read() {
      asked += 1;
      return current;
    },
    asked: () => asked,
    set(next) {
      current = next;
    },
  };
  return reader;
}

/** The namespace Linux gives Agent Lookout in the tests: the one the fixtures' holders name. */
export const LINUX_NAMESPACE: PidNamespace = { supported: true, id: PID_NAMESPACE };

/**
 * An adapter that reads only the stand-in files and asks only the stand-in
 * `sqlite3`, on a Mac unless `options` gives another system, with the
 * gateway's process running and no pid namespaces. With nothing in `env` it
 * reads `~/.hermes`.
 */
export function hermesAgentAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInSqlite(),
  options: HermesAgentAdapterOptions = {},
) {
  const platform = options.platform ?? "darwin";
  return createHermesAgentAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    platform,
    io: files.io,
    run: (binary, args) => sqlite.run(binary, args),
    isExecutable: (candidate) => sqlite.isExecutable(candidate),
    runVersion: (candidate) => sqlite.runVersion(candidate),
    binaryIdentity: (candidate) => sqlite.identity(candidate),
    isAlive: standInProcesses().isAlive,
    pidNamespace: standInNamespace(platform === "linux" ? LINUX_NAMESPACE : { supported: false }),
    ...options,
  });
}

/** A profile's database as Hermes Agent leaves it in rollback-journal mode: `state.db` alone. */
export function writeRollbackDatabase(files: MemoryFiles, database: string) {
  files.write(database, databaseHeader("rollback"));
}

/** A profile's database as Hermes Agent leaves it in WAL mode while it runs: `state.db`, a `-wal` that holds commits, and the `-shm`. */
export function writeLiveWalDatabase(files: MemoryFiles, database: string) {
  files.write(database, databaseHeader("wal"));
  files.write(`${database}-wal`, "frames");
  files.write(`${database}-shm`, "index");
}
