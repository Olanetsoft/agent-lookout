import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCodexAdapter, type CodexAdapterOptions } from "@collector/adapters/codex/index";
import { nodeIo, type CodexIo } from "@collector/adapters/codex/io";
import type { Session } from "@core/sessions/session";
import {
  fixtureSessions,
  HOME,
  ids,
  lockPath,
  metaLine,
  MINUTE,
  NOW,
  rollout,
  rolloutPath,
  threadId,
  turnLine,
} from "@tests/fixtures/codex";
import { handClock, healthy, inTimeZone, noLockFolder } from "@tests/support/adapters/codexAdapter";
import { CODEX_FIXTURE_HOME, makeCodexHome, tempDir } from "@tests/support/node/tempFiles";

/** An adapter pointed at this folder, with the clock at the fixture's `NOW`. */
function adapterFor(home: string, options: CodexAdapterOptions = {}) {
  return createCodexAdapter({
    env: { AGENT_LOOKOUT_CODEX_HOME: home },
    homeDir: HOME,
    now: () => NOW,
    ...options,
  });
}

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof CodexIo; path: string }[] = [];
  const io: CodexIo = {
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

/**
 * Everything under a folder: each ordinary file's hash, size and modified time,
 * each link's target and each other thing's kind. Nothing but ordinary files is
 * opened, so a pipe cannot hold it up.
 */
async function snapshotOf(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const target = path.join(dir, name);
      const relative = path.relative(root, target);
      const info = await lstat(target);
      if (info.isDirectory()) {
        found[relative] = "folder";
        await walk(target);
      } else if (info.isSymbolicLink()) {
        found[relative] = `link to ${await readlink(target)}`;
      } else if (info.isFile()) {
        const hash = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        found[relative] = `${hash} ${info.size} ${info.mtimeMs}`;
      } else {
        found[relative] = `other ${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return found;
}

/** The sessions as the fixture expects them, with what every Codex session has in common. */
const expectedSessions = fixtureSessions.map((session) => ({
  ...session,
  source: "codex",
  cwd: `/Users/example/code/${session.project}`,
  links: {},
  stale: false,
}));

const byId = (sessions: Session[]) => [...sessions].sort((a, b) => (a.id < b.id ? -1 : 1));

describe("the Codex adapter, on a folder laid out as Codex lays it out", () => {
  test("lists each session with its name, folder, app and status, in every time zone", async () => {
    for (const zone of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata"]) {
      await inTimeZone(zone, async () => {
        const result = await adapterFor(CODEX_FIXTURE_HOME).poll();
        expect(result.health, zone).toMatchObject({
          id: "codex",
          state: "ok",
          detail: healthy(path.join(CODEX_FIXTURE_HOME, "sessions")),
        });
        expect(result.basis).toBe("files");
        // Left out: the subagent, the mcp thread, the compressed and archived
        // files, and the session last written more than a day ago.
        expect(byId(result.sessions), zone).toEqual(expectedSessions);
      });
    }
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const before = await snapshotOf(CODEX_FIXTURE_HOME);
    const clock = handClock();
    const adapter = adapterFor(CODEX_FIXTURE_HOME, { now: clock.now });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    expect(await snapshotOf(CODEX_FIXTURE_HOME)).toEqual(before);
  });

  test("opens only session files and the names file, and only lists the folder of locks", async () => {
    const { io, calls } = recordingIo();
    const clock = handClock();
    const adapter = adapterFor(CODEX_FIXTURE_HOME, { io, now: clock.now });
    await adapter.poll();

    const sessionFile = /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/;
    const indexFile = path.join(CODEX_FIXTURE_HOME, "session_index.jsonl");
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.length).toBeGreaterThan(0);
    for (const file of opened) {
      expect(sessionFile.test(file) || file === indexFile, file).toBe(true);
    }
    expect(opened).toContain(indexFile);

    const locks = path.join(CODEX_FIXTURE_HOME, "thread-writer-locks");
    expect(calls.filter((call) => call.path.startsWith(locks))).toEqual([
      { method: "readdir", path: locks },
    ]);
    for (const never of [
      "archived_sessions",
      "auth.json",
      "config.toml",
      "history.jsonl",
      ".sqlite",
      ".zst",
    ]) {
      expect(
        calls.filter((call) => call.path.includes(never)),
        never,
      ).toEqual([]);
    }

    // A poll where nothing changed opens nothing.
    calls.length = 0;
    clock.advance(2_000);
    await adapter.poll();
    expect(calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });

  test("a turn that ends shows as idle, and once Codex closes the session it is finished", async () => {
    const home = await makeCodexHome({}, { copyFixture: true });
    const clock = handClock();
    const adapter = adapterFor(home, { now: clock.now });
    const status = async () =>
      (await adapter.poll()).sessions.find((session) => session.id === `codex:${ids.working}`);

    expect(await status()).toMatchObject({ status: "working" });

    await appendFile(
      rolloutPath(home, "2026-10-01T09-00-00", ids.working),
      rollout(turnLine(NOW - MINUTE, "task_complete")),
    );
    clock.advance(2_000);
    expect(await status()).toMatchObject({ status: "idle", statusSince: NOW - MINUTE });

    await rm(lockPath(home, ids.working));
    clock.advance(2_000);
    expect(await status()).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
  });

  test("with no folder of locks, as before Codex 0.155, it says so and nothing is finished", async () => {
    const home = await makeCodexHome({}, { copyFixture: true });
    await rm(path.join(home, "thread-writer-locks"), { recursive: true });
    const { health, sessions } = await adapterFor(home).poll();

    expect(health.detail).toBe(
      `${healthy(path.join(home, "sessions"))}${noLockFolder(path.join(home, "thread-writer-locks"))}`,
    );
    expect(sessions.some((session) => session.status === "finished")).toBe(false);
    expect(sessions.find((session) => session.id === `codex:${ids.finished}`)?.status).toBe("idle");
    // Without its lock, a resumed session in an older folder is not found: a known gap.
    expect(sessions.some((session) => session.id === `codex:${ids.resumed}`)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "a link, a pipe and an oversized first line are not read, and do not hold up the poll",
    async () => {
      const outside = await tempDir();
      const linked = path.join(outside, "elsewhere.jsonl");
      await writeFile(
        linked,
        rollout(
          metaLine(NOW - MINUTE, { id: threadId("e1"), cwd: "/Users/example/code/demo-linked" }),
          turnLine(NOW - MINUTE, "task_started"),
        ),
      );
      const big = (size: number, thread: string, folder: string) =>
        rollout(
          metaLine(NOW - MINUTE, {
            id: thread,
            cwd: `/Users/example/code/${folder}`,
            base_instructions: { text: "x".repeat(size) },
          }),
          turnLine(NOW - MINUTE, "task_started"),
        );
      const home = await makeCodexHome(
        {
          [path.relative("/h", rolloutPath("/h", "2026-10-01T11-59-03", threadId("e3")))]: big(
            3 * 1024 * 1024,
            threadId("e3"),
            "demo-huge",
          ),
          [path.relative("/h", rolloutPath("/h", "2026-10-01T11-59-04", threadId("e4")))]: big(
            1024 * 1024,
            threadId("e4"),
            "demo-large",
          ),
          ...Object.fromEntries(
            ["e1", "e2", "e3", "e4"].map((suffix) => [
              `thread-writer-locks/${threadId(suffix)}.lock`,
              "",
            ]),
          ),
        },
        { copyFixture: true },
      );
      const link = rolloutPath(home, "2026-10-01T11-59-01", threadId("e1"));
      const pipe = rolloutPath(home, "2026-10-01T11-59-02", threadId("e2"));
      await symlink(linked, link);
      // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
      execFileSync("mkfifo", [pipe]);
      const before = await snapshotOf(home);

      const { io, calls } = recordingIo();
      const started = Date.now();
      const { sessions } = await adapterFor(home, { io }).poll();
      expect(Date.now() - started).toBeLessThan(3_000);

      const listed = sessions.map((session) => session.id);
      expect(listed).toContain(`codex:${threadId("e4")}`);
      for (const suffix of ["e1", "e2", "e3"]) {
        expect(listed).not.toContain(`codex:${threadId(suffix)}`);
      }
      const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
      expect(opened).not.toContain(link);
      expect(opened).not.toContain(pipe);
      expect(await snapshotOf(home)).toEqual(before);
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "a names file that is a pipe is not read, and sessions are named after their folder",
    async () => {
      const home = await makeCodexHome({}, { copyFixture: true });
      await rm(path.join(home, "session_index.jsonl"));
      execFileSync("mkfifo", [path.join(home, "session_index.jsonl")]);
      const started = Date.now();
      const { sessions } = await adapterFor(home).poll();
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(sessions.find((session) => session.id === `codex:${ids.working}`)?.name).toBe("demo");
    },
    10_000,
  );
});

describe("finding Codex's folder", () => {
  test("with no ~/.codex, Codex is not found, and that is all that is said", async () => {
    const userHome = await tempDir();
    const result = await createCodexAdapter({ env: {}, homeDir: userHome, now: () => NOW }).poll();
    expect(result).toEqual({
      health: {
        id: "codex",
        label: "Codex",
        state: "unavailable",
        detail:
          "Codex was not found: there is no ~/.codex folder. Agent Lookout looks again every minute.",
        watching: [
          { label: "Sessions folder", value: "~/.codex/sessions" },
          { label: "Read", value: "not found" },
          { label: "Open-sessions folder", value: "~/.codex/thread-writer-locks" },
          { label: "Names file", value: "~/.codex/session_index.jsonl" },
        ],
        checkedAt: NOW,
      },
      sessions: [],
    });
  });

  test.skipIf(process.platform === "win32")(
    "a ~/.codex that is a link to another folder is followed, as Codex follows it",
    async () => {
      const userHome = await tempDir();
      const real = await makeCodexHome({}, { copyFixture: true });
      await symlink(real, path.join(userHome, ".codex"));
      const { health, sessions } = await createCodexAdapter({
        env: {},
        homeDir: userHome,
        now: () => NOW,
      }).poll();
      expect(health).toMatchObject({ state: "ok", detail: healthy() });
      expect(byId(sessions)).toEqual(expectedSessions);
    },
  );

  test("CODEX_HOME is read when AGENT_LOOKOUT_CODEX_HOME is not set", async () => {
    const elsewhere = await makeCodexHome({}, { copyFixture: true });
    const { sessions } = await createCodexAdapter({
      env: { CODEX_HOME: elsewhere },
      homeDir: await tempDir(),
      now: () => NOW,
    }).poll();
    expect(byId(sessions)).toEqual(expectedSessions);
  });

  test("an AGENT_LOOKOUT_CODEX_HOME with nothing in it is watched and empty", async () => {
    const empty = await tempDir();
    await mkdir(path.join(empty, "unrelated"));
    const result = await adapterFor(empty).poll();
    expect(result).toMatchObject({ health: { state: "ok" }, sessions: [], basis: "files" });
    expect(result.health.detail).toContain("which has no sessions folder");
  });
});
