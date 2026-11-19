import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createGrokBuildAdapter, UNCHECKED_NOTE } from "@collector/adapters/grok-build/index";
import { createCollector } from "@collector/collector";
import {
  entry,
  firstToken,
  openedAt,
  PROJECT,
  PROJECT_FOLDER,
  registryText,
  SECRET,
  SESSION_ID,
  summaryText,
  toolStarted,
  turnEnded,
  turnStarted,
  TYPED_TITLE,
  type Entry,
} from "@tests/fixtures/grok-build/grokBuild";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Grok
// Build 1.0.45 lays them out, and through the collector, which asks signal 0
// and, on a Mac, the real `ps`. The session's process is this test's own, so
// it runs whether or not Grok Build does, and every time is set from the
// clock as the test runs. The other tests hand the adapter stand-ins for its
// processes.

const POSIX = process.platform !== "win32";

/** A Grok Build home with this list, and these files in the session's folder. */
async function homeWith(entries: readonly Entry[], files: Record<string, string> = {}) {
  const home = path.join(await tempDir(), ".grok");
  const folder = path.join(home, "sessions", PROJECT_FOLDER, SESSION_ID);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(home, "active_sessions.json"), registryText(entries));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(path.join(folder, name), text);
  }
  return { home, folder };
}

/** Sets a file's modified time to the whole second at or before `ms`, which every disk keeps as it is. */
async function stamp(file: string, ms: number): Promise<number> {
  const second = Math.floor(ms / 1000) * 1000;
  await utimes(file, new Date(second), new Date(second));
  return second;
}

/** A collector that reads that folder and an empty folder for every other agent, polled once. */
async function pollOnce(home: string) {
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
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
      AGENT_LOOKOUT_DROID_HOME: await tempDir(),
      AGENT_LOOKOUT_GROK_HOME: home,
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_EDITOR_JUMP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_STOP: "off",
    },
    intervalMs: 5_000,
  });
  onTestFinished(() => collector.stop());
  return collector.poller.pollOnce();
}

/**
 * An adapter of these real files, on this system's rules and as the user the
 * test runs as, with every process running unless a test says otherwise and
 * a `ps` that knows no start time.
 */
const adapterFor = (
  home: string,
  options: { isAlive?: (pid: number) => boolean; platform?: NodeJS.Platform } = {},
) =>
  createGrokBuildAdapter({
    env: { AGENT_LOOKOUT_GROK_HOME: home },
    platform: options.platform ?? process.platform,
    isAlive: options.isAlive ?? (() => true),
    readProcessStarts: async () => new Map(),
  });

/** Every name in a folder and below it, with each one's size and modified time. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const target = path.join(dir, name);
    const info = await lstat(target);
    found.push(`${path.relative(dir, target)} ${info.size} ${info.mtimeMs}`);
    if (info.isDirectory()) found.push(...(await tree(target)).map((one) => `${name}/${one}`));
  }
  return found;
}

describe("a session through the collector", () => {
  test("reaches the snapshot as working, with its folder's name, and nothing typed or written by a model", async () => {
    const now = Date.now();
    const { home, folder } = await homeWith(
      [entry({ pid: process.pid, opened_at: openedAt(now - 60_000) })],
      {
        "events.jsonl":
          turnStarted(now - 30_000, { model_id: SECRET }) +
          firstToken(now - 29_000) +
          toolStarted(now - 28_000, SECRET),
        "summary.json": summaryText({ title: TYPED_TITLE }),
      },
    );
    await stamp(path.join(folder, "events.jsonl"), now - 28_000);
    const snapshot = await pollOnce(home);

    const session = snapshot.sessions.find(({ source }) => source === "grok-build");
    expect(session).toMatchObject({
      id: `grok-build:${SESSION_ID}`,
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      surface: "terminal",
      status: "working",
      statusSince: now - 30_000,
      pid: process.pid,
    });
    const card = snapshot.sources.find(({ id }) => id === "grok-build");
    expect(card).toMatchObject({ state: "ok", label: "Grok Build" });
    expect(card?.detail).toContain(UNCHECKED_NOTE);
    const said = JSON.stringify(snapshot);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("quartzmandolin");
  });
});

describe("real files", () => {
  test("not found where Grok Build would be, and looked for again", async () => {
    const homeDir = await tempDir();
    const adapter = createGrokBuildAdapter({ env: {}, homeDir });
    const { health } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toContain("Grok Build was not found");
  });

  test("each status, from the log and plan file as they are written", async () => {
    const now = Date.now();
    const { home, folder } = await homeWith([entry({ opened_at: openedAt(now - 60_000) })], {
      "events.jsonl": turnStarted(now - 20_000) + firstToken(now - 19_000),
    });
    const log = path.join(folder, "events.jsonl");
    await stamp(log, now - 19_000);
    const adapter = adapterFor(home);
    const statusNow = async () => (await adapter.poll()).sessions.map(({ status }) => status);
    expect(await statusNow()).toEqual(["working"]);
    await writeFile(log, toolStarted(now - 10_000, "ask_user_question"), { flag: "a" });
    await stamp(log, now - 10_000);
    expect(await statusNow()).toEqual(["needs-you"]);
    await writeFile(log, turnEnded(now - 5_000, "error"), { flag: "a" });
    await stamp(log, now - 5_000);
    expect(await statusNow()).toEqual(["failed"]);
    await writeFile(path.join(folder, "plan_mode.json"), '{\n  "awaiting_plan_approval": true\n}');
    expect(await statusNow()).toEqual(["needs-you"]);
  });

  test("a session whose process has ended is finished from its log's last write", async () => {
    const now = Date.now();
    const { home, folder } = await homeWith([entry({ opened_at: openedAt(now - 600_000) })], {
      "events.jsonl": turnStarted(now - 300_000),
    });
    const written = await stamp(path.join(folder, "events.jsonl"), now - 120_000);
    const { sessions } = await adapterFor(home, { isAlive: () => false }).poll();
    expect(sessions).toMatchObject([{ status: "finished", statusSince: written, alive: false }]);
  });

  test("a session in a folder whose name is hashed is found by its ID", async () => {
    const now = Date.now();
    const long = `/Users/example/${"日".repeat(30)}`;
    const home = path.join(await tempDir(), ".grok");
    const folder = path.join(home, "sessions", "workspace-0123456789abcdef", SESSION_ID);
    await mkdir(folder, { recursive: true });
    await writeFile(
      path.join(home, "active_sessions.json"),
      registryText([entry({ cwd: long, opened_at: openedAt(now - 60_000) })]),
    );
    await writeFile(path.join(folder, "events.jsonl"), turnEnded(now - 30_000));
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map(({ status, project }) => [status, project])).toEqual([
      ["idle", "日".repeat(30)],
    ]);
  });

  test("the card says what is read and run on each system", async () => {
    const { home } = await homeWith([entry()]);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const { health } = await adapterFor(home, { platform }).poll();
      const labels = health.watching?.map(({ label }) => label);
      expect(labels, platform).toEqual(
        platform === "darwin"
          ? [
              "Session list",
              "Read",
              "Sessions folder",
              "Event logs",
              "Process IDs",
              "Process check",
              "Process check run",
            ]
          : [
              "Session list",
              "Read",
              "Sessions folder",
              "Event logs",
              "Process IDs",
              "Process check",
            ],
      );
    }
  });

  test("nothing in Grok Build's folder is written, moved or touched by several polls", async () => {
    const now = Date.now();
    const { home, folder } = await homeWith([entry({ opened_at: openedAt(now - 60_000) })], {
      "events.jsonl": turnStarted(now - 20_000),
      "summary.json": summaryText({ title: "Release checklist", manual: true }),
      "plan_mode.json": '{\n  "awaiting_plan_approval": false\n}',
    });
    await writeFile(path.join(home, "active_sessions.lock"), "");
    await stamp(path.join(folder, "events.jsonl"), now - 20_000);
    const before = await tree(home);
    const adapter = adapterFor(home);
    for (let poll = 0; poll < 3; poll += 1) await adapter.poll();
    expect(await tree(home)).toEqual(before);
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(!POSIX)("links and pipes", () => {
    test("a link in place of a session's folder, or of its log, is not followed", async () => {
      const now = Date.now();
      const elsewhere = await tempDir();
      await writeFile(path.join(elsewhere, "events.jsonl"), turnStarted(now - 5_000));
      const home = path.join(await tempDir(), ".grok");
      await mkdir(path.join(home, "sessions", PROJECT_FOLDER), { recursive: true });
      await writeFile(
        path.join(home, "active_sessions.json"),
        registryText([entry({ opened_at: openedAt(now - 60_000) })]),
      );
      await symlink(elsewhere, path.join(home, "sessions", PROJECT_FOLDER, SESSION_ID));
      expect((await adapterFor(home).poll()).sessions.map(({ status }) => status)).toEqual([
        "unknown",
      ]);
      const { home: other, folder } = await homeWith([
        entry({ opened_at: openedAt(now - 60_000) }),
      ]);
      await symlink(path.join(elsewhere, "events.jsonl"), path.join(folder, "events.jsonl"));
      expect((await adapterFor(other).poll()).sessions.map(({ status }) => status)).toEqual([
        "unknown",
      ]);
    });

    test("a pipe in place of the list is not opened, and the poll fails", async () => {
      const home = path.join(await tempDir(), ".grok");
      await mkdir(home, { recursive: true });
      const made = spawnSync("mkfifo", [path.join(home, "active_sessions.json")]);
      expect(made.status).toBe(0);
      const { health } = await adapterFor(home).poll();
      expect(health.state).toBe("error");
    });
  });
});
