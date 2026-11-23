import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  BASIS_WITHOUT_HEARTBEATS,
  createAutohandCodeAdapter,
  type AutohandCodeAdapterOptions,
} from "@collector/adapters/autohand-code/index";
import { createCollector, type CollectorOptions } from "@collector/collector";
import {
  CANARY_MARK,
  SESSION_ID,
  heartbeat,
  metadata,
} from "@tests/fixtures/autohand-code/autohandCode";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";
import { fakeProcesses, inTab, TERMINAL_PATH } from "@tests/support/node/terminal";
import { fakeTmux } from "@tests/support/node/tmux";

const POSIX = process.platform !== "win32";

/** A process that has ended, whose ID no process has for now. */
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return pid;
}

/** An Autohand Code folder with one session, laid out as Autohand Code lays it out, near the real clock. */
async function autohandHome(
  options: { pid?: number; phase?: string; writtenAt?: number; updatedAt?: number } = {},
) {
  const home = await tempDir();
  const now = Date.now();
  const heartbeats = path.join(home, "active-agents");
  const folder = path.join(home, "sessions", SESSION_ID);
  await mkdir(heartbeats, { recursive: true, mode: 0o700 });
  await mkdir(folder, { recursive: true });
  const heartbeatFile = path.join(heartbeats, `${SESSION_ID}.json`);
  await writeFile(
    heartbeatFile,
    heartbeat({
      pid: options.pid ?? process.pid,
      phase: options.phase,
      updatedAt: options.updatedAt ?? now,
      startedAt: now - 60_000,
    }),
    { mode: 0o600 },
  );
  await chmod(heartbeatFile, 0o600);
  const metadataFile = path.join(folder, "metadata.json");
  await writeFile(metadataFile, metadata({ createdAt: now - 60_000, lastActiveAt: now - 30_000 }));
  // In whole seconds, which every disk keeps as they are.
  const writtenAt = options.writtenAt ?? Math.floor(now / 1000) * 1000 - 20_000;
  await utimes(metadataFile, writtenAt / 1000, writtenAt / 1000);
  // What is beside them, and never opened.
  await writeFile(path.join(folder, "conversation.jsonl"), `{"text":"${CANARY_MARK}"}\n`);
  await writeFile(path.join(home, "config.json"), `{"apiKey":"${CANARY_MARK}"}\n`);
  await writeFile(path.join(home, "sessions", "index.json"), "{}\n");
  return { home, heartbeats, heartbeatFile, folder, metadataFile, writtenAt };
}

const adapterFor = (home: string, options: AutohandCodeAdapterOptions = {}) =>
  createAutohandCodeAdapter({ env: { AGENT_LOOKOUT_AUTOHAND_HOME: home }, ...options });

/** Every path under a folder, with its kind, size, modified time and bytes. */
async function tree(folder: string): Promise<string[]> {
  const seen: string[] = [];
  for (const name of (await readdir(folder)).sort()) {
    const target = path.join(folder, name);
    const info = await lstat(target);
    seen.push(`${target} ${info.isDirectory()} ${info.size} ${info.mtimeMs} ${info.mode}`);
    if (info.isDirectory()) seen.push(...(await tree(target)));
    else seen.push((await readFile(target)).toString("base64"));
  }
  return seen;
}

describe("the Autohand Code adapter, on real files", () => {
  test("with no Autohand Code, on a home with no folder of its own, it is not found", async () => {
    const { health, sessions } = await createAutohandCodeAdapter({
      env: {},
      homeDir: await tempDir(),
    }).poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toMatch(/^Autohand Code was not found: there is no /);
    expect(sessions).toEqual([]);
  });

  test("lists a session whose heartbeat is fresh and whose process runs, with its file's last write", async () => {
    const { home, writtenAt } = await autohandHome({ phase: "waiting_input" });
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: `autohand-code:${SESSION_ID}`,
      status: "needs-you",
      name: "demo-project",
      pid: process.pid,
      alive: true,
      lastWriteAt: writtenAt,
    });
    expect(JSON.stringify(sessions).toLowerCase()).not.toContain(CANARY_MARK);
  });

  test("a heartbeat whose process has ended, written over 15 seconds ago, is finished", async () => {
    const { home, heartbeatFile } = await autohandHome({ pid: endedPid() });
    const old = (Date.now() - 20_000) / 1000;
    await writeFile(heartbeatFile, heartbeat({ pid: endedPid(), updatedAt: Date.now() - 20_000 }));
    await chmod(heartbeatFile, 0o600);
    await utimes(heartbeatFile, old, old);
    const { sessions } = await adapterFor(home).poll();
    expect(sessions[0]?.status).toBe("finished");
  });

  test("writes, makes, locks and deletes nothing, a stale heartbeat left as it is", async () => {
    const { home, heartbeatFile } = await autohandHome({ pid: endedPid() });
    await writeFile(heartbeatFile, heartbeat({ pid: endedPid(), updatedAt: Date.now() - 60_000 }));
    await chmod(heartbeatFile, 0o600);
    const before = await tree(home);
    const adapter = adapterFor(home);
    for (let poll = 0; poll < 3; poll += 1) await adapter.poll();
    expect(await tree(home)).toEqual(before);
  });

  test("a heartbeat or a metadata.json with a second name is not read", async () => {
    const first = await autohandHome();
    await link(first.heartbeatFile, path.join(await tempDir(), "second-name.json"));
    expect((await adapterFor(first.home).poll()).sessions[0]?.status).toBe("unknown");

    const second = await autohandHome();
    await link(second.metadataFile, path.join(await tempDir(), "second-metadata.json"));
    const read = await adapterFor(second.home).poll();
    expect(read.sessions).toHaveLength(1);
    expect(read.sessions[0]).not.toHaveProperty("lastWriteAt");
  });

  test.skipIf(!POSIX)("on macOS and Linux a heartbeat others may read is not read", async () => {
    const { home, heartbeatFile } = await autohandHome();
    await chmod(heartbeatFile, 0o644);
    const { sessions } = await adapterFor(home).poll();
    expect(sessions[0]?.status).toBe("unknown");
  });

  // Windows lets you make a symbolic link only as an administrator or with
  // Developer Mode on.
  describe.skipIf(!POSIX)("a link", () => {
    test("in place of a heartbeat is not followed", async () => {
      const { home, heartbeatFile } = await autohandHome();
      const outside = path.join(await tempDir(), "elsewhere.json");
      await writeFile(outside, heartbeat({ pid: process.pid }), { mode: 0o600 });
      await rm(heartbeatFile);
      await symlink(outside, heartbeatFile);
      expect((await adapterFor(home).poll()).sessions[0]?.status).toBe("unknown");
    });

    test("in place of the heartbeats folder is not followed", async () => {
      const { home, heartbeats } = await autohandHome();
      const outside = await tempDir();
      await rm(heartbeats, { recursive: true });
      await writeFile(path.join(outside, `${SESSION_ID}.json`), heartbeat(), { mode: 0o600 });
      await symlink(outside, heartbeats);
      const result = await adapterFor(home).poll();
      expect(result.basis).toBe(BASIS_WITHOUT_HEARTBEATS);
      expect(result.sessions[0]?.status).toBe("unknown");
    });

    test("in place of a session's folder or its metadata.json is not opened through", async () => {
      const first = await autohandHome();
      const outside = await tempDir();
      await mkdir(path.join(outside, SESSION_ID));
      await writeFile(path.join(outside, SESSION_ID, "metadata.json"), metadata());
      await rm(first.folder, { recursive: true });
      await symlink(path.join(outside, SESSION_ID), first.folder);
      expect((await adapterFor(first.home).poll()).sessions).toEqual([]);

      const second = await autohandHome();
      await rm(second.metadataFile);
      await symlink(path.join(outside, SESSION_ID, "metadata.json"), second.metadataFile);
      const read = await adapterFor(second.home).poll();
      expect(read.sessions[0]).not.toHaveProperty("lastWriteAt");
    });

    test("in place of Autohand Code's folder or its sessions folder is followed, as either may be its own", async () => {
      const { home } = await autohandHome();
      const linked = path.join(await tempDir(), "autohand");
      await symlink(home, linked);
      expect((await adapterFor(linked).poll()).sessions).toHaveLength(1);

      const other = await autohandHome();
      const sessions = path.join(other.home, "sessions");
      const kept = `${sessions}-real`;
      await rename(sessions, kept);
      await symlink(kept, sessions);
      expect((await adapterFor(other.home).poll()).sessions).toHaveLength(1);
    });
  });
});

describe("the Autohand Code adapter, through the collector", () => {
  /**
   * One poll of the collector as every host builds it, with tmux, tabs and
   * editors off unless a test turns them on, and a tmux or a table of
   * processes of the test's own when it hands one in.
   */
  async function pollOnce(
    home: string,
    more: {
      env?: Record<string, string>;
      tmux?: CollectorOptions["tmux"];
      readProcesses?: CollectorOptions["readProcesses"];
    } = {},
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
        AGENT_LOOKOUT_PI_HOME: await tempDir(),
        AGENT_LOOKOUT_KIMI_CODE_HOME: await tempDir(),
        AGENT_LOOKOUT_CONTINUE_HOME: await tempDir(),
        AGENT_LOOKOUT_CRUSH_HOME: await tempDir(),
        AGENT_LOOKOUT_KILO_HOME: await tempDir(),
        AGENT_LOOKOUT_MIMO_CODE_HOME: await tempDir(),
        AGENT_LOOKOUT_KIMCHI_HOME: await tempDir(),
        AGENT_LOOKOUT_PRIME_AGENT_HOME: await tempDir(),
        AGENT_LOOKOUT_FX_HOME: await tempDir(),
        AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: await tempDir(),
        AGENT_LOOKOUT_AUTOHAND_HOME: home,
        AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
        AGENT_LOOKOUT_DROID_HOME: await tempDir(),
        AGENT_LOOKOUT_GROK_HOME: await tempDir(),
        AGENT_LOOKOUT_OMP_HOME: await tempDir(),
        AGENT_LOOKOUT_MUSE_CODE_HOME: await tempDir(),
        AGENT_LOOKOUT_COPILOT_HOME: await tempDir(),
        AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
        AGENT_LOOKOUT_EDITOR_JUMP: "off",
        AGENT_LOOKOUT_ANSWER: "off",
        AGENT_LOOKOUT_STOP: "off",
        ...more.env,
      },
      intervalMs: 5_000,
      ...(more.tmux && { tmux: more.tmux }),
      ...(more.readProcesses && { readProcesses: more.readProcesses }),
    });
    onTestFinished(() => collector.stop());
    return collector.poller.pollOnce();
  }

  test("a session reaches the snapshot with its name, folder, status and last write", async () => {
    const { home, writtenAt } = await autohandHome({ phase: "idle" });
    const snapshot = await pollOnce(home);
    expect(snapshot.sessions.find(({ source }) => source === "autohand-code")).toMatchObject({
      id: `autohand-code:${SESSION_ID}`,
      name: "demo-project",
      status: "idle",
      lastWriteAt: writtenAt,
    });
    expect(snapshot.sources.find(({ id }) => id === "autohand-code")).toMatchObject({
      state: "ok",
      watching: expect.arrayContaining([{ label: "Read", value: "every 5 seconds" }]),
    });
  });

  const autohandOf = (sessions: { source: string }[]) =>
    sessions.find(({ source }) => source === "autohand-code");

  test("a session whose fresh heartbeat's process is in a tmux pane has Jump to it", async () => {
    const { home } = await autohandHome();
    const tmux = fakeTmux({ panes: [`${process.pid} %7 2 1 checkout-flow`] });
    const ps = fakeProcesses();
    const snapshot = await pollOnce(home, { tmux: tmux.run, readProcesses: ps.read });
    expect(autohandOf(snapshot.sessions)).toMatchObject({
      pid: process.pid,
      jump: { kind: "tmux", place: "checkout-flow:2.1" },
    });
    expect(tmux.names()).toEqual(["list-panes"]);
  });

  test("one in a tab of Terminal has Jump to the tab", async () => {
    const { home } = await autohandHome();
    const ps = fakeProcesses(inTab(TERMINAL_PATH, process.pid));
    const snapshot = await pollOnce(home, {
      env: { AGENT_LOOKOUT_TERMINAL_JUMP: "on" },
      readProcesses: ps.read,
    });
    expect(autohandOf(snapshot.sessions)).toMatchObject({
      pid: process.pid,
      jump: { kind: "terminal", app: "Terminal", place: "Terminal" },
    });
    expect(ps.runs).toBe(1);
  });

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off its process is not looked for in a tab, as no editor is looked for it", async () => {
    const { home } = await autohandHome();
    const ps = fakeProcesses(inTab(TERMINAL_PATH, process.pid));
    const snapshot = await pollOnce(home, {
      env: { AGENT_LOOKOUT_TERMINAL_JUMP: "off", AGENT_LOOKOUT_EDITOR_JUMP: "on" },
      readProcesses: ps.read,
    });
    expect(autohandOf(snapshot.sessions)).toMatchObject({ status: "working", pid: process.pid });
    expect(autohandOf(snapshot.sessions)).not.toHaveProperty("jump");
    expect(ps.runs).toBe(0);
  });

  test("a heartbeat over 15 seconds old whose process runs has no Jump, and runs no tmux or ps", async () => {
    const { home } = await autohandHome({ updatedAt: Date.now() - 20_000 });
    const tmux = fakeTmux({ panes: [`${process.pid} %7 2 1 checkout-flow`] });
    const ps = fakeProcesses(inTab(TERMINAL_PATH, process.pid));
    const snapshot = await pollOnce(home, {
      env: { AGENT_LOOKOUT_TERMINAL_JUMP: "on" },
      tmux: tmux.run,
      readProcesses: ps.read,
    });
    expect(autohandOf(snapshot.sessions)).toMatchObject({ status: "unknown", pid: process.pid });
    expect(autohandOf(snapshot.sessions)).not.toHaveProperty("jump");
    expect(tmux.ran).toEqual([]);
    expect(ps.runs).toBe(0);
  });
});
