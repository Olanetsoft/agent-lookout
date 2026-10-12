// The Antigravity CLI adapter and the Antigravity 2.0 one, cut off from this
// machine, for the tests that share them: the same file system held in memory
// that the Codex tests use, a stand-in for `ps` that says which agy programs
// run, or whether the app's hub does, and counts each time it is asked, a
// stand-in for `sqlite3` that answers with the rows a test gives it, and an
// adapter built from them with a clock the test moves by hand. Nothing here
// touches a real file or runs a program.

import {
  createAntigravityAppAdapter,
  type AntigravityAppAdapterOptions,
} from "@collector/adapters/antigravity/app/index";
import type { HubAnswer, HubProcessReader } from "@collector/adapters/antigravity/app/hubProcess";
import {
  createSummariesReader,
  type SqliteAnswer,
} from "@collector/adapters/antigravity/app/summaries";
import {
  createAntigravityAdapter,
  type AntigravityAdapterOptions,
} from "@collector/adapters/antigravity/cli/index";
import type {
  AgyProcessList,
  AgyProcessReader,
} from "@collector/adapters/antigravity/cli/agyProcesses";
import type { AgySessionProcess } from "@core/mapping/antigravityLiveness";
import { APP_HOME, HOME, NOW, sqliteJson, type SummaryRow } from "@tests/fixtures/antigravity";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A stand-in for `ps`: the agy programs it says run, which the test changes, and how often it was asked. */
export function standInProcesses(initial: AgySessionProcess[] = []) {
  let answer: AgyProcessList = { ok: true, sessions: initial };
  let asked = 0;
  const reader: AgyProcessReader = {
    async read() {
      asked += 1;
      return answer.ok ? { ok: true, sessions: [...answer.sessions] } : { ok: false };
    },
  };
  return {
    reader,
    /** The agy programs that run from now on. */
    set(sessions: AgySessionProcess[]) {
      answer = { ok: true, sessions };
    },
    /** `ps` fails from now on. */
    fail() {
      answer = { ok: false };
    },
    asked: () => asked,
  };
}

/** An adapter that reads only the stand-in files and asks only the stand-in `ps`. With nothing in `env`, it looks in `~/.gemini/antigravity-cli`. */
export function antigravityAdapterFor(
  files: MemoryFiles,
  processes: ReturnType<typeof standInProcesses>,
  options: AntigravityAdapterOptions = {},
) {
  return createAntigravityAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    platform: "darwin",
    io: files.io,
    processes: processes.reader,
    ...options,
  });
}

/** A stand-in for `ps` as the app's adapter asks it: whether the hub runs, which the test changes, and how often it was asked. */
export function standInHub(running = true) {
  let answer: HubAnswer = { ok: true, running };
  let asked = 0;
  const reader: HubProcessReader = {
    async read() {
      asked += 1;
      return answer;
    },
  };
  return {
    reader,
    /** Whether the hub runs from now on. */
    set(next: boolean) {
      answer = { ok: true, running: next };
    },
    /** `ps` cannot say from now on, as on Linux or Windows, or when it fails. */
    fail() {
      answer = { ok: false };
    },
    asked: () => asked,
  };
}

/**
 * A stand-in for `sqlite3`: the rows the app's list of chats holds, which the
 * test changes, every argument list it was given, and a way to make it fail
 * or not be there at all.
 */
export function standInSqlite(initial: SummaryRow[] = []) {
  let rows = initial;
  let failing = false;
  let found = true;
  const runs: { binary: string; args: readonly string[] }[] = [];
  return {
    async run(binary: string, args: readonly string[]): Promise<SqliteAnswer> {
      runs.push({ binary, args });
      return failing ? { ok: false } : { ok: true, stdout: sqliteJson(rows) };
    },
    async find(): Promise<string | null> {
      return found ? "/usr/bin/sqlite3" : null;
    },
    /** The rows from now on. */
    set(next: SummaryRow[]) {
      rows = next;
    },
    /** Whether it fails from now on. */
    fail(next = true) {
      failing = next;
    },
    /** Whether there is one to find from now on. */
    there(next: boolean) {
      found = next;
    },
    runs,
  };
}

/**
 * An app adapter that reads only the stand-in files and asks only the stand-in
 * `ps` and `sqlite3`. With nothing in `env`, it looks in `~/.gemini/antigravity`.
 */
export function antigravityAppAdapterFor(
  files: MemoryFiles,
  hub: ReturnType<typeof standInHub>,
  sqlite: ReturnType<typeof standInSqlite> = standInSqlite(),
  options: AntigravityAppAdapterOptions = {},
) {
  const home = options.env?.AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME ?? APP_HOME;
  return createAntigravityAppAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    platform: "darwin",
    io: files.io,
    hub: hub.reader,
    summaries: createSummariesReader({
      home,
      io: files.io,
      platform: options.platform ?? "darwin",
      run: sqlite.run,
      find: sqlite.find,
    }),
    ...options,
  });
}

/**
 * The files as a disk that ignores case sees them, as macOS and Windows format
 * one by default: each path named in `same` leads to the path it names.
 */
export function caseBlind(io: ReadOnlyIo, same: Readonly<Record<string, string>>): ReadOnlyIo {
  const to = (target: string) => same[target] ?? target;
  return {
    ...io,
    readdir: (target) => io.readdir(to(target)),
    stat: (target) => io.stat(to(target)),
    lstat: (target) => io.lstat(to(target)),
  };
}
