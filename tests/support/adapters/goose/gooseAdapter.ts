// The Goose adapter, cut off from this machine, for the tests that share it: the
// same file system held in memory that the Codex tests use, a stand-in for
// `sqlite3` that answers the two questions with what the test gives it and keeps
// every argument list it was given, a stand-in for what `ps` says of Goose, and
// an adapter built from them with a clock the test moves by hand. Nothing here
// touches a real file or runs a program.

import type { SqliteAnswer } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/goose/database";
import {
  createGooseAdapter,
  gooseDatabaseFor,
  type GooseAdapterOptions,
} from "@collector/adapters/goose/index";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/goose/sessionRows";
import { DATABASE, HOME, NOW, probeJson, sqliteJson } from "@tests/fixtures/goose/goose";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/**
 * A stand-in for `sqlite3`: the rows the question of the sessions prints, what
 * the probe prints, every argument list it was given, and ways to make it fail
 * or not be there at all.
 */
export function standInSqlite(initial: Record<string, unknown>[] = []) {
  let rows: Record<string, unknown>[] | string = initial;
  let probe = probeJson();
  let failing: "no" | "question" | "both" = "no";
  let found = true;
  const runs: (readonly string[])[] = [];
  return {
    async run(_binary: string, args: readonly string[]): Promise<SqliteAnswer> {
      runs.push(args);
      if (failing === "both") return { ok: false };
      const question = args.at(-1);
      if (question === SESSIONS_QUERY) {
        if (failing === "question") return { ok: false };
        return { ok: true, stdout: typeof rows === "string" ? rows : sqliteJson(rows) };
      }
      return question === PROBE_QUERY ? { ok: true, stdout: probe } : { ok: false };
    },
    async find(): Promise<string | null> {
      return found ? "/usr/bin/sqlite3" : null;
    },
    /** The rows from now on, or what it prints for them as it is. */
    set(next: Record<string, unknown>[] | string) {
      rows = next;
    },
    /** What the probe prints from now on. */
    setProbe(next: string) {
      probe = next;
    },
    fail(how: "no" | "question" | "both" = "both") {
      failing = how;
    },
    gone() {
      found = false;
    },
    runs,
  };
}

export type StandInSqlite = ReturnType<typeof standInSqlite>;

/** A stand-in for what `ps` says of Goose, which counts how often it is asked. */
export function standInProcesses(initial: ProcessAnswer = { ok: true, running: true }) {
  let answer = initial;
  const asked = { count: 0 };
  return {
    asked,
    set(next: ProcessAnswer) {
      answer = next;
    },
    async read() {
      asked.count += 1;
      return answer;
    },
  };
}

/** Goose's folders and its database, where a Mac and Linux keep them, as stand-in files. */
export function gooseFiles(database = DATABASE): MemoryFiles {
  const files = memoryFiles();
  files.write(database, "database");
  return files;
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with a Goose
 * program running unless the test says otherwise. With nothing in `env` it
 * looks in `~/.local/share/goose`.
 */
export function gooseAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInSqlite(),
  options: GooseAdapterOptions = {},
) {
  const env = options.env ?? {};
  const platform = options.platform ?? "darwin";
  const homeDir = options.homeDir ?? HOME;
  return createGooseAdapter({
    now: () => NOW,
    io: files.io,
    processes: standInProcesses(),
    reader: createDatabaseReader({
      file: gooseDatabaseFor(env, homeDir),
      io: files.io,
      platform,
      run: sqlite.run,
      find: sqlite.find,
    }),
    ...options,
    env,
    homeDir,
    platform,
  });
}
