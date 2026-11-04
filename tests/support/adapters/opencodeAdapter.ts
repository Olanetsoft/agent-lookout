// The OpenCode adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, a
// stand-in for `sqlite3` that answers the probe, the sessions query and the
// question of a session's last text with what the test gives it and keeps
// every argument list it was given, a stand-in for what `ps` says of
// OpenCode, and an adapter built from them with a clock the test moves by
// hand. Nothing here touches a real file or runs a program.

import type { SqliteAnswer } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import {
  createOpencodeAdapter,
  opencodeDatabaseFor,
  type OpencodeAdapterOptions,
} from "@collector/adapters/opencode/index";
import { lastTextQuery } from "@collector/adapters/opencode/lastMessages";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import {
  BOTH_SESSIONS_QUERY,
  OPENCODE_2_SESSIONS_QUERY,
  PROBE_QUERY,
  SESSIONS_QUERY,
} from "@collector/adapters/opencode/sessionRows";
import { HOME, NOW, probeJson, sqliteJson } from "@tests/fixtures/opencode/opencode";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** The question of the sessions, for each layout of the database. */
const SESSIONS_QUESTIONS = [SESSIONS_QUERY, OPENCODE_2_SESSIONS_QUERY, BOTH_SESSIONS_QUERY];

/** One run of the stand-in `sqlite3`: the program, its arguments, and the timeout and cap on what it prints it was given. */
export interface SqliteRun {
  binary: string;
  args: readonly string[];
  timeoutMs: number | undefined;
  maxOutputBytes: number | undefined;
}

/**
 * A stand-in for `sqlite3`: what the probe prints, the rows the sessions
 * query prints and what the question of each session's last text prints,
 * which the test changes, every argument list it was given, and a way to make
 * it fail, or not be there at all. A question it was not given an answer for
 * fails.
 */
export function standInSqlite(initial: Record<string, unknown>[] = []) {
  let rows: Record<string, unknown>[] | string = initial;
  let probe = probeJson("v1");
  let failing = false;
  let throwing = false;
  let found = true;
  /** What the question of each session's last text prints, by the question itself. */
  const lastTexts = new Map<string, string>();
  const runs: SqliteRun[] = [];
  return {
    async run(
      binary: string,
      args: readonly string[],
      timeoutMs?: number,
      maxOutputBytes?: number,
    ): Promise<SqliteAnswer> {
      runs.push({ binary, args, timeoutMs, maxOutputBytes });
      if (throwing) throw new Error("A stand-in that throws.");
      if (failing) return { ok: false };
      const question = args.at(-1) ?? "";
      if (question === PROBE_QUERY) return { ok: true, stdout: probe };
      if (SESSIONS_QUESTIONS.includes(question)) {
        return { ok: true, stdout: typeof rows === "string" ? rows : sqliteJson(rows) };
      }
      const said = lastTexts.get(question);
      if (said !== undefined) return { ok: true, stdout: said };
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
    /** What the question of this session's last text prints from now on, by OpenCode's own id for it. */
    said(sessionId: string, stdout: string) {
      const question = lastTextQuery(sessionId);
      if (question === null) throw new Error(`Not an id OpenCode makes: ${sessionId}`);
      lastTexts.set(question, stdout);
    },
    runs,
    /** The runs that asked for the sessions. */
    queries: () => runs.filter((run) => SESSIONS_QUESTIONS.includes(run.args.at(-1) ?? "")),
    /** The runs that asked for the tables. */
    probes: () => runs.filter((run) => run.args.at(-1) === PROBE_QUERY),
    /** The runs that asked anything but those two: the questions of a session's last text. */
    questions: () =>
      runs.filter(
        (run) =>
          !SESSIONS_QUESTIONS.includes(run.args.at(-1) ?? "") && run.args.at(-1) !== PROBE_QUERY,
      ),
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
