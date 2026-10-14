// The OpenCode adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, a
// stand-in for `sqlite3` that answers the probe and the sessions query with
// what the test gives it and keeps every argument list it was given, a
// stand-in for what `ps` says of OpenCode, and an adapter built from them
// with a clock the test moves by hand. Nothing here touches a real file or
// runs a program.

import type { SqliteAnswer } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import {
  createOpencodeAdapter,
  opencodeDatabaseFor,
  type OpencodeAdapterOptions,
} from "@collector/adapters/opencode/index";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/opencode/sessionRows";
import { HOME, NOW, probeJson, sqliteJson } from "@tests/fixtures/opencode/opencode";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/**
 * A stand-in for `sqlite3`: what the probe prints and the rows the sessions
 * query prints, which the test changes, every argument list it was given, and
 * a way to make it fail, or not be there at all.
 */
export function standInSqlite(initial: Record<string, unknown>[] = []) {
  let rows: Record<string, unknown>[] | string = initial;
  let probe = probeJson("v1");
  let failing = false;
  let throwing = false;
  let found = true;
  const runs: { binary: string; args: readonly string[] }[] = [];
  return {
    async run(binary: string, args: readonly string[]): Promise<SqliteAnswer> {
      runs.push({ binary, args });
      if (throwing) throw new Error("A stand-in that throws.");
      if (failing) return { ok: false };
      if (args.at(-1) === PROBE_QUERY) return { ok: true, stdout: probe };
      if (args.at(-1) === SESSIONS_QUERY) {
        return { ok: true, stdout: typeof rows === "string" ? rows : sqliteJson(rows) };
      }
      return { ok: false };
    },
    async find(): Promise<string | null> {
      return found ? "/usr/bin/sqlite3" : null;
    },
    /** The rows from now on, or what it prints for them as it is. */
    set(next: Record<string, unknown>[] | string) {
      rows = next;
    },
    /** What the probe prints from now on. */
    probe(next: string) {
      probe = next;
    },
    /** Whether it fails from now on. */
    fail(next = true) {
      failing = next;
    },
    /** Whether it throws from now on, which the real one never does. */
    throw(next = true) {
      throwing = next;
    },
    /** Whether there is one to find from now on. */
    there(next: boolean) {
      found = next;
    },
    runs,
    /** The runs that asked for the sessions. */
    queries: () => runs.filter((run) => run.args.at(-1) === SESSIONS_QUERY),
    /** The runs that asked for the tables. */
    probes: () => runs.filter((run) => run.args.at(-1) === PROBE_QUERY),
  };
}

export type StandInSqlite = ReturnType<typeof standInSqlite>;

/**
 * A stand-in for what `ps` says of OpenCode: that an OpenCode program runs,
 * unless the test says otherwise, and how many times it was asked.
 */
export function standInProcesses(initial: ProcessAnswer = { ok: true, running: true }) {
  let answer = initial;
  let asked = 0;
  return {
    async read(): Promise<ProcessAnswer> {
      asked += 1;
      return answer;
    },
    /** What it says from now on. */
    set(next: ProcessAnswer) {
      answer = next;
    },
    /** How many times it was asked. */
    asked: () => asked,
  };
}

export type StandInProcesses = ReturnType<typeof standInProcesses>;

/**
 * An adapter that reads only the stand-in files and asks only the stand-in
 * `sqlite3`, and a `ps` that says an OpenCode program runs unless `options`
 * gives another. With nothing in `env`, it reads `~/.local/share/opencode/opencode.db`.
 */
export function opencodeAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInSqlite(),
  options: OpencodeAdapterOptions = {},
) {
  const env = options.env ?? {};
  const platform = options.platform ?? "darwin";
  const file = opencodeDatabaseFor(env, options.homeDir ?? HOME);
  return createOpencodeAdapter({
    env,
    homeDir: HOME,
    now: () => NOW,
    platform,
    io: files.io,
    reader:
      file === null
        ? undefined
        : createDatabaseReader({
            file,
            io: files.io,
            platform,
            run: sqlite.run,
            find: sqlite.find,
          }),
    processes: standInProcesses(),
    ...options,
  });
}
