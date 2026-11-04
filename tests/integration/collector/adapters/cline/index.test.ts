import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createClineAdapter, type ClineAdapterOptions } from "@collector/adapters/cline/index";
import { MAX_MANIFEST_BYTES } from "@collector/adapters/cline/manifests";
import { createCollector } from "@collector/collector";
import type { ReadProcessStarts } from "@collector/processes/processStart";
import { lstart } from "@tests/fixtures/antigravity";
import {
  ended,
  manifestText,
  MINUTE,
  NOW,
  PLACEHOLDER,
  PRIVATE_WORDS,
  PROJECT,
  sessionIdOf,
  STARTED_AT,
} from "@tests/fixtures/cline/cline";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const ID = sessionIdOf(1);

/** A process that has ended, whose id no process has for now. */
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return pid;
}

/** A session's times, near the real clock, since these are real files. */
function timed(changes: Record<string, unknown> = {}) {
  return { started_at: new Date(Date.now() - 10 * MINUTE).toISOString(), ...changes };
}

/** Writes a session's files into a temporary home, as Cline lays them out. */
async function writeSession(home: string, id: string, content: string, writtenAt = Date.now()) {
  const dir = path.join(home, "data", "sessions", id);
  await mkdir(dir, { recursive: true });
  const manifest = path.join(dir, `${id}.json`);
  const messages = path.join(dir, `${id}.messages.json`);
  await writeFile(manifest, content);
  await writeFile(messages, PLACEHOLDER);
  await utimes(manifest, writtenAt / 1000, writtenAt / 1000);
  await utimes(messages, writtenAt / 1000, writtenAt / 1000);
  return { dir, manifest, messages };
}

const adapterFor = (home: string, options: ClineAdapterOptions = {}) =>
  createClineAdapter({
    env: { AGENT_LOOKOUT_CLINE_HOME: home },
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

describe("the Cline adapter, on real files", () => {
  test("with no Cline, on a home with no folder of its own, it is not found", async () => {
    const homeDir = await tempDir();
    const adapter = createClineAdapter({ env: {}, homeDir });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toMatch(/^Cline was not found: there is no /);
    expect(sessions).toEqual([]);
  });

  test("lists a session whose process runs, and shows one whose process ended as finished", async () => {
    const home = await tempDir();
    await writeSession(home, ID, manifestText(ID, timed({ pid: process.pid })));
    const crashed = sessionIdOf(2);
    await writeSession(home, crashed, manifestText(crashed, timed({ pid: endedPid() })));
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map(({ id, status, alive }) => [id, status, alive])).toEqual([
      [`cline:${ID}`, "working", true],
      [`cline:${crashed}`, "finished", false],
    ]);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
    expect(JSON.stringify(sessions)).not.toContain("demo task");
  });

  test("reads a session that ended from what it wrote", async () => {
    const home = await tempDir();
    const at = Date.now() - MINUTE;
    await writeSession(home, ID, manifestText(ID, timed(ended("failed", at))));
    const { sessions } = await adapterFor(home).poll();
    expect(sessions[0]).toMatchObject({ status: "failed", statusSince: at });
  });

  test("writes nothing and makes nothing", async () => {
    const home = await tempDir();
    await writeSession(home, ID, manifestText(ID, timed({ pid: process.pid })));
    const before = await tree(home);
    const adapter = adapterFor(home);
    await adapter.poll();
    await adapter.poll();
    expect(await tree(home)).toEqual(before);
  });

  test("takes its folder from Cline's own variable", async () => {
    const data = await tempDir();
    await writeSession(data, ID, manifestText(ID, timed({ pid: process.pid })));
    const { sessions } = await createClineAdapter({
      env: { CLINE_DIR: data },
      homeDir: await tempDir(),
      readProcessStarts: async () => new Map(),
    }).poll();
    expect(sessions).toHaveLength(1);
  });

  test("a manifest over the limit is not read", async () => {
    const home = await tempDir();
    await writeSession(
      home,
      ID,
      manifestText(ID, timed({ prompt: "x".repeat(MAX_MANIFEST_BYTES) })),
    );
    const { health, sessions } = await adapterFor(home).poll();
    expect(sessions).toEqual([]);
    expect(health.state).toBe("ok");
  });

  // Windows lets you make a symbolic link only as an administrator or with
  // Developer Mode on.
  describe.skipIf(process.platform === "win32")("a link", () => {
    test("in place of a manifest is not followed", async () => {
      const home = await tempDir();
      const elsewhere = path.join(await tempDir(), "other.json");
      await writeFile(elsewhere, manifestText(ID, timed({ pid: process.pid })));
      const { manifest } = await writeSession(home, ID, "");
      await rm(manifest);
      await symlink(elsewhere, manifest);
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    });

    test("in place of a session's folder is not opened through", async () => {
      const home = await tempDir();
      const outside = await tempDir();
      await writeSession(outside, ID, manifestText(ID, timed({ pid: process.pid })));
      const sessionsDir = path.join(home, "data", "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await symlink(path.join(outside, "data", "sessions", ID), path.join(sessionsDir, ID));
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    });

    test("in place of the sessions folder is followed, as it may be Cline's own", async () => {
      const home = await tempDir();
      const outside = await tempDir();
      await writeSession(outside, ID, manifestText(ID, timed({ pid: process.pid })));
      await mkdir(path.join(home, "data"), { recursive: true });
      await symlink(path.join(outside, "data", "sessions"), path.join(home, "data", "sessions"));
      expect((await adapterFor(home).poll()).sessions).toHaveLength(1);
    });
  });

  // A pipe here would hang a read that waited on it. POSIX only.
  test.skipIf(process.platform === "win32")(
    "a pipe in place of a manifest does not hold up a poll",
    async () => {
      const home = await tempDir();
      const { manifest } = await writeSession(home, ID, "");
      await rm(manifest);
      spawnSync("mkfifo", [manifest]);
      expect((await adapterFor(home).poll()).sessions).toEqual([]);
    },
  );
});

describe("the Cline adapter, through the collector", () => {
  /** A temporary Cline home with one session, written at the fixture's clock. */
  async function homeWith(changes: Record<string, unknown>) {
    const home = await tempDir();
    await writeSession(home, ID, manifestText(ID, { pid: process.pid, ...changes }), NOW);
    return home;
  }

  /** A collector that reads that home and an empty folder for every other agent, polled once. */
  async function pollOnce(
    home: string,
    platform: NodeJS.Platform,
    readProcessStarts: ReadProcessStarts,
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
        AGENT_LOOKOUT_CLINE_HOME: home,
        AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
        AGENT_LOOKOUT_ANSWER: "off",
        AGENT_LOOKOUT_STOP: "off",
      },
      now: () => NOW,
      intervalMs: 5_000,
      platform,
      readProcessStarts,
    });
    onTestFinished(() => collector.stop());
    return collector.poller.pollOnce();
  }

  test("a session reaches the snapshot with its name, folder and status", async () => {
    const asked: number[][] = [];
    const snapshot = await pollOnce(
      await homeWith({ status: "pending" }),
      "darwin",
      async (pids) => {
        asked.push([...pids]);
        return new Map(pids.map((pid) => [pid, lstart(STARTED_AT - 1000)]));
      },
    );

    expect(snapshot.sessions.find(({ source }) => source === "cline")).toMatchObject({
      id: `cline:${ID}`,
      name: "demo-project",
      cwd: PROJECT,
      status: "needs-you",
    });
    expect(asked).toContainEqual([process.pid]);
    expect(snapshot.sources.find(({ id }) => id === "cline")?.watching).toContainEqual({
      label: "Read",
      value: "every 5 seconds",
    });
  });

  test("a session keeps its folder by the system's own rules", async () => {
    const snapshot = await pollOnce(
      await homeWith({ cwd: "C:\\code\\demo-project" }),
      "win32",
      async () => new Map(),
    );

    expect(snapshot.sessions.find(({ source }) => source === "cline")).toMatchObject({
      cwd: "C:\\code\\demo-project",
    });
  });
});
