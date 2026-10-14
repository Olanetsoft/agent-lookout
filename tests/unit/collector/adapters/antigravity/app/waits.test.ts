import { describe, expect, test } from "vitest";

import { RETRY_MS, summariesUri } from "@collector/adapters/antigravity/app/summaries";
import {
  createWaitReader,
  NEWEST_STEP_QUERY,
  newestStep,
  WAITING_STATUS,
  waitArguments,
} from "@collector/adapters/antigravity/app/waits";
import type { FileInfo } from "@collector/files/readOnlyIo";
import { APP_HOME, conversationId, databasePath, NOW, SECOND } from "@tests/fixtures/antigravity";
import { standInSqlite } from "@tests/support/adapters/antigravityAdapter";

const A = conversationId("a1");
const B = conversationId("b2");
const FILE_A = databasePath(APP_HOME, A);
const FILE_B = databasePath(APP_HOME, B);
const DONE = 3;

const database = (fields: Partial<FileInfo> = {}): FileInfo => ({
  kind: "file",
  size: 4096,
  mtimeMs: NOW - 2 * SECOND + 0.5,
  ino: 7,
  ...fields,
});

function setUp(platform: NodeJS.Platform = "darwin") {
  const sqlite = standInSqlite();
  const reader = createWaitReader({ platform, run: sqlite.run, find: sqlite.find });
  return { sqlite, reader };
}

describe("the question sqlite3 is asked", () => {
  test("opens the chat's database read-only, as one nothing changes, with no settings of the person's own", () => {
    expect(waitArguments(FILE_A)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      summariesUri(FILE_A),
      "SELECT idx, status FROM steps ORDER BY idx DESC LIMIT 1",
    ]);
    expect(summariesUri(FILE_A)).toMatch(/\?mode=ro&immutable=1$/);
  });

  test("asks for the newest step's number and status alone, never what a step holds", () => {
    expect(NEWEST_STEP_QUERY).not.toMatch(
      /\*|payload|metadata|permissions|task_details|render_info|error_details|step_type/i,
    );
  });
});

describe("newestStep", () => {
  test("is the one row's number and status", () => {
    expect(newestStep('[{"idx":2,"status":9}]\n')).toEqual({ idx: 2, status: 9 });
  });

  test("is null for a table with no rows, which sqlite3 -json prints as nothing", () => {
    expect(newestStep("")).toBeNull();
    expect(newestStep("\n")).toBeNull();
  });

  test("is undefined for anything but one row of two whole numbers", () => {
    for (const stdout of [
      "not json",
      "{}",
      "[]",
      '[{"idx":1,"status":9},{"idx":2,"status":3}]',
      '[{"idx":"2","status":9}]',
      '[{"idx":2,"status":9.5}]',
      '[{"idx":2}]',
      "[null]",
    ]) {
      expect(newestStep(stdout), stdout).toBeUndefined();
    }
  });
});

describe("whether a chat waits", () => {
  test("waits while its newest step's status is WAITING, since the database was written", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    expect(await reader.read(A, FILE_A, database(), false, NOW)).toEqual({
      state: "waiting",
      since: NOW - 2 * SECOND,
    });
    expect(sqlite.stepRuns()).toEqual([
      { binary: "/usr/bin/sqlite3", args: waitArguments(FILE_A) },
    ]);
  });

  test("does not wait when its newest step is in any other status, or it has none", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 4, status: DONE });
    expect(await reader.read(A, FILE_A, database(), false, NOW)).toEqual({ state: "not-waiting" });
    expect(await reader.read(B, FILE_B, database({ ino: 8 }), false, NOW)).toEqual({
      state: "not-waiting",
    });
  });

  test("is read again only when the database changes, and the same step waits since it was first seen to", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    const first = await reader.read(A, FILE_A, database(), false, NOW);
    await reader.read(A, FILE_A, database(), false, NOW + 10 * SECOND);
    expect(sqlite.stepRuns()).toHaveLength(1);

    const later = database({ mtimeMs: NOW + 20 * SECOND, size: 8192 });
    expect(await reader.read(A, FILE_A, later, false, NOW + 30 * SECOND)).toEqual(first);
    expect(sqlite.stepRuns()).toHaveLength(2);

    // A new step that waits has waited since the database was written for it.
    sqlite.step(A, { idx: 5, status: WAITING_STATUS });
    const newer = database({ mtimeMs: NOW + 40 * SECOND });
    expect(await reader.read(A, FILE_A, newer, false, NOW + 50 * SECOND)).toEqual({
      state: "waiting",
      since: NOW + 40 * SECOND,
    });
  });

  test("an answered step stops the wait once the database changes", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    await reader.read(A, FILE_A, database(), false, NOW);
    sqlite.step(A, { idx: 2, status: DONE });
    const answered = database({ mtimeMs: NOW + 5 * SECOND });
    expect(await reader.read(A, FILE_A, answered, false, NOW + 6 * SECOND)).toEqual({
      state: "not-waiting",
    });
  });

  test("is not read while the database's -wal file is there, since what it holds would not be seen", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    expect(await reader.read(A, FILE_A, database(), true, NOW)).toEqual({ state: "not-read" });
    expect(sqlite.runs).toEqual([]);
    // Once it is gone, the database is read, whether or not it changed.
    expect((await reader.read(A, FILE_A, database(), false, NOW + SECOND)).state).toBe("waiting");
  });

  test("is not read without a database that is an ordinary file", async () => {
    const { sqlite, reader } = setUp();
    expect(await reader.read(A, FILE_A, null, false, NOW)).toEqual({ state: "not-read" });
    expect(await reader.read(A, FILE_A, database({ kind: "other" }), false, NOW)).toEqual({
      state: "not-read",
    });
    expect(sqlite.runs).toEqual([]);
  });

  test("is never read on Windows", async () => {
    const { sqlite, reader } = setUp("win32");
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    expect(await reader.read(A, FILE_A, database(), false, NOW)).toEqual({ state: "not-read" });
    expect(sqlite.runs).toEqual([]);
  });

  test("says so when no sqlite3 is found, or it fails, and tries again a minute later, changed or not", async () => {
    const { sqlite, reader } = setUp();
    sqlite.there(false);
    expect(await reader.read(A, FILE_A, database(), false, NOW)).toEqual({ state: "no-sqlite" });

    sqlite.there(true);
    sqlite.fail();
    expect(await reader.read(A, FILE_A, database(), false, NOW + RETRY_MS)).toEqual({
      state: "failed",
    });
    expect(sqlite.stepRuns()).toHaveLength(1);
    const changed = database({ mtimeMs: NOW + 5 * SECOND });
    expect(await reader.read(A, FILE_A, changed, false, NOW + RETRY_MS + 10 * SECOND)).toEqual({
      state: "failed",
    });
    expect(sqlite.stepRuns()).toHaveLength(1);

    sqlite.fail(false);
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    expect((await reader.read(A, FILE_A, changed, false, NOW + 2 * RETRY_MS)).state).toBe(
      "waiting",
    );
  });

  test("an answer that is not one row of two numbers is a read that failed", async () => {
    const sqlite = standInSqlite();
    const reader = createWaitReader({
      platform: "linux",
      run: async () => ({ ok: true, stdout: '[{"idx":"two","status":9}]' }),
      find: sqlite.find,
    });
    expect(await reader.read(A, FILE_A, database(), false, NOW)).toEqual({ state: "failed" });
  });

  test("forgets the chats it is no longer asked about", async () => {
    const { sqlite, reader } = setUp();
    sqlite.step(A, { idx: 2, status: WAITING_STATUS });
    await reader.read(A, FILE_A, database(), false, NOW);
    reader.keepOnly(new Set([B]));
    await reader.read(A, FILE_A, database(), false, NOW + SECOND);
    expect(sqlite.stepRuns()).toHaveLength(2);
  });
});
