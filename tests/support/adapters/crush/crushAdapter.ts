// The Crush adapter, cut off from this machine, for the tests that share it: the
// same file system held in memory that the Codex tests use, a stand-in for
// `sqlite3` that answers the two questions with what the test gives it and keeps
// every argument list it was given, a stand-in for what `ps` says of Crush, and
// an adapter built from them with a clock the test moves by hand. Nothing here
// touches a real file or runs a program.

import type { SqliteAnswer } from "@collector/adapters/antigravity/app/summaries";
import { createCrushAdapter, type CrushAdapterOptions } from "@collector/adapters/crush/index";
import { PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/crush/sessionRows";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import {
  DATABASE,
  HOME,
  NOW,
  PROJECT,
  PROJECT_LIST,
  probeJson,
  projectListJson,
  sqliteJson,
} from "@tests/fixtures/crush/crush";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** The path of the database a run of `sqlite3` was given, from its address. */
export function databaseIn(args: readonly string[]): string {
  const address = args.at(-2) ?? "";
  return decodeURIComponent(address.slice("file:".length).split("?")[0] ?? "");
}

/**
 * A stand-in for `sqlite3`: the rows the question of the sessions prints, for
 * every database or for one, what the probe prints, every argument list it was
 * given, and ways to make it fail or not be there at all.
 */
export function standInSqlite(initial: Record<string, unknown>[] = []) {
  let rows: Record<string, unknown>[] | string = initial;
  const rowsOf = new Map<string, Record<string, unknown>[]>();
  const failingFiles = new Set<string>();
  let probe = probeJson();
  let failing: "no" | "question" | "both" = "no";
  let found = true;
  let before: () => void = () => {};
  const runs: (readonly string[])[] = [];
  const timeouts: (number | undefined)[] = [];
  return {
    async run(_binary: string, args: readonly string[], timeoutMs?: number): Promise<SqliteAnswer> {
      runs.push(args);
      timeouts.push(timeoutMs);
      before();
      const file = databaseIn(args);
      if (failing === "both" || failingFiles.has(file)) return { ok: false };
      const question = args.at(-1);
      if (question === SESSIONS_QUERY) {
        if (failing === "question") return { ok: false };
        const own = rowsOf.get(file) ?? rows;
        return { ok: true, stdout: typeof own === "string" ? own : sqliteJson(own) };
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
    /** The rows of one database from now on. */
    setFor(file: string, next: Record<string, unknown>[]) {
      rowsOf.set(file, next);
    },
    /** What the probe prints from now on. */
    setProbe(next: string) {
      probe = next;
    },
    fail(how: "no" | "question" | "both" = "both") {
      failing = how;
    },
    /** Makes every read of one database fail, or stop failing. */
    failFor(file: string, on = true) {
      if (on) failingFiles.add(file);
      else failingFiles.delete(file);
    },
    gone() {
      found = false;
    },
    /** What happens as each run starts, such as a clock moving on. */
    beforeEach(step: () => void) {
      before = step;
    },
    runs,
    timeouts,
  };
}

export type StandInSqlite = ReturnType<typeof standInSqlite>;

/** A stand-in for what `ps` says of Crush, which counts how often it is asked. */
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

/** Crush's list of projects and, for each folder, its database, where a Mac and Linux keep them, as stand-in files. */
export function crushFiles(folders: readonly string[] = [PROJECT]): MemoryFiles {
  const files = memoryFiles();
  files.write(PROJECT_LIST, projectListJson(folders));
  for (const folder of folders) {
    files.write(folder === PROJECT ? DATABASE : `${folder}/.crush/crush.db`, "database");
  }
  return files;
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with a Crush
 * program running unless the test says otherwise. With nothing in `env` it looks
 * in `~/.local/share/crush`.
 */
export function crushAdapterFor(
  files: MemoryFiles,
  sqlite: StandInSqlite = standInSqlite(),
  options: CrushAdapterOptions = {},
) {
  return createCrushAdapter({
    now: () => NOW,
    io: files.io,
    processes: standInProcesses(),
    run: sqlite.run,
    find: sqlite.find,
    ...options,
    env: options.env ?? {},
    homeDir: options.homeDir ?? HOME,
    platform: options.platform ?? "darwin",
  });
}
