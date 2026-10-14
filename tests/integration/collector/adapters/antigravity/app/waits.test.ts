import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import {
  createWaitReader,
  WAITING_STATUS,
  waitArguments,
} from "@collector/adapters/antigravity/app/waits";
import { nodeIo } from "@collector/files/readOnlyIo";
import { conversationId, NOW, PRIVATE_WORDS } from "@tests/fixtures/antigravity";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a chat's database this
// test writes by hand with that same sqlite3, laid out as Antigravity 2.0's
// are: the columns its steps table has, invented values in each. Where there
// is no sqlite3, as on Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const A = conversationId("a1");
const DONE = 3;
const GENERIC = 132;
const PLANNER_RESPONSE = 15;
const RUN_COMMAND = 21;
const USER_INPUT = 14;

/** Every column the app's steps table has, by name. */
const COLUMNS = [
  "idx INTEGER",
  "step_type INTEGER",
  "status INTEGER",
  "has_subtrajectory INTEGER",
  "metadata BLOB",
  "error_details BLOB",
  "permissions BLOB",
  "task_details BLOB",
  "render_info BLOB",
  "step_payload BLOB",
  "step_format INTEGER",
];

/** A text as SQL writes one. */
const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A chat's database with these steps, as `[idx, step_type, status]`, in WAL
 * mode as the app keeps it, with no `-wal` or `-shm` file beside it, as it was
 * seen while a chat waited. Every step's payload holds words that stand for
 * what was written in the chat.
 */
async function makeDatabase(
  conversations: string,
  steps: [number, number, number][],
): Promise<string> {
  await mkdir(conversations, { recursive: true });
  const file = path.join(conversations, `${A}.db`);
  const inserts = steps.map(
    ([idx, type, status]) =>
      `INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, permissions, step_payload, step_format) VALUES (${idx}, ${type}, ${status}, 0, ${text(PRIVATE_WORDS)}, ${text(PRIVATE_WORDS)}, ${text(PRIVATE_WORDS)}, 1);`,
  );
  execFileSync(sqlite as string, [
    file,
    ["PRAGMA journal_mode=WAL;", `CREATE TABLE steps (${COLUMNS.join(", ")});`, ...inserts].join(
      " ",
    ),
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

/** What the reader says of the chat's database as it is on disk now. */
async function readNow(file: string) {
  const reader = createWaitReader({ platform: process.platform });
  return reader.read(A, file, await nodeIo.lstat(file), false, NOW);
}

describe.skipIf(sqlite === null)("reading a chat's database with the real sqlite3", () => {
  test("a chat whose newest step waits, whatever its type, waits, and the folder is left as it was", async () => {
    for (const type of [GENERIC, RUN_COMMAND]) {
      const conversations = path.join(await tempDir(), "conversations");
      const file = await makeDatabase(conversations, [
        [0, USER_INPUT, DONE],
        [1, PLANNER_RESPONSE, DONE],
        [2, type, WAITING_STATUS],
      ]);
      const before = await snapshotOf(conversations);
      const info = await nodeIo.lstat(file);
      expect(await readNow(file), `type ${type}`).toEqual({
        state: "waiting",
        since: Math.floor(info.mtimeMs),
      });
      expect(await snapshotOf(conversations), `type ${type}`).toEqual(before);
    }
  });

  test("the newest step is the one with the highest idx, not the last row written", async () => {
    const conversations = path.join(await tempDir(), "conversations");
    // Neither the first row written nor the last is the newest step.
    const file = await makeDatabase(conversations, [
      [1, PLANNER_RESPONSE, DONE],
      [3, GENERIC, WAITING_STATUS],
      [2, PLANNER_RESPONSE, DONE],
    ]);
    expect((await readNow(file)).state).toBe("waiting");
  });

  test("a chat with no steps yet does not wait", async () => {
    const conversations = path.join(await tempDir(), "conversations");
    const file = await makeDatabase(conversations, []);
    expect(await readNow(file)).toEqual({ state: "not-waiting" });
  });

  test("the answer holds the two numbers asked for, and none of what a step holds", async () => {
    const conversations = path.join(await tempDir(), "conversations");
    const file = await makeDatabase(conversations, [[2, GENERIC, WAITING_STATUS]]);
    const answer = await runSqlite(sqlite as string, waitArguments(file));
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(JSON.parse(answer.stdout)).toEqual([{ idx: 2, status: WAITING_STATUS }]);
    expect(answer.stdout).not.toContain(PRIVATE_WORDS);
  });

  test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
    const conversations = path.join(await tempDir(), "a b?c%d", "conversations");
    const file = await makeDatabase(conversations, [[2, GENERIC, WAITING_STATUS]]);
    expect((await readNow(file)).state).toBe("waiting");
  });

  test("a database that is not there is not made", async () => {
    const conversations = await tempDir();
    const missing = path.join(conversations, `${A}.db`);
    const answer = await runSqlite(sqlite as string, waitArguments(missing));
    expect(answer.ok).toBe(false);
    expect(await readdir(conversations)).toEqual([]);
  });

  test("a file that is not a database is a failed read, and is left as it was", async () => {
    const conversations = await tempDir();
    const file = path.join(conversations, `${A}.db`);
    await writeFile(file, "not a database\n");
    const before = await snapshotOf(conversations);
    expect(await readNow(file)).toEqual({ state: "failed" });
    expect(await snapshotOf(conversations)).toEqual(before);
  });
});
