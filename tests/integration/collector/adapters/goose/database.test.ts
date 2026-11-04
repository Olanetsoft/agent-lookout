import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  findSqlite,
  MAX_OUTPUT_BYTES,
  runSqlite,
} from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/goose/database";
import { MAX_SESSIONS, PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/goose/sessionRows";
import { sqliteArguments } from "@collector/adapters/opencode/sessionRows";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  HOUR,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  PROJECT,
  SCHEMA,
  sessionSql,
} from "@tests/fixtures/goose/goose";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a database this test
// writes with that same sqlite3, laid out as Goose v1.57.0's is. What Goose
// saves lies in the database's -wal file, and a second sqlite3, kept open as
// Goose keeps its database open, stands in for it here. Where there is no
// sqlite3, as on Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

/** Goose's data folder, with its database, in WAL mode, holding these rows, and nothing beside it. */
async function makeDatabase(rows: string[]): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "goose", "sessions");
  const file = path.join(dir, "sessions.db");
  await mkdir(dir, { recursive: true });
  // On stdin, since Linux takes no argument longer than 128 KB.
  execFileSync(sqlite as string, ["-init", "/dev/null", file], {
    input: [SCHEMA, ...rows].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  // The SQLite of macOS keeps the two files once the database is closed; others remove them.
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  // Byte 18 of the header is 2 for a database in WAL mode.
  expect((await readFile(file))[18]).toBe(2);
  return { dir, file };
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

/** A second sqlite3 that keeps the database open, as Goose does while it runs. */
function holdOpen(file: string) {
  const child = spawn(sqlite as string, ["-init", "/dev/null", "-batch", file], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let count = 0;
  return {
    /** Writes these statements, one commit each, and waits until sqlite3 has run them. */
    async write(statements: string[]): Promise<void> {
      count += 1;
      const mark = `${file}.written-${count}`;
      child.stdin.write(`${statements.join("\n")}\n.once ${mark}\nSELECT 'done';\n`);
      const until = Date.now() + 10_000;
      for (;;) {
        const there = await stat(mark).then(
          (info) => info.size > 0,
          () => false,
        );
        if (there) break;
        if (Date.now() > until) throw new Error("sqlite3 did not write in time.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await rm(mark);
    },
    /** Ends it cleanly, so it moves its -wal into the database as it closes it, as a quit does. */
    async close(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      await gone;
    },
    /** Ends it with SIGKILL, so its -wal and -shm are left full with no writer, as a crash does. */
    async kill(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    },
  };
}

/** What the adapter's reader says of the database now, read as the adapter reads it. */
function readNow(file: string, at = Date.now()) {
  return createDatabaseReader({ file, io: nodeIo, platform: process.platform }).read(at);
}

/** What sqlite3 prints for a question of this database. */
async function printed(file: string, query: string): Promise<string> {
  const answer = await runSqlite(sqlite as string, sqliteArguments(file, "whole", query));
  expect(answer.ok).toBe(true);
  return answer.ok ? answer.stdout : "";
}

// This test decides whether the database may be read at all, so in CI, on macOS
// and Linux, it must not be skipped for want of a sqlite3. Elsewhere, as on a
// machine with sqlite3 in none of its fixed places, it is skipped.
test.runIf(Boolean(process.env.CI) && process.platform !== "win32")(
  "sqlite3 is at one of its fixed places, so the tests below run",
  () => {
    expect(sqlite).not.toBeNull();
  },
);

describe.skipIf(sqlite === null)("reading Goose's database with the real sqlite3", () => {
  test("with no -wal beside it: a session is read, and no file is made or changed", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.state).toBe("read");
    expect(read.rows).toHaveLength(1);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("held open, with commits only in the -wal: the newest is seen, and nothing is written", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const goose = holdOpen(file);
    await goose.write([sessionSql({ id: "20261001_2" })]);
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(0);

    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.rows.map(({ id }) => id).sort()).toEqual(["20261001_1", "20261001_2"]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("after a crash, with the -wal and -shm left full and no writer: the newest is seen, and nothing is written", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const goose = holdOpen(file);
    await goose.write([sessionSql({ id: "20261001_2" })]);
    await goose.kill();

    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.rows.map(({ id }) => id).sort()).toEqual(["20261001_1", "20261001_2"]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("one reader sees a commit in a -wal that kept its size after a checkpoint", async () => {
    const { file } = await makeDatabase([sessionSql()]);
    const goose = holdOpen(file);
    await goose.write([sessionSql({ id: "20261001_2" })]);
    const reader = createDatabaseReader({ file, io: nodeIo, platform: process.platform });
    expect((await reader.read(Date.now())).rows).toHaveLength(2);
    const size = (await stat(`${file}-wal`)).size;
    await goose.write(["PRAGMA wal_checkpoint(PASSIVE);", sessionSql({ id: "20261001_3" })]);
    expect((await stat(`${file}-wal`)).size).toBe(size);
    expect((await reader.read(Date.now())).rows).toHaveLength(3);
  });

  test("Goose closing the database between the look and the read leaves at most an empty -wal, and the next read works", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const goose = holdOpen(file);
    await goose.write([sessionSql({ id: "20261001_2" })]);
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(0);
    let closing = true;
    const reader = createDatabaseReader({
      file,
      io: nodeIo,
      platform: process.platform,
      async run(binary, args) {
        if (closing) {
          // Goose closes the database once the files are looked at, before
          // sqlite3 opens it: it moves its -wal into the database and removes
          // it and the -shm, which the SQLite of macOS would keep.
          closing = false;
          await goose.close();
          await rm(`${file}-wal`, { force: true });
          await rm(`${file}-shm`, { force: true });
        }
        return runSqlite(binary, args);
      },
    });
    const now = Date.now();
    await reader.read(now);
    // A sqlite3 built from SQLite's own source, as on Linux, makes an empty
    // -wal as it opens the database. The SQLite of macOS makes none.
    const left = await readdir(dir);
    expect(left.filter((name) => name !== "sessions.db-wal")).toEqual(["sessions.db"]);
    if (left.includes("sessions.db-wal")) expect((await stat(`${file}-wal`)).size).toBe(0);

    const read = await reader.read(now + 2_000);
    expect(read.state).toBe("read");
    expect(read.rows.map(({ id }) => id).sort()).toEqual(["20261001_1", "20261001_2"]);
  });

  test("an answer over the cap has failed, with the probe still answering", async () => {
    const { file } = await makeDatabase([sessionSql()]);
    const answers: boolean[] = [];
    const reader = createDatabaseReader({
      file,
      io: nodeIo,
      platform: process.platform,
      async run(binary, args) {
        const cap = args.at(-1) === SESSIONS_QUERY ? 16 : undefined;
        const answer = await runSqlite(binary, args, undefined, cap);
        answers.push(answer.ok);
        return answer;
      },
    });
    expect(await reader.read(Date.now())).toEqual({ state: "failed", rows: [] });
    expect(answers).toEqual([false, true]);
  });

  test("a database that is not there is not made", async () => {
    const dir = path.join(await tempDir(), "goose", "sessions");
    await mkdir(dir, { recursive: true });
    expect((await readNow(path.join(dir, "sessions.db"))).state).toBe("missing");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a file that is not a database has failed, and is left as it was", async () => {
    const { dir, file } = await makeDatabase([]);
    await writeFile(file, "not a database, and long enough to be read as one ".repeat(40));
    const before = await snapshotOf(dir);
    expect((await readNow(file)).state).toBe("failed");
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a database laid out as an older Goose is told from a broken one", async () => {
    const { file } = await makeDatabase([]);
    execFileSync(
      sqlite as string,
      ["-init", "/dev/null", file, "ALTER TABLE sessions DROP COLUMN archived_at"],
      { stdio: "ignore" },
    );
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    expect((await readNow(file)).state).toBe("unsupported");
  });

  test("a link at the database's name is not followed", async () => {
    const { file: real } = await makeDatabase([sessionSql()]);
    const dir = path.join(await tempDir(), "goose", "sessions");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "sessions.db");
    await symlink(real, file);
    expect(await readNow(file)).toEqual({ state: "not-safe", rows: [] });
  });

  test("a link in place of the sessions folder or the data folder is not followed", async () => {
    const { dir: real } = await makeDatabase([sessionSql()]);
    const home = path.join(await tempDir(), "goose");
    await mkdir(home);
    await symlink(real, path.join(home, "sessions"));
    expect(await readNow(path.join(home, "sessions", "sessions.db"))).toEqual({
      state: "not-safe",
      rows: [],
    });

    const linked = path.join(await tempDir(), "goose");
    await symlink(path.dirname(real), linked);
    expect(await readNow(path.join(linked, "sessions", "sessions.db"))).toEqual({
      state: "not-safe",
      rows: [],
    });
  });

  test("a -wal that is a link is not read", async () => {
    const { file } = await makeDatabase([sessionSql()]);
    await symlink(path.join(await tempDir(), "elsewhere"), `${file}-wal`);
    expect((await readNow(file)).state).toBe("not-safe");
  });

  describe("what is asked for", () => {
    test("is the sessions Goose lists to people, and no other", async () => {
      const { file } = await makeDatabase([
        sessionSql({ id: "20261001_1", sessionType: "user" }),
        sessionSql({ id: "20261001_2", sessionType: "scheduled" }),
        sessionSql({ id: "20261001_3", sessionType: "acp" }),
        sessionSql({ id: "20261001_4", sessionType: "sub_agent" }),
        sessionSql({ id: "20261001_5", sessionType: "hidden" }),
        sessionSql({ id: "20261001_6", sessionType: "terminal" }),
        sessionSql({ id: "20261001_7", sessionType: "gateway" }),
        sessionSql({ id: "20261001_8", archivedAt: "datetime('now')" }),
        sessionSql({
          id: "20261001_9",
          updatedAt: "datetime('now', '-49 hours')",
        }),
      ]);
      const read = await readNow(file);
      expect(read.rows.map(({ id }) => id).sort()).toEqual([
        "20261001_1",
        "20261001_2",
        "20261001_3",
      ]);
    });

    test("leaves out a session with no message, as Goose's ACP list does, though `goose session list` shows one", async () => {
      const { file } = await makeDatabase([
        sessionSql(),
        sessionSql({ id: "20261001_2" }),
        "DELETE FROM messages WHERE session_id = '20261001_2';",
      ]);
      expect((await readNow(file)).rows.map(({ id }) => id)).toEqual(["20261001_1"]);
    });

    test("prints a name only where the person set it, and nothing of a prompt, a setting or a count", async () => {
      const { file } = await makeDatabase([
        sessionSql({ id: "20261001_1" }),
        sessionSql({ id: "20261001_2", name: "Release notes", userSetName: true }),
      ]);
      const answer = await printed(file, SESSIONS_QUERY);
      expect(answer).toContain("Release notes");
      expect(answer).not.toContain(PRIVATE_TITLE);
      expect(answer).not.toContain(PRIVATE_WORDS);
      expect(answer).not.toContain("demo-provider");
      expect(answer).not.toContain("1234");
      for (const row of JSON.parse(answer) as Record<string, unknown>[]) {
        expect(Object.keys(row).sort()).toEqual([
          "created_s",
          "id",
          "own_name",
          "updated_s",
          "working_dir",
        ]);
      }
    });

    test("the probe prints only names of tables and columns", async () => {
      const { file } = await makeDatabase([sessionSql()]);
      const answer = await printed(file, PROBE_QUERY);
      expect(answer).toContain("working_dir");
      expect(answer).not.toContain(PRIVATE_TITLE);
      expect(answer).not.toContain(PRIVATE_WORDS);
    });

    test("reads a time as Goose writes it and as an old import keeps it", async () => {
      const { file } = await makeDatabase([
        sessionSql({
          id: "20261001_1",
          createdAt: "'2026-10-01 10:00:00'",
          updatedAt: "datetime('now', '-1 hours')",
        }),
        sessionSql({
          id: "20261001_2",
          createdAt: "'2026-10-01T10:00:00+00:00'",
          updatedAt: "strftime('%Y-%m-%dT%H:%M:%S.123456+00:00', 'now', '-1 hours')",
        }),
      ]);
      const read = await readNow(file);
      const hourAgo = Date.now() - HOUR;
      expect(read.rows).toHaveLength(2);
      for (const row of read.rows) {
        expect(row.createdAt).toBe(Date.UTC(2026, 9, 1, 10));
        expect(Math.abs((row.updatedAt ?? 0) - hourAgo)).toBeLessThan(60_000);
      }
    });

    test("a value of the wrong type is taken as none, and the rest of the row stands", async () => {
      const { file } = await makeDatabase([
        sessionSql({
          createdAt: "'not a time'",
          updatedAt: "datetime('now', '-1 minutes')",
          workingDir: "relative/folder",
        }),
        sessionSql({ id: "20261001_2", updatedAt: "datetime('now')" }),
        "UPDATE sessions SET name = 7, user_set_name = 1 WHERE id = '20261001_2';",
        "UPDATE sessions SET working_dir = x'00ff' WHERE id = '20261001_2';",
      ]);
      const read = await readNow(file);
      expect(read.state).toBe("read");
      const [second, first] = read.rows;
      expect(first).toMatchObject({ id: "20261001_1", folder: null, createdAt: null });
      expect(first?.updatedAt).not.toBeNull();
      expect(second).toMatchObject({ id: "20261001_2", folder: null });
    });

    test("is the newest 200, with folders and names cut inside SQLite, however large the database", async () => {
      const long = "x".repeat(100_000);
      const rows = Array.from({ length: MAX_SESSIONS + 5 }, (_, index) =>
        sessionSql({
          id: `20261001_${index + 1}`,
          name: long,
          userSetName: true,
          workingDir: `/${long}`,
          updatedAt: `datetime('now', '-${MAX_SESSIONS + 5 - index} minutes')`,
        }),
      );
      const { file } = await makeDatabase(rows);
      expect((await stat(file)).size).toBeGreaterThan(20_000_000);

      const answer = await printed(file, SESSIONS_QUERY);
      expect(answer.length).toBeLessThan(MAX_OUTPUT_BYTES);
      const read = await readNow(file);
      expect(read.state).toBe("read");
      expect(read.rows).toHaveLength(MAX_SESSIONS);
      expect(read.rows[0]?.id).toBe(`20261001_${MAX_SESSIONS + 5}`);
      expect(read.rows.every(({ folder }) => folder === null)).toBe(true);
      expect(read.rows[0]?.ownName).toHaveLength(1000);
    }, 30_000);

    test("walks the sessions by Goose's index of their last write, so it stops at the newest 200", async () => {
      const { file } = await makeDatabase([sessionSql()]);
      const plan = await printed(file, `EXPLAIN QUERY PLAN ${SESSIONS_QUERY}`);
      expect(plan).toContain("idx_sessions_updated");
      expect(plan).not.toContain("TEMP B-TREE");
    });

    test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
      const { dir, file } = await makeDatabase([sessionSql()]);
      const goose = path.dirname(dir);
      const moved = path.join(path.dirname(goose), "a dir? 100%", "goose");
      await mkdir(path.dirname(moved), { recursive: true });
      await rename(goose, moved);
      const read = await readNow(path.join(moved, "sessions", path.basename(file)));
      expect(read.state).toBe("read");
      expect(read.rows[0]?.folder).toBe(PROJECT);
    });
  });
});
