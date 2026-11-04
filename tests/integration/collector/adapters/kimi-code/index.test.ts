import { spawnSync } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createKimiCodeAdapter,
  type KimiCodeAdapterOptions,
} from "@collector/adapters/kimi-code/index";
import { MAX_STATE_BYTES } from "@collector/adapters/kimi-code/sessionState";
import { createCollector } from "@collector/collector";
import type { ReadProcessStarts } from "@collector/processes/processStart";
import { lstart } from "@tests/fixtures/antigravity";
import {
  BUCKET,
  indexLine,
  lockText,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  PROJECT,
  sessionIdOf,
  stateText,
  wireAnswered,
  wireAsked,
  wirePrompt,
  wireStart,
} from "@tests/fixtures/kimi-code/kimiCode";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const ID = sessionIdOf(1);

/** A process that has ended, whose id no process has for now. */
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return pid;
}

/** A session's times, near the real clock, since these are real files. */
const timed = (changes: Record<string, unknown> = {}) => ({
  createdAt: Date.now() - 10 * MINUTE,
  updatedAt: Date.now() - MINUTE,
  ...changes,
});

/** Where a session's files are in a home folder. */
function pathsOf(home: string, id: string) {
  const dir = path.join(home, "sessions", BUCKET, id);
  return {
    dir,
    state: path.join(dir, "state.json"),
    wire: path.join(dir, "agents", "main", "wire.jsonl"),
    lock: path.join(home, "locks", "sessions", `${id}.lock`),
  };
}

/** Writes one session into a temporary home, as Kimi Code lays it out. */
async function writeSession(
  home: string,
  id: string,
  changes: Record<string, unknown> = {},
  writtenAt = Date.now(),
) {
  const paths = pathsOf(home, id);
  await mkdir(path.dirname(paths.wire), { recursive: true });
  await writeFile(paths.state, stateText(id, timed(changes)));
  await utimes(paths.state, writtenAt / 1000, writtenAt / 1000);
  await writeFile(paths.wire, wireStart() + wirePrompt());
  const sessionDir = path.join(home, "sessions", BUCKET, id);
  await appendFile(path.join(home, "session_index.jsonl"), indexLine(id, { sessionDir }));
  return paths;
}

/** A lock in the real clock's past, which the real computer can have made since it started. */
const lockedAt = () => Date.now() - Math.min(os.uptime() * 1000, MINUTE) / 2;

async function writeLock(home: string, id: string, changes: Record<string, unknown> = {}) {
  const { lock } = pathsOf(home, id);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, lockText({ pid: process.pid, startedAt: lockedAt(), ...changes }));
  return lock;
}

const adapterFor = (home: string, options: KimiCodeAdapterOptions = {}) =>
  createKimiCodeAdapter({
    env: { AGENT_LOOKOUT_KIMI_CODE_HOME: home },
    platform: "linux",
    readProcessStarts: async () => new Map(),
    ...options,
  });

/** Every path under a folder, with its kind, size and modified time. */
async function tree(folder: string): Promise<string[]> {
  const seen: string[] = [];
  for (const name of (await readdir(folder)).sort()) {
    const target = path.join(folder, name);
    const info = await lstat(target);
    seen.push(`${target} ${info.isDirectory()} ${info.size} ${info.mtimeMs}`);
    if (info.isDirectory()) seen.push(...(await tree(target)));
  }
  return seen;
}

describe("the Kimi Code adapter, on real files", () => {
  test("with no Kimi Code, on a home with no folder of its own, it is not found", async () => {
    const homeDir = await tempDir();
    const adapter = createKimiCodeAdapter({ env: {}, homeDir, platform: "linux" });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toMatch(/^Kimi Code was not found: there is no /);
    expect(sessions).toEqual([]);
  });

  test("lists a session whose process runs, and shows one whose process ended as finished", async () => {
    const home = await tempDir();
    await writeSession(home, ID);
    await writeLock(home, ID);
    const crashed = sessionIdOf(2);
    await writeSession(home, crashed);
    await writeLock(home, crashed, { pid: endedPid() });

    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map(({ id, status, alive }) => [id, status, alive])).toEqual([
      [`kimi-code:${ID}`, "working", true],
      [`kimi-code:${crashed}`, "finished", undefined],
    ]);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("follows a wait from when it is asked until it is answered", async () => {
    const home = await tempDir();
    const { wire } = await writeSession(home, ID);
    await writeLock(home, ID);
    const adapter = adapterFor(home);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    await appendFile(wire, wireAsked("approval_1", "approval", Date.now()));
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
    });

    await appendFile(wire, wireAnswered("approval_1", Date.now()));
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("goes from working to idle when the lock is let go", async () => {
    const home = await tempDir();
    await writeSession(home, ID);
    const lock = await writeLock(home, ID);
    const adapter = adapterFor(home);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    await rm(lock);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      pid: process.pid,
      alive: true,
    });
  });

  test("writes nothing, makes nothing and takes no lock", async () => {
    const home = await tempDir();
    await writeSession(home, ID);
    await writeLock(home, ID);
    const before = await tree(home);
    const adapter = adapterFor(home);
    await adapter.poll();
    await adapter.poll();
    expect(await tree(home)).toEqual(before);
  });

  test("a state.json over the limit is left out without being read", async () => {
    const home = await tempDir();
    const { state } = await writeSession(home, ID);
    await writeFile(state, " ".repeat(MAX_STATE_BYTES + 1));
    const { sessions } = await adapterFor(home).poll();
    expect(sessions).toEqual([]);
  });

  // Windows lets you make a symbolic link only as an administrator or with
  // Developer Mode on.
  describe.skipIf(process.platform === "win32")("a link", () => {
    test("in place of the index is not followed", async () => {
      const home = await tempDir();
      const outside = await tempDir();
      await writeFile(path.join(outside, "index.jsonl"), indexLine(ID));
      await symlink(path.join(outside, "index.jsonl"), path.join(home, "session_index.jsonl"));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("error");
      expect(sessions).toEqual([]);
    });

    test("in place of a state.json is not followed", async () => {
      const home = await tempDir();
      const { state } = await writeSession(home, ID);
      const elsewhere = path.join(await tempDir(), "other.json");
      await writeFile(elsewhere, stateText(ID, timed()));
      await rm(state);
      await symlink(elsewhere, state);
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    });

    test("in place of a session's folder is not opened through", async () => {
      const home = await tempDir();
      const outside = await tempDir();
      const { dir } = await writeSession(outside, ID);
      await mkdir(path.join(home, "sessions", BUCKET), { recursive: true });
      await writeFile(path.join(home, "session_index.jsonl"), indexLine(ID));
      await symlink(dir, path.join(home, "sessions", BUCKET, ID));
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    });

    test("in place of the folder of sessions is not opened through", async () => {
      const home = await tempDir();
      const outside = await tempDir();
      await writeSession(outside, ID);
      await writeFile(path.join(home, "session_index.jsonl"), indexLine(ID));
      await symlink(path.join(outside, "sessions"), path.join(home, "sessions"));
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    });

    test("in place of a lock is not followed, so it holds nothing", async () => {
      const home = await tempDir();
      await writeSession(home, ID);
      const elsewhere = path.join(await tempDir(), "other.lock");
      await writeFile(elsewhere, lockText({ pid: process.pid, startedAt: lockedAt() }));
      const { lock } = pathsOf(home, ID);
      await mkdir(path.dirname(lock), { recursive: true });
      await symlink(elsewhere, lock);
      expect((await adapterFor(home).poll()).sessions[0]?.status).toBe("finished");
    });

    test("in place of the folder of locks is not listed", async () => {
      const home = await tempDir();
      await writeSession(home, ID);
      const outside = await tempDir();
      await writeLock(outside, ID);
      await mkdir(path.join(home, "locks"), { recursive: true });
      await symlink(path.join(outside, "locks", "sessions"), path.join(home, "locks", "sessions"));
      expect((await adapterFor(home).poll()).sessions[0]?.status).toBe("finished");
    });

    test("in place of an event file shows no wait", async () => {
      const home = await tempDir();
      const { wire } = await writeSession(home, ID);
      await writeLock(home, ID);
      const elsewhere = path.join(await tempDir(), "other.jsonl");
      await writeFile(elsewhere, wireStart() + wireAsked("approval_1", "approval", Date.now()));
      await rm(wire);
      await symlink(elsewhere, wire);
      expect((await adapterFor(home).poll()).sessions[0]?.status).toBe("working");
    });

    test("a Kimi Code folder that is itself a link is read, as it may be the person's own", async () => {
      const home = await tempDir();
      await writeSession(home, ID);
      const linked = path.join(await tempDir(), "kimi-home");
      await symlink(home, linked);
      expect((await adapterFor(linked).poll()).sessions).toHaveLength(1);
    });
  });

  // A pipe here would hang a read that waited on it. POSIX only.
  test.skipIf(process.platform === "win32")(
    "a pipe in place of a state.json does not hold up a poll",
    async () => {
      const home = await tempDir();
      const { state } = await writeSession(home, ID);
      await rm(state);
      spawnSync("mkfifo", [state]);
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    },
  );
});

describe("the Kimi Code adapter, through the collector", () => {
  /** The real clock stands still in these, so a home is written at the fixture's. */
  async function homeWith(changes: Record<string, unknown> = {}) {
    const home = await tempDir();
    await writeSession(home, ID, { createdAt: NOW - 10 * MINUTE, ...changes }, NOW);
    return home;
  }

  /** A collector that reads that home and an empty folder for every other agent, polled once. */
  async function pollOnce(
    home: string,
    platform: NodeJS.Platform,
    readProcessStarts: ReadProcessStarts,
    now = NOW,
  ) {
    const collector = createCollector({
      version: "9.9.9-test",
      env: {
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
        AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
        AGENT_LOOKOUT_ANTIGRAVITY_HOME: await tempDir(),
        AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: await tempDir(),
        AGENT_LOOKOUT_VIBE_SESSION_DIR: await tempDir(),
        AGENT_LOOKOUT_GEMINI_CLI_HOME: await tempDir(),
        AGENT_LOOKOUT_OPENCODE_HOME: await tempDir(),
        AGENT_LOOKOUT_QWEN_HOME: await tempDir(),
        AGENT_LOOKOUT_HERMES_HOME: await tempDir(),
        AGENT_LOOKOUT_CLINE_HOME: await tempDir(),
        AGENT_LOOKOUT_GOOSE_HOME: await tempDir(),
        AGENT_LOOKOUT_KIMI_CODE_HOME: home,
        AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
        AGENT_LOOKOUT_ANSWER: "off",
        AGENT_LOOKOUT_STOP: "off",
      },
      now: () => now,
      intervalMs: 5_000,
      platform,
      readProcessStarts,
    });
    onTestFinished(() => collector.stop());
    return collector.poller.pollOnce();
  }

  test("on a Mac, a session reaches the snapshot with its name, folder and status", async () => {
    const home = await homeWith();
    const startedAt = lockedAt();
    await writeLock(home, ID, { startedAt });
    const asked: number[][] = [];
    const snapshot = await pollOnce(
      home,
      "darwin",
      async (pids) => {
        asked.push([...pids]);
        return new Map(pids.map((pid) => [pid, lstart(startedAt - 1000)]));
      },
      Date.now(),
    );

    const session = snapshot.sessions.find(({ source }) => source === "kimi-code");
    expect(session).toMatchObject({
      id: `kimi-code:${ID}`,
      name: "demo-project",
      cwd: PROJECT,
      status: "working",
    });
    expect(asked).toContainEqual([process.pid]);
    expect(snapshot.sources.find(({ id }) => id === "kimi-code")).toMatchObject({
      state: "ok",
      basis: "files",
      watching: expect.arrayContaining([{ label: "Read", value: "every 5 seconds" }]),
    });
  });

  test("on Windows, a session keeps its folder by the system's rules, and ps is not asked", async () => {
    const home = await homeWith({ cwd: "C:\\Users\\example\\code\\demo-project" });
    await writeLock(home, ID, { startedAt: lockedAt() });
    const asked: number[][] = [];
    const snapshot = await pollOnce(
      home,
      "win32",
      async (pids) => {
        asked.push([...pids]);
        return new Map();
      },
      Date.now(),
    );

    expect(snapshot.sessions.find(({ source }) => source === "kimi-code")).toMatchObject({
      name: "demo-project",
      cwd: "C:\\Users\\example\\code\\demo-project",
      project: "demo-project",
      status: "working",
    });
    expect(asked.flat()).not.toContain(process.pid);
    expect(snapshot.sources.find(({ id }) => id === "kimi-code")?.watching).toContainEqual({
      label: "Process check",
      value: "signal 0 alone, every 5 seconds",
    });
  });

  test("a finished session reaches the snapshot on every system", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const snapshot = await pollOnce(await homeWith(), platform, async () => new Map());
      expect(snapshot.sessions.find(({ source }) => source === "kimi-code")?.status).toBe(
        "finished",
      );
    }
  });
});
