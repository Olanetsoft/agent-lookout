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
  CODE_LABEL,
  leaseRow,
  messageRow,
  MINUTE,
  PLUGIN_APPROVAL_LABEL,
  PRIVATE_WORDS,
  SCENE,
  SCHEMA,
  sceneRows,
  scheduledTitle,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  type SessionFields,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on databases this test
// writes with that same sqlite3, laid out as Hermes Agent v0.23.3's are: one
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
 * A finder that finds the same sqlite3 and takes it to fail Hermes Agent's
 * WAL-reset test, as macOS's own and Ubuntu's do, whatever its version here.
 */
const failingSqlite: SqliteFinder = {
  pick: async () => ({ kind: "vulnerable", path: sqlite as string, version: [3, 51, 0] }),
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
  "refused_at",
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
  SCENE.refused,
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

/** The name of the one conversation in this database, read with the real sqlite3. */
async function nameOf(file: string, now: number): Promise<string | undefined> {
  const read = await readerFor(file).reader.read(now);
  expect(read.state).toBe("read");
  const chains = [...chainsOf(read.rows).values()];
  expect(chains).toHaveLength(1);
  const chain = chains[0] ?? [];
  return hermesAgentSession({ profile: "default", chain, holderAlive: () => null, now })?.name;
}

/** The one session in a database of these rows, read with the real sqlite3, with every lease's process taken to run. */
async function shownOf(rows: string[], now: number) {
  const { file } = await makeDatabase("rollback", rows);
  const read = await readerFor(file).reader.read(now);
  expect(read.state).toBe("read");
  const chains = [...chainsOf(read.rows).values()];
  expect(chains).toHaveLength(1);
  const chain = chains[0] ?? [];
  return hermesAgentSession({ profile: "default", chain, holderAlive: () => true, now });
}

/** A title, and what Hermes Agent wrote of where it came from. */
type Titled = { title: string | null; titleSource: string | null };

/** A conversation compressed a minute ago, with these titles on its root and its tip. */
function compressed(now: number, root: Titled, tip: Titled): string[] {
  const [rootId, tipId] = [sessionId("c1"), sessionId("c2")];
  return [
    sessionRow({
      id: rootId,
      ...root,
      startedAt: now - 10 * MINUTE,
      endedAt: now - MINUTE,
      endReason: "compression",
    }),
    sessionRow({ id: tipId, parentId: rootId, ...tip, startedAt: now - MINUTE }),
  ];
}

/** A scheduled run's id as Hermes Agent v0.22.1 and later give it, from its gateway, and as earlier ones did. */
const RUN = "local-0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const OLDER_RUN = "cron_0a1b2c3d4e5f_20261001_110000";

/** The title the scheduler gave a run of a job made with no name: the start of its prompt, and the date. */
const RUN_TITLE = scheduledTitle(PRIVATE_WORDS);

/** A scheduled run's row an hour old, as the scheduler makes it, with the title it gives it. */
function runRow(now: number, fields: Partial<SessionFields> = {}): string {
  return sessionRow({
    id: RUN,
    source: "cron",
    createdSource: "cron",
    title: RUN_TITLE,
    titleSource: "user",
    startedAt: now - 60 * MINUTE,
    ...fields,
  });
}

/** The names of the conversations in a database of these rows, by their roots' ids, read with the real sqlite3. */
async function namesOf(rows: string[], now: number): Promise<Record<string, string | undefined>> {
  const { file } = await makeDatabase("rollback", rows);
  // What sqlite3 prints never holds the words that stand for a prompt, whatever the name becomes.
  expect(await answers(file, "rollback")).not.toContain(PRIVATE_WORDS);
  const read = await readerFor(file).reader.read(now);
  expect(read.state).toBe("read");
  return Object.fromEntries(
    [...chainsOf(read.rows)].map(([root, chain]) => [
      root,
      hermesAgentSession({ profile: "default", chain, holderAlive: () => null, now })?.name,
    ]),
  );
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
    expect(runs.every((args) => !args.includes(".timeout 1000"))).toBe(true);
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

  test("a database Hermes Agent switches to WAL mode between the look at its header and the read is read, with a sqlite3 that passes the test, and nothing is written", async () => {
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
    expect(again.runs.every((args) => !args.includes(".timeout 1000"))).toBe(true);
    expect(await snapshotOf(dir)).toEqual(switched);
  });

  test("the same switch, with only a sqlite3 that fails the test, is seen once the sessions are read: what was read is dropped, nothing is written, and the next read reads none of it", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("rollback", sceneRows(now));
    const writer = holdOpen(file, await tempDir());
    let switched: Record<string, string> | null = null;
    const { reader, runs } = readerFor(file, failingSqlite, async (binary, args) => {
      if (switched === null) {
        // As above: switched to WAL mode, with a commit in the -wal of a writer that keeps it open.
        await writer.write(["PRAGMA journal_mode=WAL;", ...begun(now)]);
        switched = await snapshotOf(dir);
        expect(Object.keys(switched)).toEqual(["state.db", "state.db-shm", "state.db-wal"]);
      }
      return runSqlite(binary, args);
    });
    expect(await reader.read(now)).toEqual({ state: "switched", rows: [] });
    expect(runs).toHaveLength(2);
    expect(await snapshotOf(dir)).toEqual(switched);

    // The next read sees the -wal that holds a commit, and with no sqlite3 that passes, runs nothing.
    const next = await reader.read(now + 2_000);
    expect(next).toEqual({
      state: "vulnerable-sqlite",
      rows: [],
      vulnerable: { path: sqlite, version: [3, 51, 0] },
    });
    expect(runs).toHaveLength(2);
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

  test.each<[string, string | null, string]>([
    ["derived, made from the first message, is no name", "derived", "demo"],
    ["llm, a model's, is the name", "llm", "Rename the helper"],
    ["user, a person's, is the name", "user", "Rename the helper"],
    ["none, ranked as a person's by Hermes Agent, is the name", null, "Rename the helper"],
    ["of a value it never writes, ranked with derived by it, is no name", "later", "demo"],
  ])("a title with title_source %s", async (_, titleSource, name) => {
    const now = Date.now();
    const id = sessionId("t1");
    const { file } = await makeDatabase("rollback", [
      sessionRow({ id, title: "Rename the helper", titleSource, startedAt: now - MINUTE }),
    ]);
    expect(await nameOf(file, now)).toBe(name);
  });

  test("a derived title on a row with no folder, as a chat from a messaging app has none, gives way to the session's id", async () => {
    const now = Date.now();
    const id = sessionId("t3");
    const { file } = await makeDatabase("rollback", [
      sessionRow({
        id,
        source: "telegram",
        cwd: null,
        title: PRIVATE_WORDS,
        titleSource: "derived",
        startedAt: now - MINUTE,
      }),
    ]);
    expect(await nameOf(file, now)).toBe(`hermes-agent:default/${id}`);
  });

  test("a title_source that is not text is one Hermes Agent ranks with derived, so its title is no name", async () => {
    const now = Date.now();
    const { file } = await makeDatabase("rollback", [
      sessionRow({ id: sessionId("t2"), startedAt: now - MINUTE }),
      "UPDATE sessions SET title_source = CAST('llm' AS BLOB);",
    ]);
    expect(await nameOf(file, now)).toBe("demo");
  });

  test.each<[string, Titled, Titled, string]>([
    [
      "a tip's derived title gives way to the root's from a model",
      { title: "Root title", titleSource: "llm" },
      { title: "Tip title", titleSource: "derived" },
      "Root title",
    ],
    [
      "a root's derived title is passed over for the tip's from a person",
      { title: "Root title", titleSource: "derived" },
      { title: "Tip title", titleSource: "user" },
      "Tip title",
    ],
    [
      "two derived titles give way to the folder's name",
      { title: "Root title", titleSource: "derived" },
      { title: "Tip title", titleSource: "derived" },
      "demo",
    ],
    [
      "a tip with no title and a root with a derived one take the folder's name",
      { title: "Root title", titleSource: "derived" },
      { title: null, titleSource: null },
      "demo",
    ],
  ])("%s", async (_, root, tip, name) => {
    const now = Date.now();
    const { file } = await makeDatabase("rollback", compressed(now, root, tip));
    expect(await nameOf(file, now)).toBe(name);
  });

  test("sqlite3 prints no derived title, and no title_source at all", async () => {
    const now = Date.now();
    const { file } = await makeDatabase(
      "rollback",
      compressed(
        now,
        { title: PRIVATE_WORDS, titleSource: "derived" },
        { title: `${PRIVATE_WORDS} again`, titleSource: "derived" },
      ),
    );
    const printed = await answers(file, "rollback");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain("derived");
    const rows = await printedRows(file, "rollback");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Object.keys(row)).toEqual(PRINTED);
      expect([row.title, row.root_title]).toEqual([null, null]);
    }
  });

  test.each<[string, Partial<SessionFields>]>([
    ["as the scheduler makes it", {}],
    ["with no created_source", { createdSource: null }],
    [
      "a chat resumed, which has Hermes Agent write its platform over the source",
      { source: "telegram", sessionKey: "agent:main:telegram:dm:1" },
    ],
    ["the gateway keeps as local", { source: "local" }],
    ["of an older Hermes Agent, with the id it had then", { id: OLDER_RUN }],
    [
      "of an older Hermes Agent that a chat resumed, with its id alone left to tell it by",
      { id: OLDER_RUN, source: "telegram", createdSource: null },
    ],
    ["whose title is numbered, since another run had it", { title: `${RUN_TITLE} #2` }],
    ["restored from an export, with no title_source", { titleSource: null }],
    [
      "that started no agent, ended with no message",
      { endedAt: Date.now(), endReason: "cron_suppressed" },
    ],
    ["with a name that is not ASCII", { title: `${PRIVATE_WORDS} まとめ · Oct 01 11:00` }],
  ])("the title of a scheduled run %s is no name, and is never printed", async (_, fields) => {
    const now = Date.now();
    expect(Object.values(await namesOf([runRow(now, fields)], now))).toEqual(["demo"]);
    // Whatever its form: a person's rename is marked as the scheduler's own title is, and nothing
    // says the form stays as it is.
    for (const title of [`${PRIVATE_WORDS}, the good one`, `${PRIVATE_WORDS} (11:00)`]) {
      const names = await namesOf([runRow(now, { ...fields, title })], now);
      expect(Object.values(names)).toEqual(["demo"]);
    }
  });

  test("a scheduled run with no folder takes its ID, as one that sets no working folder has none", async () => {
    const now = Date.now();
    expect(await namesOf([runRow(now, { cwd: null })], now)).toEqual({
      [RUN]: `hermes-agent:default/${RUN}`,
    });
  });

  test("a scheduled run a model titled, as one resumed in a chat with no title of its own can be, shows that title", async () => {
    const now = Date.now();
    const titled = { title: "Rename the helper", titleSource: "llm" };
    expect(await namesOf([runRow(now, titled)], now)).toEqual({ [RUN]: "Rename the helper" });
  });

  test("a run's title is no name on the row it went on in once it was compressed, nor on its first row", async () => {
    const now = Date.now();
    const tip = sessionId("c3");
    const compressedRun = (root: Partial<SessionFields>, next: Partial<SessionFields>) => [
      runRow(now, { endedAt: now - 2 * MINUTE, endReason: "compression", ...root }),
      sessionRow({
        id: tip,
        parentId: RUN,
        source: "cron",
        createdSource: "cron",
        titleSource: "user",
        startedAt: now - 2 * MINUTE,
        ...next,
      }),
    ];
    // The scheduler titles the row a run ended on, and Hermes Agent carries a title on to the next.
    for (const rows of [
      compressedRun({ title: null, titleSource: null }, { title: RUN_TITLE }),
      compressedRun({}, { title: null, titleSource: null }),
      compressedRun({}, { title: `${RUN_TITLE} #2` }),
      // Neither row says so any more but the first, by what made it.
      compressedRun(
        { source: "telegram" },
        { source: "telegram", createdSource: "telegram", title: `${PRIVATE_WORDS} again` },
      ),
    ]) {
      expect(await namesOf(rows, now)).toEqual({ [RUN]: "demo" });
    }
  });

  test("a branch of a scheduled run, and a branch of that, show no title marked as a person's, which can be the run's with a number after it", async () => {
    const now = Date.now();
    const [first, second] = [sessionId("f2"), sessionId("f3")];
    const branch = (id: string, parentId: string, fields: Partial<SessionFields>) =>
      sessionRow({
        id,
        parentId,
        marker: "_branched_from",
        titleSource: "user",
        startedAt: now - 10 * MINUTE,
        ...fields,
      });
    const names = async (title: string, again: string, fields: Partial<SessionFields> = {}) =>
      namesOf(
        [
          runRow(now),
          branch(first, RUN, { title, ...fields }),
          branch(second, first, { title: again, ...fields }),
        ],
        now,
      );
    const none = { [RUN]: "demo", [first]: "demo", [second]: "demo" };
    // As `/branch` numbers it, and as the API server's fork writes it when it cannot.
    expect(await names(`${RUN_TITLE} #2`, `${RUN_TITLE} #3`)).toEqual(none);
    expect(await names(`${RUN_TITLE} fork`, `${RUN_TITLE} fork #2`)).toEqual(none);
    // Whatever its words: a title typed for a branch is marked as a copy of the run's is.
    expect(await names(`${PRIVATE_WORDS} #2`, PRIVATE_WORDS)).toEqual(none);
    // Not marked at all, as restored from an export.
    expect(await names(`${PRIVATE_WORDS} #2`, PRIVATE_WORDS, { titleSource: null })).toEqual(none);
    // A title a model gives the branch is its name.
    expect(await names("Rename the helper", "Write the notes", { titleSource: "llm" })).toEqual({
      [RUN]: "demo",
      [first]: "Rename the helper",
      [second]: "Write the notes",
    });
  });

  test("a branch of an older kind, told by its parent's end alone, shows no title of a scheduled run", async () => {
    const now = Date.now();
    const id = sessionId("f4");
    expect(
      await namesOf(
        [
          runRow(now, { endedAt: now - 11 * MINUTE, endReason: "branched" }),
          sessionRow({
            id,
            parentId: RUN,
            title: `${PRIVATE_WORDS} #2`,
            titleSource: "user",
            startedAt: now - 10 * MINUTE,
          }),
        ],
        now,
      ),
    ).toEqual({ [RUN]: "demo", [id]: "demo" });
  });

  test("a branch whose run Hermes Agent has deleted, which leaves it no parent, shows no title of the form the scheduler writes", async () => {
    const now = Date.now();
    const rows = (title: string) => [
      sessionRow({
        id: sessionId("f5"),
        marker: "_branched_from",
        markerOf: RUN,
        title,
        titleSource: "user",
        startedAt: now - 10 * MINUTE,
      }),
    ];
    for (const title of [`${RUN_TITLE} #2`, `${RUN_TITLE} fork`]) {
      expect(await namesOf(rows(title), now)).toEqual({ [sessionId("f5")]: "demo" });
    }
    // Any other title of such a branch is its name, as another branch's is.
    expect(await namesOf(rows("Read the logs again"), now)).toEqual({
      [sessionId("f5")]: "Read the logs again",
    });
  });

  test("a session that came out of no run shows a title with a date in it, unless the title ends as the scheduler's does or its copies do", async () => {
    const now = Date.now();
    const titles: [string, string | null, string][] = [
      ["Team call · Tue 12 14:30 with Ana", "user", "Team call · Tue 12 14:30 with Ana"],
      ["Team call · Nov 24 10:00, moved", "user", "Team call · Nov 24 10:00, moved"],
      ["Read the logs - Nov 24 10:00", null, "Read the logs - Nov 24 10:00"],
      // A model's is let through, whatever its form.
      ["Release plan · Friday 24 10:00", "llm", "Release plan · Friday 24 10:00"],
      // Nothing tells these from a run's, or from the copy on a branch whose run is gone, and the
      // last is taken with them, since any words can be another locale's month.
      ["Ticket 81 · Nov 24 10:00", null, "demo"],
      ["Ticket 82 · Nov 24 10:00 #2", "user", "demo"],
      ["Ticket 83 · Nov 24 10:00 fork", "user", "demo"],
      ["Planning · see the notes of 12 14:30", "user", "demo"],
    ];
    const rows = titles.map(([title, titleSource], at) =>
      sessionRow({ id: sessionId(`f${at}0`), title, titleSource, startedAt: now - at * MINUTE }),
    );
    expect(await namesOf(rows, now)).toEqual(
      Object.fromEntries(titles.map(([, , name], at) => [sessionId(`f${at}0`), name])),
    );
  });

  test("a chat reset thousands of times in two days is read in time, and one that began as a scheduled run still shows no title", async () => {
    const now = Date.now();
    const count = 3000;
    const began = now - 47 * 60 * MINUTE;
    // No reset has a mark of its own, as an older Hermes Agent's has none, so each row is a
    // conversation, and every row before it is one it came from.
    const chat = (id: string, source: string) =>
      [
        sessionRow({
          id,
          source,
          createdSource: source,
          cwd: null,
          title: id,
          titleSource: "user",
          sessionKey: `agent:main:telegram:dm:${id}`,
          startedAt: began,
          endedAt: began,
          endReason: "session_reset",
        }),
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`,
        "INSERT INTO sessions (id, source, created_source, session_key, parent_session_id, started_at, ended_at, end_reason, title, title_source)",
        `SELECT s.id || '-' || i, 'telegram', 'telegram', s.session_key, CASE i WHEN 1 THEN s.id ELSE s.id || '-' || (i - 1) END,`,
        `s.started_at + i * 45, s.started_at + i * 45, 'session_reset', s.title || ' ' || i, 'user' FROM n, sessions s WHERE s.id = '${id}';`,
      ].join("\n");
    const names = await namesOf(
      [
        "PRAGMA foreign_keys = OFF;",
        // As Hermes Agent has it.
        "CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);",
        chat("chat", "telegram"),
        chat("run", "cron"),
        sessionRow({ id: sessionId("a7"), title: "Read the logs", startedAt: now }),
      ],
      now,
    );
    expect(Object.keys(names)).toHaveLength(500);
    expect(names[sessionId("a7")]).toBe("Read the logs");
    expect(names[`chat-${count}`]).toBe(`chat ${count}`);
    expect(names[`run-${count}`]).toBe(`hermes-agent:default/run-${count}`);
  });

  test("a reset child of a scheduled run shows no title moved to it from the run, and a chat that went on after one shows its own", async () => {
    const now = Date.now();
    const child = sessionId("92");
    const reset = (fields: Partial<SessionFields>) =>
      namesOf(
        [
          runRow(now, {
            title: null,
            titleSource: null,
            endedAt: now - 11 * MINUTE,
            endReason: "session_reset",
          }),
          sessionRow({
            id: child,
            parentId: RUN,
            marker: "_reset_from",
            titleSource: "user",
            startedAt: now - 10 * MINUTE,
            ...fields,
          }),
        ],
        now,
      );
    // Reset where it is, it keeps what made the run, whatever its source becomes.
    for (const fields of [
      { source: "cron", createdSource: "cron", title: `${PRIVATE_WORDS} again` },
      { source: "telegram", createdSource: "cron", title: `${PRIVATE_WORDS} again` },
      // With no mark left, the form is what tells it.
      { source: "telegram", createdSource: null, title: RUN_TITLE },
    ]) {
      expect(await reset(fields)).toEqual({ [RUN]: "demo", [child]: "demo" });
    }
    // A chat's own `/new` takes no title from the run before it, so one typed there is a name.
    expect(
      await reset({ source: "telegram", createdSource: "telegram", title: "Afternoon chat" }),
    ).toEqual({ [RUN]: "demo", [child]: "Afternoon chat" });
  });

  test("a subagent's run a scheduled run started is not listed, and nothing of its title is printed", async () => {
    const now = Date.now();
    expect(
      await namesOf(
        [
          runRow(now),
          sessionRow({
            id: sessionId("ff08"),
            parentId: RUN,
            marker: "_delegate_from",
            source: "subagent",
            title: `Subagent: ${PRIVATE_WORDS}`,
            titleSource: "derived",
            startedAt: now - 5 * MINUTE,
          }),
        ],
        now,
      ),
    ).toEqual({ [RUN]: "demo" });
  });

  test("rows that name each other as the row they came from end the walk, and the scheduled run among them is still told", async () => {
    const now = Date.now();
    const id = sessionId("f6");
    expect(
      await namesOf(
        [
          runRow(now, { parentId: id, marker: "_branched_from" }),
          sessionRow({
            id,
            parentId: RUN,
            marker: "_branched_from",
            title: PRIVATE_WORDS,
            titleSource: "user",
            startedAt: now - 10 * MINUTE,
          }),
        ].map((row) => `PRAGMA foreign_keys = OFF; ${row}`),
        now,
      ),
    ).toEqual({ [RUN]: "demo", [id]: "demo" });
  });

  test("a scheduled run beside them leaves every other conversation's title be, a branch's and a chat's among them", async () => {
    const now = Date.now();
    const [one, two, three] = [sessionId("a8"), sessionId("a9"), "cron_digest"];
    expect(
      await namesOf(
        [
          runRow(now),
          sessionRow({ id: one, title: "Rename the helper", titleSource: "user", startedAt: now }),
          sessionRow({
            id: two,
            parentId: one,
            marker: "_branched_from",
            title: "Rename the helper #2",
            titleSource: "user",
            startedAt: now,
          }),
          // An id a client of the API server chose, not of the form a run's was.
          sessionRow({
            id: three,
            source: "api_server",
            title: "Digest for Oct 01",
            titleSource: null,
            startedAt: now,
          }),
        ],
        now,
      ),
    ).toEqual({
      [RUN]: "demo",
      [one]: "Rename the helper",
      [two]: "Rename the helper #2",
      [three]: "Digest for Oct 01",
    });
  });

  test("once a model's title takes a derived one's place, the next read has it", async () => {
    const now = Date.now();
    const { file } = await makeDatabase("rollback", [
      sessionRow({
        id: sessionId("t3"),
        title: PRIVATE_WORDS,
        titleSource: "derived",
        startedAt: now - MINUTE,
      }),
    ]);
    const { reader } = readerFor(file);
    expect((await reader.read(now)).rows.map((row) => row.title)).toEqual([null]);
    execFileSync(sqlite as string, [
      ...NO_INIT,
      file,
      "UPDATE sessions SET title = 'Rename the helper', title_source = 'llm';",
    ]);
    expect((await reader.read(now)).rows.map((row) => row.title)).toEqual(["Rename the helper"]);
  });

  test("of a database with no title_source, the probe says so, as of any column it needs, the sessions are not asked for, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase("rollback", [
      ...sceneRows(now),
      "ALTER TABLE sessions DROP COLUMN title_source;",
    ]);
    const before = await snapshotOf(dir);
    const { reader, runs } = readerFor(file);
    expect(await reader.read(now)).toEqual({ state: "unsupported", rows: [] });
    expect(runs.map((args) => args.at(-1))).toEqual([PROBE_QUERY]);
    expect(await snapshotOf(dir)).toEqual(before);
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

  test("a turn Hermes Agent took back after a safety refusal is failed, from its newest row, until a newer turn is written", async () => {
    const now = Date.now();
    const id = sessionId("r9");
    // A turn that was answered, then a refused one. As Hermes Agent leaves a
    // refusal, every row of the refused turn is set to active = 0, and its
    // message is kept on screen, compacted, as content_refused.
    const refused = [
      sessionRow({ id, title: "Refused turn", startedAt: now - 20 * MINUTE }),
      messageRow({ sessionId: id, role: "user", at: now - 10 * MINUTE }),
      messageRow({ sessionId: id, role: "assistant", at: now - 9 * MINUTE, finish: "stop" }),
      messageRow({
        sessionId: id,
        role: "user",
        at: now - 5 * MINUTE,
        active: 0,
        compacted: 1,
        kind: "content_refused",
        metadata: { content_refused: { notice: PRIVATE_WORDS } },
      }),
      messageRow({
        sessionId: id,
        role: "assistant",
        at: now - 4 * MINUTE,
        toolCalls: [{ id: "call_r", name: "read_file" }],
        active: 0,
      }),
    ];
    const at = async (rows: string[]) => {
      const shown = await shownOf(rows, now);
      return [shown?.status, shown?.statusSince];
    };
    expect(await at(refused)).toEqual(["failed", now - 4 * MINUTE]);
    // Once a later turn is answered, the refusal is behind its rows.
    const answered = [
      ...refused,
      messageRow({ sessionId: id, role: "user", at: now - 2 * MINUTE }),
      messageRow({ sessionId: id, role: "assistant", at: now - MINUTE, finish: "stop" }),
    ];
    expect(await at(answered)).toEqual(["idle", now - MINUTE]);
    // A turn taken back with /undo, not for a refusal, is no failure.
    const undone = [
      ...refused.slice(0, 3),
      messageRow({ sessionId: id, role: "user", at: now - 5 * MINUTE, active: 0 }),
    ];
    expect(await at(undone)).toEqual(["idle", now - 9 * MINUTE]);
  });

  test("sqlite3 prints a refused turn's time alone, not its kind", async () => {
    const now = Date.now();
    const { file } = await makeDatabase("rollback", sceneRows(now));
    expect(await answers(file, "rollback")).not.toContain("content_refused");
    const row = (await printedRows(file, "rollback")).find((each) => each.id === SCENE.refused);
    expect(row?.refused_at).toBeCloseTo((now - 12 * MINUTE) / 1000, 3);
    expect(row?.n_at).toBeCloseTo((now - 16 * MINUTE) / 1000, 3);
  });

  test.each<[string, string, string, string]>([
    ["a plugin's approval transport", PLUGIN_APPROVAL_LABEL, "terminal", "permission"],
    ["a chat's one-time code", CODE_LABEL, "browser_vault", "question"],
  ])(
    "the label %s saves, for the turn's tool call that waits, is a wait for you",
    async (_, label, tool, reason) => {
      const now = Date.now();
      const id = sessionId("w9");
      const shown = await shownOf(
        [
          sessionRow({
            id,
            title: "Asks for you",
            startedAt: now - 10 * MINUTE,
            lastActivityAt: now - 20_000,
            label,
          }),
          messageRow({ sessionId: id, role: "user", at: now - 2 * MINUTE }),
          messageRow({
            sessionId: id,
            role: "assistant",
            at: now - MINUTE,
            toolCalls: [{ id: "call_w", name: tool }],
            finish: "tool_calls",
          }),
          leaseRow({ conversationId: id, at: now - 2 * MINUTE, until: now + 4 * MINUTE }),
        ],
        now,
      );
      expect([shown?.status, shown?.waitingReason, shown?.statusSince]).toEqual([
        "needs-you",
        reason,
        now - MINUTE,
      ]);
    },
  );

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
