import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { runSqlite, type RunSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader, RETRY_MS } from "@collector/adapters/hermes-agent/database";
import {
  PROBE_QUERY,
  SESSIONS_QUERY,
  sqliteArguments,
  type DatabaseMode,
} from "@collector/adapters/hermes-agent/sessionRows";
import { createSqliteFinder, type SqliteFinder } from "@collector/adapters/hermes-agent/sqlite";
import { chainsOf, hermesAgentSession } from "@collector/adapters/hermes-agent/toSession";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  APPROVAL_LABEL,
  leaseRow,
  messageRow,
  MINUTE,
  PRIVATE_WORDS,
  SCENE,
  SCHEMA,
  sceneRows,
  SECRET_WORDS,
  sessionId,
  sessionRow,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on databases this test
// writes with that same sqlite3, laid out as Hermes Agent v0.22.5's are: one
// in rollback-journal mode, one in WAL mode with nothing in a -wal, and one in
// WAL mode whose newest commits lie only in the -wal of a second sqlite3 that
// keeps it open, as Hermes Agent's gateway does while it runs. This is the
// test that says Agent Lookout may read the database at all: it must see the
// newest commit, and leave every byte, size and modified time of the database,
// its -wal and its -shm as they were. Where there is no sqlite3, as on
// Windows, there is nothing to run.

/** The first sqlite3 at the adapter's fixed places, or null. */
const sqlite = await (async () => {
  if (process.platform === "win32") return null;
  const picked = await createSqliteFinder().pick("any");
  return picked.kind === "found" ? picked.path : null;
})();

/**
 * A finder that takes the first sqlite3 found for every database, so the
 * tests of what sqlite3 does run on every machine, whatever its version. The
 * adapter's own finder, with Hermes Agent's test of the version, is used in
 * the test of a live -wal that says so.
 */
const anySqlite: SqliteFinder = {
  pick: async () => ({ kind: "found", path: sqlite as string, version: null }),
  lastWalSafe: () => null,
};

/**
 * Put first in every sqlite3 this test runs to write a database: sqlite3 runs
 * the person's own ~/.sqliterc otherwise, found from the account whatever HOME
 * says, and no test reads the real home.
 */
const NO_INIT = ["-init", "/dev/null"];

/** The first bytes of a rollback journal SQLite has synced, which make it hot once its writer is gone. */
const JOURNAL_MAGIC = "d9d505f920a163d7";

/** The names of the columns the sessions query prints, and nothing else. */
const PRINTED = [
  "root_id",
  "id",
  "root_source",
  "root_created_source",
  "root_started_at",
  "root_title",
  "root_cwd",
  "started_at",
  "ended_at",
  "end_reason",
  "last_activity_at",
  "last_message_at",
  "title",
  "cwd",
  "approval_label",
  "question_label",
  "n_role",
  "n_at",
  "n_kind",
  "n_finish",
  "n_error",
  "calls_at",
  "open_questions",
  "open_calls",
  "lease_at",
  "lease_until",
  "lease_pid",
  "lease_pidns",
];

/** The conversations the scene lists, by their roots' ids. */
const LISTED = [
  SCENE.chainRoot,
  SCENE.question,
  SCENE.approval,
  SCENE.failed,
  SCENE.finished,
  SCENE.branch,
  SCENE.cron,
  SCENE.resetParent,
  SCENE.resetChild,
  SCENE.filtered,
  SCENE.deadHolder,
];

/** Those it leaves out, and the row a compressed conversation went on in, which is never a root. */
const LEFT_OUT = [
  SCENE.chainTip,
  SCENE.delegate,
  SCENE.hidden,
  SCENE.archived,
  SCENE.tool,
  SCENE.kanban,
  SCENE.oneshot,
  SCENE.old,
];

/**
 * A profile's database in a folder of its own, in this journal mode, with
 * these rows, and nothing beside it.
 */
async function makeDatabase(
  mode: "rollback" | "wal",
  rows: string[],
): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "hermes");
  const file = path.join(dir, "state.db");
  await mkdir(dir, { recursive: true });
  const journal = mode === "wal" ? "PRAGMA journal_mode=WAL;" : "PRAGMA journal_mode=DELETE;";
  execFileSync(sqlite as string, [...NO_INIT, file, [journal, SCHEMA, ...rows].join("\n")]);
  // The SQLite of macOS keeps the two files once the database is closed; others remove them.
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  // Bytes 18 and 19 of the header are 1 and 1 in rollback-journal mode, 2 and 2 in WAL mode.
  const header = await readFile(file);
  expect([header[18], header[19]]).toEqual(mode === "wal" ? [2, 2] : [1, 1]);
  expect(await readdir(dir)).toEqual(["state.db"]);
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

/**
 * A second sqlite3 that opens the database and keeps it open, as Hermes
 * Agent's gateway does while it runs, writing what it is given. It never
 * closes on its own.
 */
function holdOpen(file: string, marks: string) {
  const child: ChildProcess = spawn(sqlite as string, [...NO_INIT, "-batch", file], {
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
      const mark = path.join(marks, `written-${count}`);
      // `.once` sends the next answer to a file and closes it, so it is there whole once written.
      child.stdin?.write(
        `PRAGMA busy_timeout = 5000;\n${statements.join("\n")}\n.once ${mark}\nSELECT 'done';\n`,
      );
      const until = Date.now() + 10_000;
      for (;;) {
        const there = await stat(mark).then(
          (info) => info.size > 0,
          () => false,
        );
        if (there) return;
        if (Date.now() > until) throw new Error("sqlite3 did not write in time.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    /** Kills it at once, as a crash would, with whatever it was writing left half done. */
    async crash(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    },
    /** Ends it cleanly, so it moves its -wal into the database as it closes it. */
    async close(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.stdin?.end();
      await gone;
    },
  };
}

/** The adapter's reader on this database, with the sqlite3 this finder gives, and every argument list it ran. */
function readerFor(file: string, finder: SqliteFinder = anySqlite, run: RunSqlite = runSqlite) {
  const runs: (readonly string[])[] = [];
  const reader = createDatabaseReader({
    file,
    io: nodeIo,
    platform: process.platform,
    finder,
    run: (binary, args, timeoutMs) => (runs.push(args), run(binary, args, timeoutMs)),
  });
  return { reader, runs };
}

/** What sqlite3 prints for both questions, opened this way. */
async function answers(file: string, mode: DatabaseMode): Promise<string> {
  let printed = "";
  for (const query of [PROBE_QUERY, SESSIONS_QUERY]) {
    const answer = await runSqlite(sqlite as string, sqliteArguments(file, mode, query));
    expect(answer.ok, query).toBe(true);
    if (answer.ok) printed += answer.stdout;
  }
  return printed;
}

/** The rows the sessions query prints, opened this way. */
async function printedRows(file: string, mode: DatabaseMode): Promise<Record<string, unknown>[]> {
  const answer = await runSqlite(sqlite as string, sqliteArguments(file, mode, SESSIONS_QUERY));
  expect(answer.ok).toBe(true);
  return answer.ok && answer.stdout.trim() !== "" ? JSON.parse(answer.stdout) : [];
}

/** The roots read, and what was printed: nothing planted is ever in it. */
function expectScene(rows: readonly { rootId: string; id: string }[]) {
  expect(new Set(rows.map((row) => row.rootId))).toEqual(new Set(LISTED));
  const ids = rows.map((row) => row.id);
  // Of the compressed conversation, both its rows, under the one root.
  expect(
    rows
      .filter((row) => row.rootId === SCENE.chainRoot)
      .map((row) => row.id)
      .sort(),
  ).toEqual([SCENE.chainRoot, SCENE.chainTip].sort());
  for (const out of LEFT_OUT.filter((id) => id !== SCENE.chainTip)) expect(ids).not.toContain(out);
}

const NEW = sessionId("e9");

/** A conversation begun now, as Hermes Agent's gateway writes one. */
function begun(now: number): string[] {
  return [
    sessionRow({ id: NEW, title: "Begun just now", startedAt: now - MINUTE }),
    messageRow({ sessionId: NEW, role: "user", at: now - 30_000 }),
  ];
}

// This test decides whether the database may be read at all, so in CI, on
// macOS and Linux, it must not be skipped for want of a sqlite3. Elsewhere,
// as on a machine with sqlite3 in none of its fixed places, it is skipped.
test.runIf(Boolean(process.env.CI) && process.platform !== "win32")(
  "sqlite3 is at one of its fixed places, so the tests below run",
  () => {
    expect(sqlite).not.toBeNull();
  },
);

describe.skipIf(sqlite === null)("reading Hermes Agent's database with the real sqlite3", () => {
  test("in rollback-journal mode: every conversation is read, with a second's wait, and no file is made or changed", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("rollback", sceneRows(now));
    const before = await snapshotOf(dir);

    const { reader, runs } = readerFor(file);
    const read = await reader.read(now);
    expect(read.state).toBe("read");
    expectScene(read.rows);
    expect(runs.every((args) => args.includes(".timeout 1000"))).toBe(true);
    expect(await snapshotOf(dir)).toEqual(before);

    const printed = await answers(file, "rollback");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    for (const row of await printedRows(file, "rollback")) {
      expect(Object.keys(row)).toEqual(PRINTED);
    }
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("in WAL mode with no -wal: read as a file nothing changes, and no file is made or changed", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("wal", sceneRows(now));
    const before = await snapshotOf(dir);
    const { reader, runs } = readerFor(file);
    const read = await reader.read(now);
    expect(read.state).toBe("read");
    expectScene(read.rows);
    expect(runs.every((args) => args.some((arg) => arg.endsWith("?mode=ro&immutable=1")))).toBe(
      true,
    );
    expect(await snapshotOf(dir)).toEqual(before);

    const printed = await answers(file, "whole");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("held open, with commits only in the -wal: the newest is seen, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("wal", sceneRows(now));
    const writer = holdOpen(file, await tempDir());
    // A new conversation, then the question it asks, each a commit of its own,
    // far below the thousand pages at which SQLite moves the -wal into the database.
    await writer.write(begun(now));
    await writer.write([
      `UPDATE sessions SET last_activity_description = 'waiting for user approval (10s elapsed) ${PRIVATE_WORDS}' WHERE id = '${NEW}';`,
    ]);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);

    // Read as a file nothing changes, the database is as it was before the writer began.
    const immutable = await runSqlite(
      sqlite as string,
      sqliteArguments(file, "whole", SESSIONS_QUERY),
    );
    expect(immutable.ok).toBe(true);
    if (immutable.ok) expect(immutable.stdout).not.toContain(NEW);
    expect(await snapshotOf(dir)).toEqual(before);

    // Read as the adapter reads it, every commit is seen.
    const { reader, runs } = readerFor(file);
    const read = await reader.read(now);
    expect(read.state).toBe("read");
    expect(read.rows.find((row) => row.id === NEW)).toMatchObject({
      title: "Begun just now",
      approvalLabel: 1,
      newest: { role: "user" },
    });
    expect(runs.every((args) => args.some((arg) => arg.endsWith("?mode=ro&readonly_shm=1")))).toBe(
      true,
    );
    expect(runs.every((args) => !args.includes("-cmd"))).toBe(true);
    expect(await snapshotOf(dir)).toEqual(before);

    const printed = await answers(file, "with-wal");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("held open, with commits only in the -wal, the adapter's own choice of sqlite3 reads it only with one that passes Hermes Agent's test, and otherwise runs nothing on it", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("wal", sceneRows(now));
    const writer = holdOpen(file, await tempDir());
    await writer.write(begun(now));
    const before = await snapshotOf(dir);

    const finder = createSqliteFinder();
    const wanted = await createSqliteFinder().pick("wal-safe");
    const { reader, runs } = readerFor(file, finder);
    const read = await reader.read(now);
    if (wanted.kind === "found") {
      expect(read.state).toBe("read");
      expect(read.rows.map((row) => row.id)).toContain(NEW);
      expect(runs).toHaveLength(2);
    } else {
      // As on a Linux whose sqlite3 has the WAL-reset bug, as Ubuntu's does.
      expect(wanted.kind).toBe("vulnerable");
      expect(read).toEqual({
        state: "vulnerable-sqlite",
        rows: [],
        vulnerable: { path: sqlite, version: expect.any(Array) },
      });
      expect(runs).toEqual([]);
    }
    expect(finder.lastWalSafe()).toEqual(wanted);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a database Hermes Agent switches to WAL mode between the look at its header and the read is read, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("rollback", sceneRows(now));
    const writer = holdOpen(file, await tempDir());
    let switched: Record<string, string> | null = null;
    const { reader, runs } = readerFor(file, anySqlite, async (binary, args) => {
      if (switched === null) {
        // The header said rollback-journal mode. Before sqlite3 opens it,
        // Hermes Agent switches it to WAL mode and commits into the -wal,
        // keeping it open, so the -wal and -shm are there.
        await writer.write(["PRAGMA journal_mode=WAL;", ...begun(now)]);
        switched = await snapshotOf(dir);
        expect(Object.keys(switched)).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
      }
      return runSqlite(binary, args);
    });
    const read = await reader.read(now);
    // Opened as for rollback-journal mode, with readonly_shm=1 too, so its -shm is opened read-only.
    expect(runs[0]).toContain(".timeout 1000");
    expect(runs.every((args) => args.some((arg) => arg.endsWith("?mode=ro&readonly_shm=1")))).toBe(
      true,
    );
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toContain(NEW);
    expect(await snapshotOf(dir)).toEqual(switched);

    // The next read sees the new header, and opens it as WAL mode with its -wal.
    const again = readerFor(file);
    expect((await again.reader.read(now)).state).toBe("read");
    expect(again.runs.every((args) => !args.includes("-cmd"))).toBe(true);
    expect(await snapshotOf(dir)).toEqual(switched);
  });

  test("a program closing the database between the look and the read leaves at most an empty -wal, and the next read works", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("wal", sceneRows(now));
    const writer = holdOpen(file, await tempDir());
    await writer.write(begun(now));
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);
    let closing = true;
    const { reader } = readerFor(file, anySqlite, async (binary, args) => {
      if (closing) {
        // The writer closes the database once the files are looked at, before
        // sqlite3 opens it: it moves its -wal into the database and removes
        // it and the -shm, which the SQLite of macOS would keep.
        closing = false;
        await writer.close();
        await rm(`${file}-wal`, { force: true });
        await rm(`${file}-shm`, { force: true });
      }
      return runSqlite(binary, args);
    });
    await reader.read(now);
    // A sqlite3 built from SQLite's own source, as on Linux, makes an empty
    // -wal as it opens the database. The SQLite of macOS makes none.
    const left = await readdir(dir);
    expect(left.filter((name) => name !== "state.db-wal")).toEqual(["state.db"]);
    if (left.includes("state.db-wal")) expect((await lstat(`${file}-wal`)).size).toBe(0);

    const before = await snapshotOf(dir);
    const read = await reader.read(now + 2_000);
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toContain(NEW);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a hot -journal left by a write that crashed in rollback-journal mode is left as it is: the read fails, is tried again ten seconds on, and no file is made or changed", async () => {
    const now = Date.now();
    // A table the adapter never reads, filled so a write to it is far larger than the writer's cache.
    const filler =
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) INSERT INTO messages_fts SELECT hex(randomblob(200)) FROM n;";
    const { dir, file } = await makeDatabase("rollback", [...sceneRows(now), filler]);
    // Hermes Agent begins a write too large for its cache, so SQLite syncs the
    // journal and writes changed pages into state.db before the commit, and
    // is killed before it commits or rolls back.
    const writer = holdOpen(file, await tempDir());
    await writer.write([
      "PRAGMA cache_size = 10;",
      "PRAGMA cache_spill = 1;",
      "BEGIN;",
      "UPDATE sessions SET title = 'Half written';",
      "UPDATE messages_fts SET content = content || 'x';",
    ]);
    await writer.crash();
    // The journal is hot: synced, and no process holds the database.
    expect((await readFile(`${file}-journal`)).subarray(0, 8).toString("hex")).toBe(JOURNAL_MAGIC);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["state.db", "state.db-journal"]);

    // Only a connection that may write can roll a hot journal back. sqlite3,
    // opened read-only, refuses to read rather than read pages the crashed
    // write left half changed.
    const { reader, runs } = readerFor(file);
    expect(await reader.read(now)).toEqual({ state: "failed", rows: [] });
    expect(runs).toEqual([sqliteArguments(file, "rollback", PROBE_QUERY)]);
    expect(await snapshotOf(dir)).toEqual(before);
    // Nothing changed, so it is not asked again until ten seconds on, and then fails the same way.
    expect((await reader.read(now + 1_000)).state).toBe("failed");
    expect(runs).toHaveLength(1);
    expect((await reader.read(now + RETRY_MS)).state).toBe("failed");
    expect(runs).toHaveLength(2);
    expect(await snapshotOf(dir)).toEqual(before);

    // Once Hermes Agent opens it again, which rolls the journal back, it is read as it was before the write.
    execFileSync(sqlite as string, [...NO_INIT, file, "SELECT count(*) FROM sessions;"]);
    expect(await readdir(dir)).toEqual(["state.db"]);
    const read = await reader.read(now + RETRY_MS + 1_000);
    expect(read.state).toBe("read");
    expectScene(read.rows);
    expect(read.rows.map((row) => row.title)).not.toContain("Half written");
  });

  test("of a database laid out before v0.21.6, the probe says so, the sessions are not asked for, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("rollback", [
      ...sceneRows(now),
      "ALTER TABLE sessions DROP COLUMN created_source;",
    ]);
    const before = await snapshotOf(dir);
    const { reader, runs } = readerFor(file);
    expect(await reader.read(now)).toEqual({ state: "unsupported", rows: [] });
    expect(runs.map((args) => args.at(-1))).toEqual([PROBE_QUERY]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("titles and folders far longer than are kept are cut inside SQLite, so they cannot fill the answer", async () => {
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (_, index) => sessionId(`l${index}`));
    // Each title and folder is 400,000 characters long, far past the 4 MiB sqlite3 may print in all.
    const { file } = await makeDatabase("rollback", [
      ...ids.map((id) => sessionRow({ id, startedAt: now - MINUTE })),
      "UPDATE sessions SET title = hex(zeroblob(200000)), cwd = '/' || hex(zeroblob(200000));",
    ]);
    const { reader } = readerFor(file);
    const read = await reader.read(now);
    expect(read.state).toBe("read");
    expect(read.rows).toHaveLength(ids.length);
    for (const row of read.rows) {
      expect(row.title).toBe("0".repeat(1000));
      expect(row.folder).toBeNull();
      expect(row.root.folder).toBeNull();
    }
  });

  test("a database that is not there is not made, and a file that is not a database is a failed read that runs nothing", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "state.db");
    const { reader, runs } = readerFor(missing);
    expect((await reader.read(Date.now())).state).toBe("missing");
    expect(await readdir(dir)).toEqual([]);

    await writeFile(missing, "not a database, though long enough to have a header\n");
    const before = await snapshotOf(dir);
    expect((await reader.read(Date.now())).state).toBe("failed");
    expect(runs).toEqual([]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a question an earlier turn left with no answer is no wait once a new turn runs", async () => {
    const now = Date.now();
    const id = sessionId("d9");
    const { file } = await makeDatabase("rollback", [
      sessionRow({ id, title: "Asked, then restarted", startedAt: now - 60 * MINUTE }),
      messageRow({ sessionId: id, role: "user", at: now - 50 * MINUTE }),
      // The clarify call was saved, then its gateway was killed: no tool row answers it.
      messageRow({
        sessionId: id,
        role: "assistant",
        at: now - 49 * MINUTE,
        toolCalls: [{ id: "call_q", name: "clarify" }],
        finish: "tool_calls",
      }),
      // A new turn, which has made no call yet.
      messageRow({ sessionId: id, role: "user", at: now - 2 * MINUTE }),
      leaseRow({ conversationId: id, at: now - 2 * MINUTE, until: now + 4 * MINUTE }),
    ]);
    const read = await readerFor(file).reader.read(now);
    const [chain] = [...chainsOf(read.rows).values()];
    const shown = hermesAgentSession({
      profile: "default",
      chain: chain ?? [],
      holderAlive: () => true,
      now,
    });
    expect(shown?.status).toBe("working");
    expect(shown?.statusSince).toBe(now - 2 * MINUTE);
  });

  test("an approval label saved before the newest tool call is not that call's wait, so it is announced once", async () => {
    const now = Date.now();
    const id = sessionId("c9");
    const asking = [
      // Hermes Agent saved the label 40 seconds ago, while the approval waited.
      sessionRow({
        id,
        title: "Clean the build",
        startedAt: now - 10 * MINUTE,
        lastActivityAt: now - 40_000,
        label: APPROVAL_LABEL,
      }),
      messageRow({ sessionId: id, role: "user", at: now - 2 * MINUTE }),
      messageRow({
        sessionId: id,
        role: "assistant",
        at: now - 50_000,
        toolCalls: [{ id: "call_1", name: "terminal" }],
        finish: "tool_calls",
      }),
      leaseRow({ conversationId: id, at: now - 2 * MINUTE, until: now + 4 * MINUTE }),
    ];
    const statusOf = async (rows: string[]) => {
      const { file } = await makeDatabase("rollback", rows);
      const read = await readerFor(file).reader.read(now);
      const [chain] = [...chainsOf(read.rows).values()];
      const shown = hermesAgentSession({
        profile: "default",
        chain: chain ?? [],
        holderAlive: () => true,
        now,
      });
      return [shown?.status, shown?.waitingReason, shown?.statusSince];
    };
    expect(await statusOf(asking)).toEqual(["needs-you", "permission", now - 50_000]);
    // Approved: the command answered 20 seconds ago, and the model made
    // another call 5 seconds ago. The label is still the one saved before.
    const movedOn = [
      ...asking,
      messageRow({ sessionId: id, role: "tool", at: now - 20_000, toolCallId: "call_1" }),
      messageRow({
        sessionId: id,
        role: "assistant",
        at: now - 5_000,
        toolCalls: [{ id: "call_2", name: "read_file" }],
        finish: "tool_calls",
      }),
    ];
    expect(await statusOf(movedOn)).toEqual(["working", undefined, now - 2 * MINUTE]);
  });

  test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
    const now = Date.now();
    const { file } = await makeDatabase("rollback", begun(now));
    const odd = path.join(path.dirname(path.dirname(file)), "a b?c%d#e");
    await rename(path.dirname(file), odd);
    const { reader } = readerFor(path.join(odd, "state.db"));
    const read = await reader.read(now);
    expect(read.rows.map((row) => row.id)).toEqual([NEW]);
  });
});
