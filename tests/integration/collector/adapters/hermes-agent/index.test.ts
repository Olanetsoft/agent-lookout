import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import { runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { BASIS, createHermesAgentAdapter } from "@collector/adapters/hermes-agent/index";
import { parsePidNamespace } from "@collector/adapters/hermes-agent/processes";
import {
  PROBE_QUERY,
  SESSIONS_QUERY,
  sqliteUri,
} from "@collector/adapters/hermes-agent/sessionRows";
import { createSqliteFinder } from "@collector/adapters/hermes-agent/sqlite";
import { nodeIo, type OpenFile, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import type { Session } from "@core/sessions/session";
import {
  FOLDER,
  messageRow,
  MINUTE,
  PRIVATE_WORDS,
  SCENE,
  SCHEMA,
  sceneRows,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  TIP_FOLDER,
} from "@tests/fixtures/hermes-agent/hermesAgent";
import { tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, the real signal 0 and, on
// Linux, the real /proc/self/ns/pid, on a copy of
// `tests/fixtures/hermes-agent/home`, a Hermes Agent root as v0.22.5 lays one
// out, with a default profile and a `coder` profile, and databases this test
// writes. The default profile's is in rollback-journal mode and the coder
// profile's in WAL mode. The process that holds the leases is this test's
// own, and one whose holder is gone is a process this test started and that
// has ended. Where there is no sqlite3, as on Windows, there is nothing to run.

const sqlite = await (async () => {
  if (process.platform === "win32") return null;
  const picked = await createSqliteFinder().pick("any");
  return picked.kind === "found" ? picked.path : null;
})();

/**
 * Put first in every sqlite3 this test runs to write a database: sqlite3 runs
 * the person's own ~/.sqliterc otherwise, found from the account whatever HOME
 * says, and no test reads the real home.
 */
const NO_INIT = ["-init", "/dev/null"];

const FIXTURE_HOME = fileURLToPath(
  new URL("../../../../fixtures/hermes-agent/home", import.meta.url),
);

/** Hermes Agent's files the adapter must never open, as laid out in the fixture, and two this test writes. */
const PLACEHOLDERS = [
  ".env",
  "SOUL.md",
  "active_profile",
  "auth.json",
  "config.yaml",
  "cron/jobs.json",
  "gateway.pid",
  "gateway_state.json",
  "kanban.db",
  "logs/gateway.log",
  "memories/MEMORY.md",
  "profiles/.deleted/old-profile",
  "profiles/coder/auth.json",
  "profiles/coder/config.yaml",
  "profiles/coder/memories/USER.md",
  "runtime/active_sessions.json",
  "sessions/20261001_110000_0000a1.jsonl",
  "sessions/sessions.json",
];

const CODER_IDLE = sessionId("c9");
const CODER_NEW = sessionId("ca");

/** The pid of a process that has ended. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid as number;
}

/** This process's own pid namespace on Linux, which Hermes Agent stamps on a lease there. */
async function ownNamespace(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  return parsePidNamespace(await readlink("/proc/self/ns/pid")) ?? undefined;
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

/** A database in this journal mode, with these rows, closed, with nothing beside it. */
async function writeDatabase(file: string, mode: "rollback" | "wal", rows: string[]) {
  await mkdir(path.dirname(file), { recursive: true });
  const journal = mode === "wal" ? "PRAGMA journal_mode=WAL;" : "PRAGMA journal_mode=DELETE;";
  execFileSync(sqlite as string, [...NO_INIT, file, [journal, SCHEMA, ...rows].join("\n")]);
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
}

/** A copy of the fixture's root, with the files git does not keep, and both profiles' databases. */
async function makeRoot(now: number) {
  const root = path.join(await tempDir(), "hermes");
  await cp(FIXTURE_HOME, root, { recursive: true });
  // git keeps no `.env` and no log, so they are written here.
  await writeFile(path.join(root, ".env"), `DEMO_API_KEY=${SECRET_WORDS}\n`);
  await mkdir(path.join(root, "logs"), { recursive: true });
  await writeFile(path.join(root, "logs", "gateway.log"), `Placeholder. ${PRIVATE_WORDS}\n`);
  const defaultDatabase = path.join(root, "state.db");
  const coderDatabase = path.join(root, "profiles", "coder", "state.db");
  const pidns = await ownNamespace();
  await writeDatabase(
    defaultDatabase,
    "rollback",
    sceneRows(now, { livePid: process.pid, deadPid: await endedPid(), pidns }),
  );
  await writeDatabase(coderDatabase, "wal", [
    sessionRow({ id: CODER_IDLE, title: "Coder work", startedAt: now - 30 * MINUTE }),
    messageRow({ sessionId: CODER_IDLE, role: "assistant", at: now - 12 * MINUTE, finish: "stop" }),
  ]);
  return { root, defaultDatabase, coderDatabase };
}

/** The real file system, with every call and every byte range read written down. */
function recordingIo() {
  const calls: { method: keyof ReadOnlyIo; path: string }[] = [];
  const reads: { path: string; position: number; length: number }[] = [];
  const io: ReadOnlyIo = {
    readdir: (target) => (calls.push({ method: "readdir", path: target }), nodeIo.readdir(target)),
    stat: (target) => (calls.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (calls.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    async openRegular(target): Promise<OpenFile> {
      calls.push({ method: "openRegular", path: target });
      const opened = await nodeIo.openRegular(target);
      return {
        info: opened.info,
        read: (position, length) => (
          reads.push({ path: target, position, length }),
          opened.read(position, length)
        ),
        close: () => opened.close(),
      };
    },
  };
  return { io, calls, reads };
}

/** The adapter on this root, named by Hermes Agent's own HERMES_HOME, with every run of sqlite3 written down. */
function adapterFor(root: string, now: number) {
  const { io, calls, reads } = recordingIo();
  const runs: (readonly string[])[] = [];
  const adapter = createHermesAgentAdapter({
    env: { HERMES_HOME: root },
    homeDir: "/Users/example",
    now: () => now,
    io,
    run: (binary, args) => (runs.push(args), runSqlite(binary, args)),
  });
  return { adapter, calls, reads, runs };
}

/** What each session shows, by its id. */
function shown(sessions: Session[]) {
  return Object.fromEntries(
    sessions.map((session) => [
      session.id,
      [
        session.name,
        session.cwd,
        session.surface,
        session.status,
        session.waitingReason ?? null,
        session.statusSince,
      ],
    ]),
  );
}

describe.skipIf(sqlite === null)("the Hermes Agent adapter, with the real sqlite3", () => {
  test("lists each conversation of both profiles with its name, folder, app and status, and touches nothing it must not", async () => {
    const now = Date.now();
    const at = (minutes: number) => now - minutes * MINUTE;
    const { root, defaultDatabase, coderDatabase } = await makeRoot(now);
    const placeholders = await snapshotOf(root, PLACEHOLDERS);
    const { adapter, calls, reads, runs } = adapterFor(root, now);

    const polled = await adapter.poll();
    expect(polled.health.state).toBe("ok");
    expect(polled.basis).toBe(BASIS);
    expect(polled.health.parts).toEqual({
      "hermes-agent:default/": BASIS,
      "hermes-agent:coder/": BASIS,
    });
    const id = (root_: string, profile = "default") => `hermes-agent:${profile}/${root_}`;
    expect(shown(polled.sessions)).toEqual({
      [id(SCENE.chainRoot)]: ["Rename the helper", TIP_FOLDER, "terminal", "working", null, at(2)],
      [id(SCENE.question)]: ["Write the notes", FOLDER, "desktop", "needs-you", "question", at(3)],
      [id(SCENE.approval)]: [
        "Clean the build",
        FOLDER,
        "terminal",
        "needs-you",
        "permission",
        at(4),
      ],
      [id(SCENE.failed)]: [id(SCENE.failed), null, "unknown", "failed", null, at(10)],
      [id(SCENE.finished)]: ["Read the logs", FOLDER, "terminal", "finished", null, at(20)],
      [id(SCENE.branch)]: ["Read the logs again", FOLDER, "terminal", "idle", null, at(6)],
      [id(SCENE.cron)]: ["Nightly report", null, "unknown", "idle", null, at(7)],
      [id(SCENE.resetParent)]: ["Morning chat", null, "unknown", "finished", null, at(30)],
      [id(SCENE.resetChild)]: ["Afternoon chat", null, "unknown", "idle", null, at(8)],
      [id(SCENE.filtered)]: ["Filtered reply", FOLDER, "terminal", "failed", null, at(9)],
      [id(SCENE.deadHolder)]: ["Killed gateway", FOLDER, "terminal", "idle", null, at(5)],
      [id(CODER_IDLE, "coder")]: ["Coder work", FOLDER, "terminal", "idle", null, at(12)],
    });

    // Nothing of what was written, no secret, no label, and nothing left out reaches what the adapter says.
    const said = JSON.stringify(polled);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain(SECRET_WORDS);
    for (const out of [
      SCENE.chainTip,
      SCENE.delegate,
      SCENE.hidden,
      SCENE.archived,
      SCENE.tool,
      SCENE.kanban,
      SCENE.oneshot,
      SCENE.old,
    ]) {
      expect(said).not.toContain(out);
    }

    // sqlite3 is given only the fixed arguments: its settings off, JSON out, a
    // second's wait in rollback-journal mode, the database and a fixed question.
    expect(runs).toHaveLength(4);
    for (const args of runs) {
      expect(args.slice(0, 4)).toEqual(["-init", "/dev/null", "-batch", "-json"]);
      const rest = args.slice(4);
      if (rest[0] === "-cmd") {
        expect(rest.slice(0, 2)).toEqual(["-cmd", ".timeout 1000"]);
        expect(rest[2]).toBe(sqliteUri(defaultDatabase, "rollback"));
      } else {
        expect(rest[0]).toBe(sqliteUri(coderDatabase, "whole"));
      }
      expect([PROBE_QUERY, SESSIONS_QUERY]).toContain(args.at(-1));
    }

    // The adapter itself opens nothing but the first 20 bytes of each database,
    // and looks at nothing but the root, its profiles and their three database files.
    expect(
      new Set(calls.filter((call) => call.method === "openRegular").map((call) => call.path)),
    ).toEqual(new Set([defaultDatabase, coderDatabase]));
    expect(reads.map((read) => [read.path, read.position, read.length]).sort()).toEqual(
      [
        [coderDatabase, 0, 20],
        [defaultDatabase, 0, 20],
      ].sort(),
    );
    expect(new Set(calls.map((call) => `${call.method} ${call.path}`))).toEqual(
      new Set([
        `stat ${root}`,
        `readdir ${path.join(root, "profiles")}`,
        `lstat ${path.join(root, "profiles", "coder")}`,
        ...[defaultDatabase, coderDatabase].flatMap((database) => [
          `lstat ${database}`,
          `lstat ${database}-wal`,
          `lstat ${database}-shm`,
          `openRegular ${database}`,
        ]),
      ]),
    );
    // And no file it must never open was changed, nor any file made beside the databases.
    expect(await snapshotOf(root, PLACEHOLDERS)).toEqual(placeholders);
    for (const database of [defaultDatabase, coderDatabase]) {
      for (const beside of ["-wal", "-shm", "-journal"]) {
        await expect(stat(`${database}${beside}`)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  });

  test("a profile whose newest commits are in a live -wal is read with a sqlite3 that passes Hermes Agent's test, or named as not read, leaving the other profile's sessions be", async () => {
    const now = Date.now();
    const { root, coderDatabase } = await makeRoot(now);
    const { adapter, runs } = adapterFor(root, now);
    await adapter.poll();

    // Hermes Agent's gateway opens the coder profile's database and writes a new conversation into its -wal.
    const writer = spawn(sqlite as string, [...NO_INIT, "-batch", coderDatabase], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    onTestFinished(() => {
      writer.kill("SIGKILL");
    });
    const mark = path.join(await tempDir(), "written");
    writer.stdin.write(
      [
        "PRAGMA busy_timeout = 5000;",
        sessionRow({ id: CODER_NEW, title: "Coder, again", startedAt: now - MINUTE }),
        messageRow({ sessionId: CODER_NEW, role: "user", at: now - 30_000 }),
        `.once ${mark}`,
        "SELECT 'done';",
        "",
      ].join("\n"),
    );
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
    expect((await lstat(`${coderDatabase}-wal`)).size).toBeGreaterThan(0);
    const before = await snapshotOf(path.dirname(coderDatabase), [
      "state.db",
      "state.db-wal",
      "state.db-shm",
    ]);
    const ran = runs.length;

    const polled = await adapter.poll();
    const wanted = await createSqliteFinder().pick("wal-safe");
    const sqliteFact = polled.health.watching?.find(
      (fact) => fact.label === "sqlite3 for a live -wal",
    )?.value;
    if (wanted.kind === "found") {
      expect(polled.health.state).toBe("ok");
      expect(polled.sessions.map((session) => session.id)).toContain(
        `hermes-agent:coder/${CODER_NEW}`,
      );
      expect(polled.health.parts).toEqual({
        "hermes-agent:default/": BASIS,
        "hermes-agent:coder/": BASIS,
      });
      expect(sqliteFact).toBe(`${wanted.path} ${(wanted.version ?? []).join(".")}`);
      expect(
        runs.slice(ran).every((args) => args.includes(sqliteUri(coderDatabase, "with-wal"))),
      ).toBe(true);
    } else {
      // As on a Linux whose sqlite3 has the WAL-reset bug, as Ubuntu's does.
      expect(polled.health.state).toBe("ok");
      expect(polled.health.detail).toContain(
        "Not read: the coder profile, because its -wal file holds something, and no sqlite3 found passes Hermes Agent's WAL-reset test.",
      );
      expect(polled.health.parts).toEqual({ "hermes-agent:default/": BASIS });
      expect(
        polled.sessions.every((session) => session.id.startsWith("hermes-agent:default/")),
      ).toBe(true);
      expect(sqliteFact).toContain("none trusted: ");
      expect(runs).toHaveLength(ran);
    }
    expect(
      await snapshotOf(path.dirname(coderDatabase), ["state.db", "state.db-wal", "state.db-shm"]),
    ).toEqual(before);
  });

  test("a poll where nothing changed runs no sqlite3, while the leases are judged again", async () => {
    const now = Date.now();
    const { root } = await makeRoot(now);
    const { adapter, runs } = adapterFor(root, now);
    await adapter.poll();
    expect(runs).toHaveLength(4);
    await adapter.poll();
    const again = await adapter.poll();
    expect(runs).toHaveLength(4);
    expect(
      again.sessions.find((session) => session.id === `hermes-agent:default/${SCENE.chainRoot}`)
        ?.status,
    ).toBe("working");
  });
});
