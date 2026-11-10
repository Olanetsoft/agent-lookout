import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  findSqlite,
  MAX_OUTPUT_BYTES,
  runSqlite,
  TRUSTED_SCHEMA_OFF,
  type RunSqlite,
} from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/crush/database";
import { databaseOf } from "@collector/adapters/crush/projects";
import { MAX_SESSIONS, PROBE_QUERY, SESSIONS_QUERY } from "@collector/adapters/crush/sessionRows";
import { sqliteArguments, sqliteUri } from "@collector/adapters/opencode/sessionRows";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  OTHER_SESSION_ID,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  SCHEMA,
  SESSION_ID,
  sessionSql,
} from "@tests/fixtures/crush/crush";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a database this test
// writes with that same sqlite3, laid out as Crush v0.99.0's is. What Crush saves
// lies in the database's -wal file, and a second sqlite3, kept open as Crush keeps
// its database open, stands in for it here. Where there is no sqlite3, as on
// Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

/** A project with its database, in WAL mode, holding these rows, and nothing beside it. */
async function makeDatabase(
  rows: string[],
  parent?: string,
): Promise<{ folder: string; dir: string; file: string }> {
  const folder = path.join(parent ?? (await tempDir()), "demo-project");
  const dir = path.join(folder, ".crush");
  const file = databaseOf(folder);
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
  return { folder, dir, file };
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

/** A second sqlite3 that keeps the database open, as Crush does while it runs. */
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

describe.skipIf(sqlite === null)("reading a Crush database with the real sqlite3", () => {
  test("with no -wal beside it: a session is read, and no file is made or changed", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.state).toBe("read");
    expect(read.rows.map(({ id }) => id)).toEqual([SESSION_ID]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("held open, with commits only in the -wal: the newest is seen, and nothing is written", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const crush = holdOpen(file);
    await crush.write([sessionSql({ id: OTHER_SESSION_ID })]);
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(0);

    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.rows.map(({ id }) => id).sort()).toEqual([SESSION_ID, OTHER_SESSION_ID].sort());
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("after a crash, with the -wal and -shm left full and no writer: the newest is seen, and nothing is written", async () => {
    const { dir, file } = await makeDatabase([sessionSql()]);
    const crush = holdOpen(file);
    await crush.write([sessionSql({ id: OTHER_SESSION_ID })]);
    await crush.kill();

    const before = await snapshotOf(dir);
    const read = await readNow(file);
    expect(read.rows.map(({ id }) => id).sort()).toEqual([SESSION_ID, OTHER_SESSION_ID].sort());
    expect(await snapshotOf(dir)).toEqual(before);
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

  test("a project with no database has none made", async () => {
    const dir = path.join(await tempDir(), "demo-project", ".crush");
    await mkdir(dir, { recursive: true });
    expect((await readNow(path.join(dir, "crush.db"))).state).toBe("missing");
    expect(await readdir(dir)).toEqual([]);
  });

  test("a project that has gone is nothing to read, and nothing is made", async () => {
    const parent = await tempDir();
    const file = databaseOf(path.join(parent, "gone"));
    expect((await readNow(file)).state).toBe("missing");
    expect(await readdir(parent)).toEqual([]);
  });

  test("a file that is not a database has failed, and is left as it was", async () => {
    const { dir, file } = await makeDatabase([]);
    await writeFile(file, "not a database, and long enough to be read as one ".repeat(40));
    const before = await snapshotOf(dir);
    expect((await readNow(file)).state).toBe("failed");
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a database laid out another way is told from a broken one", async () => {
    const { file } = await makeDatabase([]);
    execFileSync(
      sqlite as string,
      ["-init", "/dev/null", file, "ALTER TABLE sessions RENAME COLUMN message_count TO messages"],
      { stdio: "ignore" },
    );
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    expect((await readNow(file)).state).toBe("unsupported");
  });

  test("a link at the database's name is not followed", async () => {
    const { file: real } = await makeDatabase([sessionSql()]);
    const dir = path.join(await tempDir(), "demo-project", ".crush");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "crush.db");
    await symlink(real, file);
    expect(await readNow(file)).toEqual({ state: "not-safe", rows: [] });
  });

  test("a link in place of .crush or of the project's folder is not followed", async () => {
    const { dir: real, folder } = await makeDatabase([sessionSql()]);
    const project = path.join(await tempDir(), "demo-project");
    await mkdir(project);
    await symlink(real, path.join(project, ".crush"));
    expect(await readNow(databaseOf(project))).toEqual({ state: "not-safe", rows: [] });

    const linked = path.join(await tempDir(), "demo-project");
    await symlink(folder, linked);
    expect(await readNow(databaseOf(linked))).toEqual({ state: "not-safe", rows: [] });
  });

  test("a -wal that is a link is not read", async () => {
    const { file } = await makeDatabase([sessionSql()]);
    await symlink(path.join(await tempDir(), "elsewhere"), `${file}-wal`);
    expect((await readNow(file)).state).toBe("not-safe");
  });

  test("a folder above the project may be reached by a link: the list could name the place anyway", async () => {
    const parent = await tempDir();
    const { file } = await makeDatabase([sessionSql()], parent);
    const link = path.join(await tempDir(), "linked");
    await symlink(parent, link);
    const through = path.join(link, path.relative(parent, file));
    expect((await readNow(through)).state).toBe("read");
  });

  test("a database no one wrote for two days is not read at all", async () => {
    const { file } = await makeDatabase([sessionSql()]);
    const longAgo = new Date(Date.now() - 49 * 60 * 60 * 1000);
    await utimes(file, longAgo, longAgo);
    const runs: (readonly string[])[] = [];
    const reader = createDatabaseReader({
      file,
      io: nodeIo,
      platform: process.platform,
      async run(binary, args) {
        runs.push(args);
        return runSqlite(binary, args);
      },
    });
    expect(await reader.read(Date.now())).toEqual({ state: "read", rows: [] });
    expect(runs).toEqual([]);
  });

  describe("a database a repository ships", () => {
    /** What an `sqlite3` older than 3.42 does for itself: trusts what a database's schema calls. */
    const trustingSchema: RunSqlite = (binary, args, timeoutMs) =>
      runSqlite(binary, ["-cmd", ".dbconfig trusted_schema on", ...args], timeoutMs);

    /** A project whose `sessions` is a view that calls `edit()`, and the file its command makes. */
    async function hostileProject(): Promise<{ file: string; marker: string }> {
      const marker = path.join(await tempDir(), "the-command-ran");
      const { file } = await makeDatabase([
        "DROP TABLE messages;",
        "DROP TABLE sessions;",
        `CREATE VIEW sessions AS SELECT edit('x', 'touch ${marker}') AS id, NULL AS parent_session_id,
          1 AS message_count, 1 AS created_at, strftime('%s', 'now') AS updated_at;`,
      ]);
      return { file, marker };
    }

    /** Arguments with the setting every read is given taken out again, which no read of the app's has. */
    const withoutTheSetting = (args: readonly string[]) =>
      args.filter((arg, at) => arg !== TRUSTED_SCHEMA_OFF && args[at + 1] !== TRUSTED_SCHEMA_OFF);

    const isThere = (file: string) =>
      stat(file).then(
        () => true,
        () => false,
      );

    // The setting comes from the arguments all the agents' reads share, so one
    // database stands for them all, opened by each of the two addresses in use.
    test.each(["whole", "with-wal"] as const)(
      "cannot run a command through a view, where sqlite3 would trust it, opened %s",
      async (mode) => {
        /** Leaves a commit in the database's -wal, for the address that reads one. */
        const prepare = async (file: string) => {
          if (mode === "with-wal") await holdOpen(file).write(["CREATE TABLE later (id TEXT);"]);
        };

        // Without the setting, the command runs, so this proves something.
        const trusted = await hostileProject();
        await prepare(trusted.file);
        await trustingSchema(
          sqlite as string,
          withoutTheSetting(sqliteArguments(trusted.file, mode, SESSIONS_QUERY)),
        );
        expect(await isThere(trusted.marker)).toBe(true);

        const { file, marker } = await hostileProject();
        await prepare(file);
        const runs: (readonly string[])[] = [];
        const reader = createDatabaseReader({
          file,
          io: nodeIo,
          platform: process.platform,
          run(binary, args, timeoutMs) {
            runs.push(args);
            return trustingSchema(binary, args, timeoutMs);
          },
        });
        expect((await reader.read(Date.now())).rows).toEqual([]);
        expect(runs[0]).toContain(sqliteUri(file, mode));
        expect(await isThere(marker)).toBe(false);
      },
    );
  });

  describe("what is asked for", () => {
    test("is the recent sessions with a message, of those Crush lists to people, and no other", async () => {
      const { file } = await makeDatabase([
        sessionSql(),
        sessionSql({ id: "message$$call" }),
        sessionSql({ id: "subagent", parent: SESSION_ID }),
        sessionSql({ id: "no-message", message: false }),
        sessionSql({ id: "old", updatedAt: "strftime('%s', 'now') - 49 * 3600" }),
      ]);
      const read = await readNow(file);
      expect(read.state).toBe("read");
      // `message$$call` has no parent here only to show that its id alone drops it.
      expect(read.rows.map(({ id }) => id)).toEqual([SESSION_ID]);
    });

    test("prints an id and two times, and nothing of a prompt, a setting or a count", async () => {
      const { file } = await makeDatabase([
        sessionSql(),
        "UPDATE sessions SET prompt_tokens = 1234, completion_tokens = 1234, cost = 12.34;",
      ]);
      const answer = await printed(file, SESSIONS_QUERY);
      expect(answer).not.toContain(PRIVATE_TITLE);
      expect(answer).not.toContain(PRIVATE_WORDS);
      expect(answer).not.toContain("demo-provider");
      expect(answer).not.toContain("1234");
      for (const row of JSON.parse(answer) as Record<string, unknown>[]) {
        expect(Object.keys(row).sort()).toEqual(["created_at", "id", "updated_at"]);
      }
    });

    test("the probe prints only names of a table and its columns", async () => {
      const { file } = await makeDatabase([sessionSql()]);
      const answer = await printed(file, PROBE_QUERY);
      expect(answer).toContain("parent_session_id");
      expect(answer).not.toContain(PRIVATE_TITLE);
      expect(answer).not.toContain(PRIVATE_WORDS);
    });

    test("reads a time as Crush writes it: whole seconds, moved by its triggers on any write", async () => {
      const { file } = await makeDatabase([
        sessionSql({ updatedAt: "strftime('%s', 'now') - 3600" }),
        sessionSql({
          id: OTHER_SESSION_ID,
          updatedAt: "strftime('%s', 'now') - 3600",
        }),
        // A rename, which only sets the title, as `RenameSession` does.
        `UPDATE sessions SET title = 'renamed' WHERE id = '${OTHER_SESSION_ID}';`,
      ]);
      const read = await readNow(file);
      const hourAgo = Date.now() - 60 * 60 * 1000;
      const [renamed, other] = read.rows;
      expect(renamed?.id).toBe(OTHER_SESSION_ID);
      expect(Math.abs((renamed?.updatedAt ?? 0) - Date.now())).toBeLessThan(60_000);
      expect(Math.abs((other?.updatedAt ?? 0) - hourAgo)).toBeLessThan(60_000);
      expect(Math.abs((other?.createdAt ?? 0) - hourAgo)).toBeLessThan(60_000);
    });

    test("a value of the wrong type is taken as none, and the rest of the row stands", async () => {
      const { file } = await makeDatabase([
        sessionSql({ createdAt: "'not a time'" }),
        sessionSql({ id: OTHER_SESSION_ID, updatedAt: "'not a time'" }),
      ]);
      const read = await readNow(file);
      expect(read.state).toBe("read");
      const byId = new Map(read.rows.map((row) => [row.id, row]));
      expect(byId.get(SESSION_ID)?.createdAt).toBeNull();
      expect(byId.get(SESSION_ID)?.updatedAt).not.toBeNull();
      expect(byId.get(OTHER_SESSION_ID)?.updatedAt).toBeNull();
    });

    test("is the newest 200, however large the database, with a long id cut inside SQLite", async () => {
      const long = "x".repeat(100_000);
      const rows = Array.from({ length: MAX_SESSIONS + 5 }, (_, index) =>
        sessionSql({
          id: `session-${index + 1}`,
          title: long,
          updatedAt: `strftime('%s', 'now') - ${60 * (MAX_SESSIONS + 5 - index)}`,
        }),
      );
      const { file } = await makeDatabase([
        ...rows,
        sessionSql({ id: "y".repeat(100_000), updatedAt: "strftime('%s', 'now')" }),
      ]);
      expect((await stat(file)).size).toBeGreaterThan(20_000_000);

      const answer = await printed(file, SESSIONS_QUERY);
      expect(answer.length).toBeLessThan(MAX_OUTPUT_BYTES);
      expect(answer).not.toContain("y".repeat(130));
      const read = await readNow(file);
      expect(read.state).toBe("read");
      // The row with the long id is one of the 200, and is dropped.
      expect(read.rows).toHaveLength(MAX_SESSIONS - 1);
      expect(read.rows[0]?.id).toBe(`session-${MAX_SESSIONS + 5}`);
    }, 30_000);

    test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
      const parent = path.join(await tempDir(), "a dir? 100%");
      await mkdir(parent);
      const { file } = await makeDatabase([sessionSql()], parent);
      const read = await readNow(file);
      expect(read.state).toBe("read");
      expect(read.rows).toHaveLength(1);
    });
  });
});
