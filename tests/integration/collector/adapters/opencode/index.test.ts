import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/opencode/database";
import { BASIS, BASIS_CLOSED, createOpencodeAdapter } from "@collector/adapters/opencode/index";
import type { OpencodeProcessReader } from "@collector/adapters/opencode/processes";
import { PROBE_QUERY, SESSIONS_QUERY, sqliteUri } from "@collector/adapters/opencode/sessionRows";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  assistantData,
  FOLDER,
  HOUR,
  messageId,
  messageRow,
  MINUTE,
  partId,
  partRow,
  PRIVATE_WORDS,
  SCHEMA,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  textData,
  toolData,
  userData,
} from "@tests/fixtures/opencode/opencode";
import { tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, on a copy of
// `tests/fixtures/opencode/home`, OpenCode's data folder as OpenCode 1.19.0
// lays it out, with a database this test writes. A second sqlite3 stands in
// for OpenCode, and what `ps` would say of it is whether that one runs: the
// real `ps` is asked in processes.test.ts. Where there is no sqlite3, as on
// Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const FIXTURE_HOME = fileURLToPath(new URL("../../../../fixtures/opencode/home", import.meta.url));

const IDLE = sessionId("a1");
const WORKING = sessionId("b2");
const FAILED = sessionId("c3");
const CHILD = sessionId("d4");
const ARCHIVED = sessionId("e5");
const OLD = sessionId("f6");

/** The rows of every session the database holds, relative to `now`. */
function rows(now: number): string[] {
  const at = (minutes: number) => now - minutes * MINUTE;
  const step = (id: string, suffix: string, data: Record<string, unknown>, minutes: number) => [
    messageRow({ id: messageId(suffix), sessionId: id, createdAt: at(minutes), data }),
    partRow({
      id: partId(suffix),
      messageId: messageId(suffix),
      sessionId: id,
      createdAt: at(minutes),
      data: textData(),
    }),
  ];
  return [
    // Idle: its last step ended the turn.
    sessionRow({ id: IDLE, title: "Rename the helper", createdAt: at(30), updatedAt: at(5) }),
    ...step(IDLE, "a1u", userData(at(6)), 6),
    ...step(
      IDLE,
      "a1a",
      assistantData({ createdAt: at(5), completedAt: at(5), finish: "stop" }),
      5,
    ),
    // Working: still the title OpenCode gives a new session, a turn that
    // ended, and a newer prompt whose step runs a tool.
    sessionRow({
      id: WORKING,
      title: "New session - 2026-10-01T11:00:00.000Z",
      createdAt: at(20),
      updatedAt: at(1),
    }),
    ...step(WORKING, "b1u", userData(at(15)), 15),
    ...step(
      WORKING,
      "b1a",
      assistantData({ createdAt: at(14), completedAt: at(14), finish: "stop" }),
      14,
    ),
    ...step(WORKING, "b2u", userData(at(2)), 2),
    ...step(WORKING, "b2a", assistantData({ createdAt: at(1) }), 1),
    partRow({
      id: partId("b2t"),
      messageId: messageId("b2a"),
      sessionId: WORKING,
      createdAt: at(1),
      data: toolData({ status: "running" }),
    }),
    // Failed: its reply ended on an error.
    sessionRow({ id: FAILED, title: "Write the notes", createdAt: at(40), updatedAt: at(10) }),
    ...step(
      FAILED,
      "c3a",
      assistantData({ createdAt: at(10), completedAt: at(10), error: "APIError" }),
      10,
    ),
    // A subagent's session, an archived one and one not written for three days are left out.
    sessionRow({
      id: CHILD,
      title: "Look around (@explore subagent)",
      parentId: IDLE,
      updatedAt: at(3),
    }),
    sessionRow({ id: ARCHIVED, title: "Old work", updatedAt: at(3), archivedAt: at(3) }),
    sessionRow({
      id: OLD,
      title: "Older work",
      createdAt: now - 80 * HOUR,
      updatedAt: now - 72 * HOUR,
    }),
  ];
}

/** Each file under a folder, by path, with its hash, size and modified time. */
async function snapshotOf(dir: string, names: string[]): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    const hash = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    found[name] = `${hash} ${info.size} ${info.mtimeMs}`;
  }
  return found;
}

const PLACEHOLDERS = [
  "auth.json",
  "mcp-auth.json",
  "opencode-dev.db",
  "storage/session/global/ses_000000000000000000000000c1.json",
  "log/opencode.log",
];

/** A copy of the fixture's data folder, with OpenCode's log and a database of these rows, closed. */
async function makeHome(now: number): Promise<{ home: string; file: string }> {
  const home = path.join(await tempDir(), "opencode");
  await cp(FIXTURE_HOME, home, { recursive: true });
  // Logs are kept out of git, so the log is written here.
  await mkdir(path.join(home, "log"), { recursive: true });
  await writeFile(path.join(home, "log", "opencode.log"), `Placeholder. ${PRIVATE_WORDS}\n`);
  const file = path.join(home, "opencode.db");
  execFileSync(sqlite as string, [
    file,
    ["PRAGMA journal_mode=WAL;", SCHEMA, ...rows(now)].join("\n"),
  ]);
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  return { home, file };
}

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof ReadOnlyIo; path: string }[] = [];
  const io: ReadOnlyIo = {
    readdir: (target) => (calls.push({ method: "readdir", path: target }), nodeIo.readdir(target)),
    stat: (target) => (calls.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (calls.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    openRegular: (target) => (
      calls.push({ method: "openRegular", path: target }),
      nodeIo.openRegular(target)
    ),
  };
  return { io, calls };
}

/** The adapter on this folder, as OpenCode's default one, with the real sqlite3, and every run of it written down. */
function adapterFor(
  home: string,
  now: number,
  processes: OpencodeProcessReader = { read: async () => ({ ok: true, running: false }) },
) {
  const { io, calls } = recordingIo();
  const runs: (readonly string[])[] = [];
  const file = path.join(home, "opencode.db");
  const reader = createDatabaseReader({
    file,
    io,
    platform: process.platform,
    run: (binary, args) => (runs.push(args), runSqlite(binary, args)),
  });
  // The data folder is OpenCode's own here, found through XDG_DATA_HOME.
  const adapter = createOpencodeAdapter({
    env: { XDG_DATA_HOME: path.dirname(home) },
    homeDir: "/Users/example",
    now: () => now,
    io,
    reader,
    processes,
    processCheckMs: 0,
  });
  return { adapter, calls, runs, file };
}

/** A second sqlite3 that keeps the database open, as OpenCode does while it runs. */
function holdOpen(file: string) {
  const child = spawn(sqlite as string, ["-batch", file], { stdio: ["pipe", "ignore", "ignore"] });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let running = true;
  child.once("exit", () => {
    running = false;
  });
  return {
    /** What `ps` would say: whether this stand-in for OpenCode runs. */
    processes: {
      read: async () => ({ ok: true, running }) as const,
    } satisfies OpencodeProcessReader,
    async write(statements: string[], mark: string): Promise<void> {
      child.stdin.write(`${statements.join("\n")}\n.once ${mark}\nSELECT 'done';\n`);
      const until = Date.now() + 10_000;
      while (
        !(await stat(mark).then(
          (info) => info.size > 0,
          () => false,
        ))
      ) {
        if (Date.now() > until) throw new Error("sqlite3 did not write in time.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    /**
     * Ends it with SIGKILL, so it never closes the database and leaves its -wal
     * full, as OpenCode 1.19.0 leaves it when it quits under Bun.
     */
    async quit(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    },
  };
}

describe.skipIf(sqlite === null)("the OpenCode adapter, with the real sqlite3", () => {
  test("lists each root session with its name, folder and status while OpenCode runs, and finishes them once it quits, leaving its -wal full", async () => {
    const now = Date.now();
    const { home, file } = await makeHome(now);
    const writer = holdOpen(file);
    const marks = await tempDir();
    // Something written while it is open, as OpenCode writes as it works.
    await writer.write(
      [`UPDATE session SET time_updated = ${now - 30_000} WHERE id = '${WORKING}';`],
      path.join(marks, "1"),
    );
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);
    const placeholders = await snapshotOf(home, PLACEHOLDERS);
    const { adapter, calls, runs } = adapterFor(home, now, writer.processes);

    const open = await adapter.poll();
    expect(open.health.state).toBe("ok");
    expect(open.basis).toBe(BASIS);
    expect(
      open.sessions.map((session) => [session.id, session.name, session.cwd, session.status]),
    ).toEqual([
      [`opencode:${WORKING}`, "demo", FOLDER, "working"],
      [`opencode:${IDLE}`, "Rename the helper", FOLDER, "idle"],
      [`opencode:${FAILED}`, "Write the notes", FOLDER, "failed"],
    ]);
    // Working since the person's newest prompt, not the first.
    expect(open.sessions[0]).toMatchObject({
      statusSince: now - 2 * MINUTE,
      startedAt: now - 20 * MINUTE,
    });

    // OpenCode quits, leaving its -wal full: no OpenCode program runs, so
    // every session but the failed one is finished.
    await writer.quit();
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);
    const closed = await adapter.poll();
    expect(closed.basis).toBe(BASIS_CLOSED);
    expect(closed.sessions.map((session) => [session.id, session.status])).toEqual([
      [`opencode:${WORKING}`, "finished"],
      [`opencode:${IDLE}`, "finished"],
      [`opencode:${FAILED}`, "failed"],
    ]);

    // Nothing of what was written, and no secret, reaches what the adapter says.
    for (const said of [JSON.stringify(open), JSON.stringify(closed)]) {
      expect(said).not.toContain(PRIVATE_WORDS);
      expect(said).not.toContain(SECRET_WORDS);
      for (const left of [CHILD, ARCHIVED, OLD]) expect(said).not.toContain(left);
    }

    // sqlite3 is given only the fixed arguments: its settings off, JSON out, the database and a fixed question.
    expect(runs.length).toBeGreaterThan(0);
    for (const args of runs) {
      expect(args.slice(0, 4)).toEqual(["-init", "/dev/null", "-batch", "-json"]);
      expect([sqliteUri(file, "with-wal"), sqliteUri(file, "whole")]).toContain(args[4]);
      expect([PROBE_QUERY, SESSIONS_QUERY]).toContain(args[5]);
      expect(args).toHaveLength(6);
    }

    // The adapter itself opens no file: it looks at the folder and the three database files alone.
    const looked = new Set(calls.map((call) => `${call.method} ${call.path}`));
    expect(looked).toEqual(
      new Set([`stat ${home}`, `lstat ${file}`, `lstat ${file}-wal`, `lstat ${file}-shm`]),
    );
    // And no file it must never open was changed.
    expect(await snapshotOf(home, PLACEHOLDERS)).toEqual(placeholders);
  });

  test("a poll where nothing changed runs no sqlite3", async () => {
    const now = Date.now();
    const { home } = await makeHome(now);
    const { adapter, runs } = adapterFor(home, now);
    await adapter.poll();
    const after = runs.length;
    expect(after).toBe(2);
    await adapter.poll();
    await adapter.poll();
    expect(runs).toHaveLength(after);
  });
});
