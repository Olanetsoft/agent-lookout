import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import {
  PROBE_QUERY,
  SESSIONS_QUERY,
  sqliteArguments,
} from "@collector/adapters/opencode/sessionRows";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  assistantData,
  compactionData,
  continueData,
  messageId,
  messageRow,
  MINUTE,
  partRow,
  partId,
  PRIVATE_WORDS,
  SCHEMA,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  text,
  textData,
  toolData,
  userData,
} from "@tests/fixtures/opencode/opencode";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a database this test
// writes with that same sqlite3, laid out as OpenCode 1.19.0's is. What
// OpenCode saves lies in the database's -wal file, and a second sqlite3, kept
// open as OpenCode keeps its database open, stands in for it here. OpenCode
// never closes its database, so when it quits it leaves the -wal full, as
// this stand-in does when it is killed. This is the test that says Agent
// Lookout may read the database at all: it must see the newest commit, and
// leave every byte, size and modified time of the database, its -wal and its
// -shm as they were. Where there is no sqlite3, as on Windows, there is
// nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const A = sessionId("a1");
const B = sessionId("b2");

/** The rows of one session whose newest step ended the turn at `at`. */
function idleSession(id: string, suffix: string, at: number): string[] {
  const user = messageId(`u${suffix}`);
  const reply = messageId(`a${suffix}`);
  return [
    sessionRow({ id, createdAt: at - 10 * MINUTE, updatedAt: at }),
    messageRow({
      id: user,
      sessionId: id,
      createdAt: at - 2 * MINUTE,
      data: userData(at - 2 * MINUTE),
    }),
    partRow({
      id: partId(`u${suffix}`),
      messageId: user,
      sessionId: id,
      createdAt: at - 2 * MINUTE,
      data: textData(),
    }),
    messageRow({
      id: reply,
      sessionId: id,
      createdAt: at - MINUTE,
      updatedAt: at,
      data: assistantData({
        createdAt: at - MINUTE,
        completedAt: at,
        finish: "stop",
        parentId: user,
      }),
    }),
    partRow({
      id: partId(`a${suffix}`),
      messageId: reply,
      sessionId: id,
      createdAt: at,
      data: textData(),
    }),
  ];
}

/** OpenCode's database in a folder of its own, in WAL mode, with these rows, and nothing beside it. */
async function makeDatabase(rows: string[]): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "opencode");
  const file = path.join(dir, "opencode.db");
  await mkdir(dir, { recursive: true });
  execFileSync(sqlite as string, [file, ["PRAGMA journal_mode=WAL;", SCHEMA, ...rows].join("\n")]);
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

/**
 * A second sqlite3 that opens the database and keeps it open, as OpenCode
 * does while it runs, writing what it is given. It never closes on its own.
 */
function holdOpen(file: string, marks: string) {
  const child: ChildProcess = spawn(sqlite as string, ["-batch", file], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let count = 0;
  return {
    child,
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
    /**
     * Ends it cleanly, so it moves its -wal into the database as it closes it,
     * as a program that closes the database does. OpenCode 1.19.0 never does.
     */
    async close(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.stdin?.end();
      await gone;
    },
    /**
     * Ends it with SIGKILL, so its -wal and -shm are left full with no
     * writer, as OpenCode leaves them when it quits under Bun, and as a crash does.
     */
    async kill(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    },
  };
}

/** What the adapter's reader says of the database now, read as the adapter reads it. */
async function readNow(file: string, at = Date.now()) {
  const reader = createDatabaseReader({ file, io: nodeIo, platform: process.platform });
  return reader.read(at);
}

/** What sqlite3 prints for both questions, opened this way. */
async function answers(file: string, mode: "whole" | "with-wal"): Promise<string> {
  let printed = "";
  for (const query of [PROBE_QUERY, SESSIONS_QUERY]) {
    const answer = await runSqlite(sqlite as string, sqliteArguments(file, mode, query));
    expect(answer.ok, query).toBe(true);
    if (answer.ok) printed += answer.stdout;
  }
  return printed;
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

describe.skipIf(sqlite === null)("reading OpenCode's database with the real sqlite3", () => {
  test("with no -wal beside it: every session is read, and no file is made or changed", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase([
      ...idleSession(A, "1", now - 5 * MINUTE),
      ...idleSession(B, "2", now - 3 * MINUTE),
    ]);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["opencode.db"]);

    const read = await readNow(file, now);
    expect(read).toMatchObject({ state: "read", opencode2: false });
    expect(read.rows.map((row) => row.id)).toEqual([B, A]);
    expect(await snapshotOf(dir)).toEqual(before);

    const printed = await answers(file, "whole");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("held open, with commits only in the -wal: the newest is seen, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase(idleSession(A, "1", now - 5 * MINUTE));
    const writer = holdOpen(file, await tempDir());
    // A new session, then a new step of the first, each a commit of its own,
    // far below the thousand pages at which SQLite moves the -wal into the database.
    await writer.write(idleSession(B, "2", now - 2 * MINUTE));
    await writer.write([
      messageRow({
        id: messageId("a3"),
        sessionId: A,
        createdAt: now - MINUTE,
        data: assistantData({ createdAt: now - MINUTE }),
      }),
      `UPDATE session SET time_updated = ${now - MINUTE} WHERE id = '${A}';`,
    ]);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["opencode.db", "opencode.db-shm", "opencode.db-wal"]);

    // Read as a file nothing changes, the database is as it was before the writer began.
    const immutable = await runSqlite(
      sqlite as string,
      sqliteArguments(file, "whole", SESSIONS_QUERY),
    );
    expect(immutable.ok).toBe(true);
    if (immutable.ok) {
      expect(immutable.stdout).toContain(A);
      expect(immutable.stdout).not.toContain(B);
    }
    expect(await snapshotOf(dir)).toEqual(before);

    // Read as the adapter reads it, every commit is seen: the first session,
    // written last, now comes first.
    const read = await readNow(file, now);
    expect(read).toMatchObject({ state: "read" });
    expect(read.rows.map((row) => row.id)).toEqual([A, B]);
    const newest = read.rows.find((row) => row.id === A)?.message;
    expect(newest).toMatchObject({ role: "assistant", completedAt: null, createdAt: now - MINUTE });
    expect(await snapshotOf(dir)).toEqual(before);

    // The step ends: the next commit is seen too, and still nothing is written.
    await writer.write([
      `UPDATE message SET data = json_set(data, '$.time.completed', ${now}, '$.finish', 'stop'), time_updated = ${now} WHERE id = '${messageId("a3")}';`,
    ]);
    const after = await snapshotOf(dir);
    const again = await readNow(file, now);
    expect(again.rows.find((row) => row.id === A)?.message).toMatchObject({
      completedAt: now,
      finish: "stop",
    });
    expect(await snapshotOf(dir)).toEqual(after);

    const printed = await answers(file, "with-wal");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(await snapshotOf(dir)).toEqual(after);
  });

  test("after OpenCode quits, or crashes, with the -wal and -shm left full and no writer: the newest is seen, and nothing is written", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase(idleSession(A, "1", now - 5 * MINUTE));
    const writer = holdOpen(file, await tempDir());
    await writer.write(idleSession(B, "2", now - 2 * MINUTE));
    await writer.kill();
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["opencode.db", "opencode.db-shm", "opencode.db-wal"]);

    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);

    // The -wal holds the commits no one moved into the database, so it is read with them.
    const read = await readNow(file, now);
    expect(read).toMatchObject({ state: "read" });
    expect(read.rows.map((row) => row.id)).toEqual([B, A]);
    expect(await snapshotOf(dir)).toEqual(before);

    const printed = await answers(file, "with-wal");
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("with an empty -wal and the -shm kept, as the SQLite of macOS leaves them after a close: read, and nothing is written", async () => {
    const now = Date.now();
    const dir = path.join(await tempDir(), "opencode");
    const file = path.join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    // Asked to keep its -wal, sqlite3 empties it on closing and leaves it there.
    // It empties it only with a size limit, which the SQLite of macOS sets and
    // one built from SQLite's own source does not, so the limit is set here.
    execFileSync(sqlite as string, [
      file,
      "PRAGMA journal_mode=WAL;",
      "PRAGMA journal_size_limit=0;",
      ".filectrl persist_wal 1",
      [SCHEMA, ...idleSession(A, "1", now - 5 * MINUTE)].join("\n"),
    ]);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["opencode.db", "opencode.db-shm", "opencode.db-wal"]);
    expect((await lstat(`${file}-wal`)).size).toBe(0);

    const read = await readNow(file, now);
    expect(read).toMatchObject({ state: "read" });
    expect(read.rows.map((row) => row.id)).toEqual([A]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a program closing the database between the look and the read leaves at most an empty -wal, and the next read works", async () => {
    const now = Date.now();
    const { dir, file } = await makeDatabase(idleSession(A, "1", now - 5 * MINUTE));
    const writer = holdOpen(file, await tempDir());
    await writer.write(idleSession(B, "2", now - 2 * MINUTE));
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);
    let closing = true;
    const reader = createDatabaseReader({
      file,
      io: nodeIo,
      platform: process.platform,
      async run(binary, args) {
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
      },
    });
    await reader.read(now);
    // A sqlite3 built from SQLite's own source, as on Linux, makes an empty
    // -wal as it opens the database. The SQLite of macOS makes none.
    const left = await readdir(dir);
    expect(left.filter((name) => name !== "opencode.db-wal")).toEqual(["opencode.db"]);
    if (left.includes("opencode.db-wal")) expect((await lstat(`${file}-wal`)).size).toBe(0);

    const before = await snapshotOf(dir);
    const read = await reader.read(now + 2_000);
    expect(read).toMatchObject({ state: "read" });
    expect(read.rows.map((row) => row.id)).toEqual([B, A]);
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a tool part is counted only when OpenCode would wait on it", async () => {
    const now = Date.now();
    const C = sessionId("c3");
    /** A session whose newest step ended with `stop` a minute ago, with these parts. */
    function ended(id: string, suffix: string, parts: Record<string, unknown>[]): string[] {
      const reply = messageId(`a${suffix}`);
      return [
        sessionRow({ id, updatedAt: now - MINUTE }),
        messageRow({
          id: reply,
          sessionId: id,
          createdAt: now - 2 * MINUTE,
          updatedAt: now - MINUTE,
          data: assistantData({
            createdAt: now - 2 * MINUTE,
            completedAt: now - MINUTE,
            finish: "stop",
          }),
        }),
        ...parts.map((data, index) =>
          partRow({
            id: partId(`${suffix}${index}`),
            messageId: reply,
            sessionId: id,
            createdAt: now - MINUTE,
            data,
          }),
        ),
      ];
    }
    const { file } = await makeDatabase([
      ...ended(A, "1", [toolData({ status: "completed" }), textData()]),
      ...ended(B, "2", [
        toolData({ status: "completed", providerExecuted: true }),
        toolData({ status: "error", interrupted: true }),
      ]),
      ...ended(C, "3", [textData(), textData()]),
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    const tools = Object.fromEntries(read.rows.map((row) => [row.id, row.message?.tools]));
    expect(tools).toEqual({ [A]: 1, [B]: 0, [C]: 0 });
  });

  test("the person's newest prompt is read, passing over those OpenCode writes itself when it compacts a session on its own", async () => {
    const now = Date.now();
    const C = sessionId("c3");
    const D = sessionId("d4");
    const at = (minutes: number) => now - minutes * MINUTE;
    /** A message of a session, with one part of this data. */
    const message = (
      id: string,
      suffix: string,
      minutes: number,
      data: Record<string, unknown>,
      part: Record<string, unknown>,
    ) => [
      messageRow({ id: messageId(suffix), sessionId: id, createdAt: at(minutes), data }),
      partRow({
        id: partId(suffix),
        messageId: messageId(suffix),
        sessionId: id,
        createdAt: at(minutes),
        data: part,
      }),
    ];
    const step = (minutes: number, ended: boolean) =>
      assistantData({
        createdAt: at(minutes),
        ...(ended ? { completedAt: at(minutes), finish: "stop" } : {}),
      });
    const { file } = await makeDatabase([
      // Two prompts, each with its reply: the newest is a minute old.
      sessionRow({ id: A, updatedAt: at(0.5) }),
      ...message(A, "a1u", 10, userData(at(10)), textData()),
      ...message(A, "a1a", 9, step(9, true), textData()),
      ...message(A, "a2u", 1, userData(at(1)), textData()),
      ...message(A, "a2a", 0.5, step(0.5, false), textData()),
      // A prompt five minutes ago, then OpenCode compacts the session on its
      // own and writes a prompt of its own to go on.
      sessionRow({ id: B, updatedAt: at(0.5) }),
      ...message(B, "b1u", 5, userData(at(5)), textData()),
      ...message(B, "b2u", 3, userData(at(3)), compactionData(true)),
      ...message(B, "b2a", 2.5, step(2.5, true), textData()),
      ...message(B, "b3u", 2, userData(at(2)), continueData()),
      ...message(B, "b3a", 0.5, step(0.5, false), textData()),
      // The person asks OpenCode to compact the session: that is a prompt of theirs.
      sessionRow({ id: C, updatedAt: at(1) }),
      ...message(C, "c1u", 5, userData(at(5)), textData()),
      ...message(C, "c2u", 2, userData(at(2)), compactionData(false)),
      ...message(C, "c2a", 1, step(1, false), textData()),
      // A prompt with a part of the person's beside one OpenCode writes itself is theirs.
      sessionRow({ id: D, updatedAt: at(1) }),
      ...message(D, "d1u", 5, userData(at(5)), textData()),
      ...message(D, "d2u", 2, userData(at(2)), compactionData(true)),
      partRow({
        id: partId("d2t"),
        messageId: messageId("d2u"),
        sessionId: D,
        createdAt: at(2),
        data: textData(),
      }),
      ...message(D, "d2a", 1, step(1, false), textData()),
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    const prompts = Object.fromEntries(read.rows.map((row) => [row.id, row.userCreatedAt]));
    expect(prompts).toEqual({ [A]: at(1), [B]: at(5), [C]: at(2), [D]: at(2) });
  });

  test("of two messages written in the same millisecond, the newest is the one OpenCode orders last, by id", async () => {
    const now = Date.now();
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: now - MINUTE }),
      messageRow({
        id: messageId("a1"),
        sessionId: A,
        createdAt: now - MINUTE,
        data: userData(now - MINUTE),
      }),
      messageRow({
        id: messageId("a2"),
        sessionId: A,
        createdAt: now - MINUTE,
        data: assistantData({ createdAt: now - MINUTE }),
      }),
    ]);
    const read = await readNow(file, now);
    expect(read.rows[0]?.message).toMatchObject({ role: "assistant", completedAt: null });
  });

  test("a step whose one tool part is the shell's is marked, as OpenCode writes a command the person runs with !", async () => {
    const now = Date.now();
    const C = sessionId("c3");
    /** A session whose newest step ended with no reason given, with these parts. */
    function shellStep(id: string, suffix: string, parts: Record<string, unknown>[]): string[] {
      const reply = messageId(`a${suffix}`);
      return [
        sessionRow({ id, updatedAt: now - MINUTE }),
        messageRow({
          id: reply,
          sessionId: id,
          createdAt: now - 2 * MINUTE,
          updatedAt: now - MINUTE,
          data: assistantData({ createdAt: now - 2 * MINUTE, completedAt: now - MINUTE }),
        }),
        ...parts.map((data, index) =>
          partRow({
            id: partId(`${suffix}${index}`),
            messageId: reply,
            sessionId: id,
            createdAt: now - MINUTE,
            data,
          }),
        ),
      ];
    }
    const { file } = await makeDatabase([
      ...shellStep(A, "1", [toolData({ status: "completed", tool: "bash" })]),
      ...shellStep(B, "2", [
        toolData({ status: "completed", tool: "bash" }),
        toolData({ status: "completed", tool: "read" }),
      ]),
      ...shellStep(C, "3", [toolData({ status: "completed", tool: "read" }), textData()]),
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    const shell = Object.fromEntries(read.rows.map((row) => [row.id, row.message?.shell]));
    expect(shell).toEqual({ [A]: 1, [B]: 0, [C]: 0 });
  });

  test("a message or a part whose data is not JSON gives empty fields, and every other session is still read", async () => {
    const now = Date.now();
    const C = sessionId("c3");
    const notJson = (table: string, columns: string, values: string) =>
      `INSERT INTO ${table} (${columns}) VALUES (${values}, ${text("not json")});`;
    const { file } = await makeDatabase([
      ...idleSession(A, "1", now - 5 * MINUTE),
      // B's newest message, an older one of the person's and a part of its newest are not JSON.
      sessionRow({ id: B, updatedAt: now - 3 * MINUTE }),
      notJson(
        "message",
        "id, session_id, time_created, time_updated, data",
        `${text(messageId("u2"))}, ${text(B)}, ${now - 4 * MINUTE}, ${now - 4 * MINUTE}`,
      ),
      notJson(
        "message",
        "id, session_id, time_created, time_updated, data",
        `${text(messageId("a2"))}, ${text(B)}, ${now - 3 * MINUTE}, ${now - 3 * MINUTE}`,
      ),
      notJson(
        "part",
        "id, message_id, session_id, time_created, time_updated, data",
        `${text(partId("a2"))}, ${text(messageId("a2"))}, ${text(B)}, ${now - 3 * MINUTE}, ${now - 3 * MINUTE}`,
      ),
      // C's newest message is whole, and one of its parts is not JSON.
      ...idleSession(C, "3", now - 2 * MINUTE),
      notJson(
        "part",
        "id, message_id, session_id, time_created, time_updated, data",
        `${text(partId("x3"))}, ${text(messageId("a3"))}, ${text(C)}, ${now - 2 * MINUTE}, ${now - 2 * MINUTE}`,
      ),
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    expect(read.rows.map((row) => row.id)).toEqual([C, B, A]);
    const byId = new Map(read.rows.map((row) => [row.id, row]));
    expect(byId.get(B)?.message).toMatchObject({
      role: null,
      completedAt: null,
      error: null,
      finish: null,
      tools: 0,
    });
    expect(byId.get(B)?.userCreatedAt).toBeNull();
    expect(byId.get(C)?.message).toMatchObject({ role: "assistant", finish: "stop", tools: 0 });
  });

  test("titles and folders far longer than are kept are cut inside SQLite, so they cannot fill the answer", async () => {
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (_, index) => sessionId(`l${index}`));
    // Each title and folder is 400,000 characters long, far past the 4 MiB sqlite3 may print in all.
    const { file } = await makeDatabase([
      ...ids.map((id) => sessionRow({ id, updatedAt: now - MINUTE })),
      "UPDATE session SET title = hex(zeroblob(200000)), directory = '/' || hex(zeroblob(200000));",
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    expect(read.rows).toHaveLength(ids.length);
    for (const row of read.rows) {
      expect(row.title).toBe("0".repeat(1000));
      expect(row.folder).toBeNull();
    }
  });

  test("a database that is not there is not made, and a file that is not a database is a failed read", async () => {
    const dir = await tempDir();
    const missing = path.join(dir, "opencode.db");
    expect((await readNow(missing)).state).toBe("missing");
    const answer = await runSqlite(
      sqlite as string,
      sqliteArguments(missing, "whole", PROBE_QUERY),
    );
    expect(answer.ok).toBe(false);
    expect(await readdir(dir)).toEqual([]);

    await writeFile(missing, "not a database\n");
    const before = await snapshotOf(dir);
    expect((await readNow(missing)).state).toBe("failed");
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a folder whose name has a space, a question mark and a percent sign in it is read", async () => {
    const now = Date.now();
    const { file } = await makeDatabase(idleSession(A, "1", now - MINUTE));
    const odd = path.join(path.dirname(path.dirname(file)), "a b?c%d#e");
    await rename(path.dirname(file), odd);
    const read = await readNow(path.join(odd, "opencode.db"), now);
    expect(read.rows.map((row) => row.id)).toEqual([A]);
  });
});
