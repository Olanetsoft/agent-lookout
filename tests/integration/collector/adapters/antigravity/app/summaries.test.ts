import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import {
  createSummariesReader,
  findSqlite,
  runSqlite,
  SQLITE_TIMEOUT_MS,
  sqliteArguments,
  SUMMARIES_FILE,
} from "@collector/adapters/antigravity/app/summaries";
import { nodeIo } from "@collector/files/readOnlyIo";
import { conversationId, NOW, PRIVATE_WORDS, workspaceUris } from "@tests/fixtures/antigravity";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a database this test
// writes by hand with that same sqlite3, laid out as Antigravity 2.0's list of
// chats is: the columns it has, invented values in each. Where there is no
// sqlite3, as on Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const A = conversationId("a1");
const B = conversationId("b2");
const FOLDER = "/Users/example/code/demo-project";

/** Every column the app's table has, by name. */
const COLUMNS = [
  "conversation_id TEXT",
  "title TEXT",
  "preview TEXT",
  "step_count INTEGER",
  "last_modified_time TEXT",
  "workspace_uris TEXT",
  "status TEXT",
  "source TEXT",
  "project_id TEXT",
  "agent_name TEXT",
  "parent_conversation_id TEXT",
  "nesting_depth INTEGER",
  "battle_id TEXT",
  "winning_conversation_id TEXT",
  "not_fully_idle INTEGER",
  "killed INTEGER",
  "last_user_input_time TEXT",
  "last_user_input_step_index INTEGER",
  "app_data_dir TEXT",
  "raw_summary TEXT",
  "group_id TEXT",
];

/** A text as SQL writes one. */
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The app's list of chats, in WAL mode as SQLite databases the app keeps are,
 * with no `-wal` or `-shm` file beside it, as it was seen while the app was
 * not writing.
 */
async function makeSummaries(home: string, rows: [string, string][]): Promise<string> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, SUMMARIES_FILE);
  const inserts = rows.map(
    ([id, uris]) =>
      `INSERT INTO conversation_summaries (conversation_id, title, preview, raw_summary, workspace_uris, status, nesting_depth) VALUES (${text(id)}, 'Count the files', ${text(PRIVATE_WORDS)}, ${text(PRIVATE_WORDS)}, ${text(uris)}, 'CASCADE_RUN_STATUS_IDLE', 0);`,
  );
  execFileSync(sqlite as string, [
    file,
    [
      "PRAGMA journal_mode=WAL;",
      `CREATE TABLE conversation_summaries (${COLUMNS.join(", ")});`,
      "CREATE TABLE conversations_fts (content TEXT);",
      `INSERT INTO conversations_fts VALUES (${text(PRIVATE_WORDS)});`,
      ...inserts,
    ].join(" "),
  ]);
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  // Byte 18 of the header is 2 for a database in WAL mode.
  expect((await readFile(file))[18]).toBe(2);
  return file;
}

/** Each file in a folder, by name, with its hash, size and modified time. */
async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const info = await lstat(path.join(dir, name));
    const hash = createHash("sha256")
      .update(await readFile(path.join(dir, name)))
      .digest("hex");
    found[name] = `${hash} ${info.size} ${info.mtimeMs}`;
  }
  return found;
}

describe.skipIf(sqlite === null)("reading the app's list of chats with the real sqlite3", () => {
  test("reads each chat's folder, and leaves the folder as it was: no file changed, none made", async () => {
    const home = path.join(await tempDir(), "antigravity");
    await makeSummaries(home, [
      [A, workspaceUris(FOLDER)],
      [B.toUpperCase(), workspaceUris("/Users/example/code/demo project", FOLDER)],
      [conversationId("c3"), ""],
    ]);
    const before = await snapshotOf(home);
    const reader = createSummariesReader({ home, io: nodeIo, platform: process.platform });
    expect(await reader.read(NOW)).toEqual({
      state: "read",
      folders: new Map([
        [A, FOLDER],
        [B, "/Users/example/code/demo project"],
      ]),
    });
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("the answer holds the two columns asked for, and none of what was written in a chat", async () => {
    const home = path.join(await tempDir(), "antigravity");
    const file = await makeSummaries(home, [[A, workspaceUris(FOLDER)]]);
    const answer = await runSqlite(sqlite as string, sqliteArguments(file));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(JSON.parse(answer.stdout)).toEqual([
      { conversation_id: A, workspace_uris: workspaceUris(FOLDER) },
    ]);
    expect(answer.stdout).not.toContain(PRIVATE_WORDS);
    expect(answer.stdout).not.toContain("Count the files");
  });

  test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
    const home = path.join(await tempDir(), "a b?c%d", "antigravity");
    await makeSummaries(home, [[A, workspaceUris(FOLDER)]]);
    const reader = createSummariesReader({ home, io: nodeIo, platform: process.platform });
    expect((await reader.read(NOW)).folders.get(A)).toBe(FOLDER);
  });

  test("a database that is not there is not made", async () => {
    const home = await tempDir();
    const missing = path.join(home, SUMMARIES_FILE);
    const answer = await runSqlite(sqlite as string, sqliteArguments(missing));
    expect(answer.ok).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  test("a file that is not a database is a failed read, and is left as it was", async () => {
    const home = await tempDir();
    await writeFile(path.join(home, SUMMARIES_FILE), "not a database\n");
    const before = await snapshotOf(home);
    const reader = createSummariesReader({ home, io: nodeIo, platform: process.platform });
    expect(await reader.read(NOW)).toEqual({ state: "failed", folders: new Map() });
    expect(await snapshotOf(home)).toEqual(before);
  });
});

// runSqlite takes the program to start, so harmless programs stand in for
// sqlite3 here, to show how it starts one. They are POSIX programs, which
// Windows does not have, and no sqlite3 is run there.
describe.skipIf(process.platform === "win32")("runSqlite, against stand-in programs", () => {
  test("gives the program only a search path and a language, none of Agent Lookout's own settings", async () => {
    vi.stubEnv("AGENT_LOOKOUT_SMTP_URL", "smtps://demo:secret@mail.example.com");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const answer = await runSqlite("/usr/bin/env", []);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.stdout.trim().split("\n").sort()).toEqual(["LC_ALL=C", "PATH=/usr/bin:/bin"]);
  });

  test("closes stdin, so a program that reads it ends at once", async () => {
    const started = Date.now();
    expect(await runSqlite("/bin/cat", [])).toEqual({ ok: true, stdout: "" });
    expect(Date.now() - started).toBeLessThan(SQLITE_TIMEOUT_MS);
  });

  test("stops a program that prints far more than a list of chats", async () => {
    expect(await runSqlite("/usr/bin/yes", [])).toEqual({ ok: false });
  });

  test("stops a program that does not answer in 5 seconds", async () => {
    const started = Date.now();
    expect(await runSqlite("/bin/sleep", ["30"])).toEqual({ ok: false });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(SQLITE_TIMEOUT_MS - 100);
    // Far short of the 30 seconds the program wanted.
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);

  test("stops a program sooner when given a shorter timeout", async () => {
    const started = Date.now();
    expect(await runSqlite("/bin/sleep", ["30"], 300)).toEqual({ ok: false });
    expect(Date.now() - started).toBeLessThan(SQLITE_TIMEOUT_MS - 1_000);
  });

  test("starts nothing for a timeout under a millisecond, which execFile would take as none", async () => {
    const started = path.join(await tempDir(), "started");
    const stub = await writeStub(`touch '${started}'`);
    for (const timeout of [0, 0.5, -1, Number.NaN]) {
      expect(await runSqlite(stub, [], timeout), String(timeout)).toEqual({ ok: false });
    }
    await expect(lstat(started)).rejects.toMatchObject({ code: "ENOENT" });
    // Given its usual timeout, the same program runs.
    expect(await runSqlite(stub, [])).toEqual({ ok: true, stdout: "" });
    expect((await lstat(started)).isFile()).toBe(true);
  });

  test("never lets a program run longer than 5 seconds, whatever longer timeout it is given", async () => {
    const started = Date.now();
    const answers = await Promise.all(
      [60_000, Number.POSITIVE_INFINITY].map((timeout) => runSqlite("/bin/sleep", ["30"], timeout)),
    );
    expect(answers).toEqual([{ ok: false }, { ok: false }]);
    const elapsed = Date.now() - started;
    // Stopped at 5 seconds, not at once and not at 30.
    expect(elapsed).toBeGreaterThanOrEqual(SQLITE_TIMEOUT_MS - 100);
    expect(elapsed).toBeLessThan(15_000);
  }, 20_000);
});
