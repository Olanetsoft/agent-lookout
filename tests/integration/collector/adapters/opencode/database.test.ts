import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import {
  MAX_SESSIONS,
  MESSAGES_FOR_TOKENS,
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
  type ToolFields,
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
  // On stdin, since Linux takes no argument longer than 128 KB, and some of these are longer.
  execFileSync(sqlite as string, [file], {
    input: ["PRAGMA journal_mode=WAL;", SCHEMA, ...rows].join("\n"),
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

  describe("a call that waits for the person", () => {
    /** A session whose newest step is under way, as OpenCode's is while a tool runs, with these parts. */
    function underWay(
      id: string,
      suffix: string,
      parts: Record<string, unknown>[],
      at: number,
    ): string[] {
      const reply = messageId(`a${suffix}`);
      return [
        sessionRow({ id, updatedAt: at }),
        messageRow({
          id: reply,
          sessionId: id,
          createdAt: at,
          data: assistantData({ createdAt: at }),
        }),
        ...parts.map((data, index) =>
          partRow({
            id: partId(`${suffix}${index}`),
            messageId: reply,
            sessionId: id,
            createdAt: at,
            data,
          }),
        ),
      ];
    }

    test("is a question or a plan's approval, running, and no other tool or state of one", async () => {
      const now = Date.now();
      const started = now - 2 * MINUTE;
      const asked: [string, Record<string, unknown>, boolean][] = [
        // Asking, and once answered, declined, or cut off, as OpenCode writes each.
        ["question waiting", toolData({ status: "running", tool: "question" }), true],
        ["question answered", toolData({ status: "completed", tool: "question" }), false],
        ["question declined", toolData({ status: "error", tool: "question" }), false],
        [
          "question cut off",
          toolData({ status: "error", tool: "question", interrupted: true }),
          false,
        ],
        // The model is still writing the call, so nothing is asked yet.
        ["question being written", toolData({ status: "pending", tool: "question" }), false],
        ["plan waiting", toolData({ status: "running", tool: "plan_exit" }), true],
        ["plan answered", toolData({ status: "completed", tool: "plan_exit" }), false],
        ["plan declined", toolData({ status: "error", tool: "plan_exit" }), false],
        // Any other tool, however close its name, is work.
        ["shell", toolData({ status: "running", tool: "bash" }), false],
        ["subtask", toolData({ status: "running", tool: "task" }), false],
        ["another name", toolData({ status: "running", tool: "question_more" }), false],
        ["a name in capitals", toolData({ status: "running", tool: "Question" }), false],
        ["plan_enter", toolData({ status: "running", tool: "plan_enter" }), false],
        // Only a tool part counts, and the name must be text.
        [
          "not a tool part",
          { type: "text", tool: "question", state: { status: "running" } },
          false,
        ],
        ["a list for a name", { ...toolData({ status: "running" }), tool: ["question"] }, false],
      ];
      const ids = asked.map((_, index) => sessionId(`w${index}`));
      const { file } = await makeDatabase(
        asked.flatMap(([, part], index) =>
          underWay(ids[index] as string, `w${index}`, [part], started),
        ),
      );
      const read = await readNow(file, now);
      expect(read.state).toBe("read");
      expect(read.rows).toHaveLength(asked.length);
      const byId = new Map(read.rows.map((row) => [row.id, row.message]));
      asked.forEach(([what, , waits], index) => {
        const askedAt = byId.get(ids[index] as string)?.askedAt;
        expect(askedAt !== null, what).toBe(waits);
      });
    });

    test("carries when the step's oldest such call began, and never what was asked", async () => {
      const now = Date.now();
      const C = sessionId("c3");
      const D = sessionId("d4");
      const started = now - 3 * MINUTE;
      const written = now - MINUTE;
      const { file } = await makeDatabase([
        ...underWay(
          A,
          "1",
          [toolData({ status: "running", tool: "question", startedAt: started })],
          written,
        ),
        // Two at once, beside a tool that runs: OpenCode asks each in turn.
        ...underWay(
          B,
          "2",
          [
            toolData({ status: "running", tool: "plan_exit", startedAt: started + 5_000 }),
            toolData({ status: "running", tool: "question", startedAt: started }),
            toolData({ status: "running", tool: "bash", startedAt: started - MINUTE }),
          ],
          written,
        ),
        // One step is one wait, so a call of it that is over keeps its time.
        ...underWay(
          C,
          "3",
          [
            toolData({ status: "completed", tool: "question", startedAt: started - MINUTE }),
            toolData({ status: "running", tool: "question", startedAt: started }),
          ],
          written,
        ),
        // A start that is not a whole number is not printed: the part's own time stands in.
        ...underWay(
          D,
          "4",
          [toolData({ status: "running", tool: "question", startedAt: PRIVATE_WORDS })],
          written,
        ),
      ]);
      const read = await readNow(file, now);
      expect(read.state).toBe("read");
      expect(Object.fromEntries(read.rows.map((row) => [row.id, row.message?.askedAt]))).toEqual({
        [A]: started,
        [B]: started,
        [C]: started - MINUTE,
        [D]: written,
      });
      const printed = await answers(file, "whole");
      expect(printed).toContain('"m_asked_at":');
      expect(printed).not.toContain(PRIVATE_WORDS);
      expect(printed).not.toContain("question");
      expect(printed).not.toContain("plan_exit");
      expect(printed).not.toContain("running");
    });

    test("keeps its time however a step's two calls are answered, so one wait is announced once", async () => {
      const now = Date.now();
      const started = now - 3 * MINUTE;
      const second = started + 3_000;
      const written = now - MINUTE;
      const call = (status: ToolFields["status"], startedAt: number) =>
        toolData({ status, tool: "question", startedAt });
      const askedAtOf = async (parts: Record<string, unknown>[]) => {
        const { file } = await makeDatabase(underWay(A, "1", parts, written));
        const read = await readNow(file, now);
        return read.rows[0]?.message?.askedAt;
      };

      // The first, alone, then the second begins, with nothing answered.
      expect(await askedAtOf([call("running", started)])).toBe(started);
      expect(await askedAtOf([call("running", started), call("running", second)])).toBe(started);
      // Either is answered first.
      expect(await askedAtOf([call("completed", started), call("running", second)])).toBe(started);
      expect(await askedAtOf([call("running", started), call("error", second)])).toBe(started);
      // Both are answered, and the wait is over.
      expect(await askedAtOf([call("completed", started), call("error", second)])).toBeNull();
      expect(await askedAtOf([call("completed", started)])).toBeNull();
    });

    test("does not take its time from a call the model is still writing, which has no start", async () => {
      const now = Date.now();
      const started = now - 3 * MINUTE;
      const { file } = await makeDatabase(
        underWay(
          A,
          "1",
          [
            toolData({ status: "running", tool: "question", startedAt: started }),
            toolData({ status: "pending", tool: "question" }),
          ],
          now - 5 * MINUTE,
        ),
      );
      const read = await readNow(file, now);
      expect(read.rows[0]?.message?.askedAt).toBe(started);
    });

    test("is looked for on the newest message alone, and a part that is not JSON changes nothing", async () => {
      const now = Date.now();
      const C = sessionId("c3");
      const notJson = (id: string, suffix: string, message: string) =>
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${text(partId(suffix))}, ${text(message)}, ${text(id)}, ${now}, ${now}, ${text('{"type":"tool","tool":"question","state":{"status":"running"')});`;
      const { file } = await makeDatabase([
        // A's question was left waiting on an older message, and a newer prompt came after it.
        ...underWay(A, "1", [toolData({ status: "running", tool: "question" })], now - 3 * MINUTE),
        messageRow({
          id: messageId("u1"),
          sessionId: A,
          createdAt: now - MINUTE,
          data: userData(now - MINUTE),
        }),
        // B has one part that is not JSON, though it reads like a call that waits.
        ...underWay(B, "2", [], now - MINUTE),
        notJson(B, "x2", messageId("a2")),
        // C's call waits, beside a part that is not JSON.
        ...underWay(
          C,
          "3",
          [toolData({ status: "running", tool: "question", startedAt: now - 2 * MINUTE })],
          now - MINUTE,
        ),
        notJson(C, "x3", messageId("a3")),
      ]);
      const read = await readNow(file, now);
      expect(read.state).toBe("read");
      expect(Object.fromEntries(read.rows.map((row) => [row.id, row.message?.askedAt]))).toEqual({
        [A]: null,
        [B]: null,
        [C]: now - 2 * MINUTE,
      });
    });

    test("in a subagent's session is never counted for the session that started it", async () => {
      const now = Date.now();
      const child = sessionId("c3");
      const { file } = await makeDatabase([
        ...underWay(A, "1", [toolData({ status: "running", tool: "task" })], now - MINUTE),
        sessionRow({ id: child, parentId: A, updatedAt: now - MINUTE }),
        messageRow({
          id: messageId("a3"),
          sessionId: child,
          createdAt: now - MINUTE,
          data: assistantData({ createdAt: now - MINUTE }),
        }),
        partRow({
          id: partId("a3"),
          messageId: messageId("a3"),
          sessionId: child,
          createdAt: now - MINUTE,
          data: toolData({ status: "running", tool: "question" }),
        }),
      ]);
      const read = await readNow(file, now);
      expect(read.state).toBe("read");
      expect(read.rows.map((row) => [row.id, row.message?.askedAt])).toEqual([[A, null]]);
    });

    test("is looked for through OpenCode's index of a message's parts, and in no other part", async () => {
      const { file } = await makeDatabase([]);
      const plan = execFileSync(sqlite as string, ["-init", "/dev/null", "-batch", file], {
        input: `EXPLAIN QUERY PLAN ${SESSIONS_QUERY};`,
        encoding: "utf8",
      });
      expect(plan).not.toMatch(/SCAN p\b/);
      // m_tools, m_shell, m_asked_at and p_updated each search the newest message's parts.
      expect(
        plan.match(/SEARCH p USING INDEX part_message_id_id_idx \(message_id=\?\)/g),
      ).toHaveLength(4);
    });
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

  test("each session has the token counts of its newest reply that ended with some, from its own messages alone", async () => {
    const now = Date.now();
    const at = (minutes: number) => now - minutes * MINUTE;
    const C = sessionId("c3");
    const D = sessionId("d4");
    const E = sessionId("e5");
    const F = sessionId("f6");
    const CHILD = sessionId("g7");
    /** OpenCode's counts of one step, as `getUsage` writes them. */
    const counts = (input: number, output: number, reasoning: number, read = 0, write = 0) => ({
      total: input + output + reasoning + read + write,
      input,
      output,
      reasoning,
      cache: { read, write },
    });
    /** A prompt of the person's. */
    const prompt = (id: string, suffix: string, minutes: number) =>
      messageRow({
        id: messageId(suffix),
        sessionId: id,
        createdAt: at(minutes),
        data: userData(at(minutes)),
      });
    /** A step of a reply with these counts, ended unless `ended` is false. */
    const step = (
      id: string,
      suffix: string,
      minutes: number,
      tokens: Record<string, unknown>,
      ended = true,
    ) =>
      messageRow({
        id: messageId(suffix),
        sessionId: id,
        createdAt: at(minutes),
        data: assistantData({
          createdAt: at(minutes),
          ...(ended ? { completedAt: at(minutes), finish: "stop" } : {}),
          tokens,
        }),
      });
    const NONE = counts(0, 0, 0);
    const { file } = await makeDatabase([
      // A reply with counts, some of its prompt read from a cache and some
      // written to one, and some reasoning.
      sessionRow({ id: A, updatedAt: at(9) }),
      prompt(A, "a1u", 10),
      step(A, "a1a", 9, counts(200, 80, 20, 1800, 400)),
      // A reply still under way, after a newer prompt and an older reply of two
      // steps that ended: the counts are the newer step's.
      sessionRow({ id: B, updatedAt: at(1) }),
      prompt(B, "b1u", 8),
      step(B, "b1a", 7, counts(1000, 50, 0, 3000)),
      step(B, "b2a", 6, counts(1200, 60, 0, 3000)),
      prompt(B, "b3u", 2),
      step(B, "b3a", 1, NONE, false),
      // The newest reply ended before its provider sent any counts, as after
      // Esc, and then a command was run with !, a step with no counts of its
      // own: OpenCode wrote 0 for each of both, so the counts are the older reply's.
      sessionRow({ id: C, updatedAt: at(2) }),
      prompt(C, "c1u", 6),
      step(C, "c1a", 5, counts(900, 40, 0)),
      prompt(C, "c2u", 4),
      step(C, "c2a", 3, NONE),
      prompt(C, "c3u", 2),
      messageRow({
        id: messageId("c3a"),
        sessionId: C,
        createdAt: at(2),
        data: assistantData({ createdAt: at(2), completedAt: at(2), tokens: NONE }),
      }),
      partRow({
        id: partId("c3a"),
        messageId: messageId("c3a"),
        sessionId: C,
        createdAt: at(2),
        data: toolData({ status: "completed", tool: "bash" }),
      }),
      // A subagent's session, written after the session that started it: its
      // replies are never counted for that session.
      sessionRow({ id: D, updatedAt: at(2) }),
      prompt(D, "d1u", 5),
      step(D, "d1a", 4, counts(700, 30, 0)),
      sessionRow({ id: CHILD, parentId: D, updatedAt: at(1) }),
      prompt(CHILD, "g1u", 3),
      step(CHILD, "g1a", 1, counts(5000, 500, 0)),
      // The newest message's data is not JSON: it is passed over.
      sessionRow({ id: E, updatedAt: at(1) }),
      prompt(E, "e1u", 5),
      step(E, "e1a", 4, counts(600, 25, 0)),
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${text(messageId("e2a"))}, ${text(E)}, ${at(1)}, ${at(1)}, ${text("not json")});`,
      // Counts that could not be right, which are none rather than an older
      // reply's: a count that is text, and a total smaller than its parts.
      sessionRow({ id: F, updatedAt: at(1) }),
      prompt(F, "f1u", 7),
      step(F, "f1a", 6, counts(800, 35, 0)),
      prompt(F, "f2u", 5),
      step(F, "f2a", 4, { ...counts(600, 25, 0), input: "600" }),
      sessionRow({ id: sessionId("h8"), updatedAt: at(1) }),
      prompt(sessionId("h8"), "h1u", 7),
      step(sessionId("h8"), "h1a", 6, counts(800, 35, 0)),
      prompt(sessionId("h8"), "h2u", 5),
      step(sessionId("h8"), "h2a", 4, { ...counts(600, 25, 0), total: 600 }),
      // The newest reply's whole prompt was read from a cache, or written to
      // one, so its input is 0: it is still the one counted.
      sessionRow({ id: sessionId("j1"), updatedAt: at(1) }),
      prompt(sessionId("j1"), "j1u", 6),
      step(sessionId("j1"), "j1a", 5, counts(500, 20, 0)),
      prompt(sessionId("j1"), "j2u", 4),
      step(sessionId("j1"), "j2a", 3, counts(0, 50, 0, 3000)),
      sessionRow({ id: sessionId("k2"), updatedAt: at(1) }),
      prompt(sessionId("k2"), "k1u", 6),
      step(sessionId("k2"), "k1a", 5, counts(500, 20, 0)),
      prompt(sessionId("k2"), "k2u", 4),
      step(sessionId("k2"), "k2a", 3, counts(0, 40, 0, 0, 2000)),
      // The newest reply has output but no prompt count above 0, as from a
      // provider that sends no prompt counts: it is passed over, and the
      // counts are the older reply's.
      sessionRow({ id: sessionId("l3"), updatedAt: at(1) }),
      prompt(sessionId("l3"), "l1u", 6),
      step(sessionId("l3"), "l1a", 5, counts(1000, 100, 0)),
      prompt(sessionId("l3"), "l2u", 4),
      step(sessionId("l3"), "l2a", 3, counts(0, 50, 0)),
      // A session whose only reply has no tokens at all.
      sessionRow({ id: sessionId("i9"), updatedAt: at(1) }),
      messageRow({
        id: messageId("i1a"),
        sessionId: sessionId("i9"),
        createdAt: at(2),
        data: { role: "assistant", time: { created: at(2), completed: at(2) }, finish: "stop" },
      }),
    ]);
    const read = await readNow(file, now);
    expect(read.state).toBe("read");
    const tokens = Object.fromEntries(read.rows.map((row) => [row.id, row.tokens]));
    expect(tokens).toEqual({
      [A]: { input: 2400, cached: 1800, output: 100 },
      [B]: { input: 4200, cached: 3000, output: 60 },
      [C]: { input: 900, output: 40 },
      [D]: { input: 700, output: 30 },
      [E]: { input: 600, output: 25 },
      [F]: null,
      [sessionId("h8")]: null,
      [sessionId("i9")]: null,
      [sessionId("j1")]: { input: 3000, cached: 3000, output: 50 },
      [sessionId("k2")]: { input: 2000, output: 40 },
      [sessionId("l3")]: { input: 1000, output: 100 },
    });
  });

  test("the reply counted is no further back than the session's 10th newest message", async () => {
    const now = Date.now();
    const at = (minutes: number) => now - minutes * MINUTE;
    /**
     * A session whose one reply that ended has these prompts after it, none of
     * them answered yet. With `tied`, the first prompt was written in the same
     * millisecond as the reply, and its id is ordered after the reply's.
     */
    function waiting(id: string, suffix: string, prompts: number, tied = false): string[] {
      return [
        sessionRow({ id, updatedAt: at(1) }),
        messageRow({
          id: messageId(`${suffix}a`),
          sessionId: id,
          createdAt: at(30),
          data: assistantData({ createdAt: at(30), completedAt: at(30), finish: "stop" }),
        }),
        ...Array.from({ length: prompts }, (_, index) => {
          const createdAt = tied && index === 0 ? at(30) : at(20 - index);
          return messageRow({
            id: messageId(`${suffix}u${index}`),
            sessionId: id,
            createdAt,
            data: userData(createdAt),
          });
        }),
      ];
    }
    const C = sessionId("c3");
    expect(messageId("ca") < messageId("cu0")).toBe(true);
    const { file } = await makeDatabase([
      ...waiting(A, "a", MESSAGES_FOR_TOKENS - 1),
      ...waiting(B, "b", MESSAGES_FOR_TOKENS),
      // The reply is the 11th newest, though the 10th was written in the same millisecond.
      ...waiting(C, "c", MESSAGES_FOR_TOKENS, true),
    ]);
    const read = await readNow(file, now);
    const tokens = Object.fromEntries(read.rows.map((row) => [row.id, row.tokens]));
    expect(tokens).toEqual({ [A]: { input: 10, output: 20 }, [B]: null, [C]: null });
  });

  test("the walk back to the counted reply uses OpenCode's index of a session's messages, and stops at the 10th newest", async () => {
    const { file } = await makeDatabase([]);
    const plan = execFileSync(sqlite as string, ["-init", "/dev/null", "-batch", file], {
      input: `EXPLAIN QUERY PLAN ${SESSIONS_QUERY};`,
      encoding: "utf8",
    });
    // The newest messages, newest first, from the index, bounded below by the
    // 10th newest's time and id.
    expect(plan).toMatch(
      /SEARCH y USING INDEX message_session_time_created_id_idx \(session_id=\? AND \(time_created,id\)>\(\?,\?\)\)/,
    );
    // The 10th newest is found from the index alone, without reading any message's data.
    expect(plan).toMatch(
      /SEARCH z USING COVERING INDEX message_session_time_created_id_idx \(session_id=\?\)/,
    );
    expect(plan).toMatch(/SEARCH r USING INDEX sqlite_autoindex_message_1 \(id=\?\)/);
  });

  test("a count that is text is never printed, and the counts of 200 sessions add little to the answer", async () => {
    const now = Date.now();
    const ids = Array.from({ length: MAX_SESSIONS }, (_, index) => sessionId(`t${index}`));
    const longest = 2 ** 53 - 1;
    const { file } = await makeDatabase([
      ...ids.flatMap((id, index) => [
        sessionRow({ id, updatedAt: now - MINUTE }),
        messageRow({
          id: messageId(`t${index}`),
          sessionId: id,
          createdAt: now - MINUTE,
          data: assistantData({
            createdAt: now - MINUTE,
            completedAt: now - MINUTE,
            finish: "stop",
            // The first session's counts are words, and every other's as long as a count gets.
            tokens:
              index === 0
                ? {
                    total: PRIVATE_WORDS,
                    input: PRIVATE_WORDS,
                    output: { note: PRIVATE_WORDS },
                    reasoning: [PRIVATE_WORDS],
                    cache: { read: PRIVATE_WORDS, write: PRIVATE_WORDS },
                  }
                : {
                    total: longest,
                    input: longest,
                    output: longest,
                    reasoning: longest,
                    cache: { read: longest, write: longest },
                  },
          }),
        }),
      ]),
    ]);
    const printed = await answers(file, "whole");
    expect(printed).not.toContain(PRIVATE_WORDS);
    // Six numbers of 16 digits, and their names, for each session but the first:
    // under 200 bytes a session, against the 4 MiB sqlite3 may print in all.
    const counted = printed.match(/"r_[a-z_]+":\d+/g) ?? [];
    expect(counted).toHaveLength(6 * (MAX_SESSIONS - 1));
    expect(counted.join(",").length).toBeLessThan(MAX_SESSIONS * 200);
    expect(printed.length).toBeLessThan(512 * 1024);
    const read = await readNow(file, now);
    expect(read.rows).toHaveLength(MAX_SESSIONS);
    expect(read.rows.every((row) => row.tokens === null)).toBe(true);
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
