import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createKiroCliAdapter,
  type KiroCliAdapterOptions,
} from "@collector/adapters/kiro-cli/index";
import { createCollector } from "@collector/collector";
import {
  BUCKET,
  MINUTE,
  PRIVATE_WORDS,
  lockText,
  uuidOf,
  v2Header,
  v2Prompt,
  v2Reply,
  v3Header,
  v3IdOf,
  v3Pending,
  v3TurnStart,
  v3User,
} from "@tests/fixtures/kiro-cli/kiroCli";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const V3 = v3IdOf(1);
const V2 = uuidOf(2);

/** A process that has ended, whose id no process has for now. */
function endedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  return pid;
}

/** A lock in the real clock's past, which the real computer can have taken since it started. */
const lockedAt = () => Date.now() - Math.min(os.uptime() * 1000, MINUTE) / 2;

/** Writes a V3 session into a temporary Kiro folder, as Kiro lays one out. */
async function writeV3(home: string, id: string, log: string, lock?: string) {
  const folder = path.join(home, "sessions", BUCKET, id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "session.json"), v3Header(id));
  await writeFile(path.join(folder, "messages.jsonl"), log);
  if (lock !== undefined) await writeFile(path.join(folder, ".lock"), lock);
  return folder;
}

/** Writes a V2 session into a temporary Kiro folder, as Kiro lays one out. */
async function writeV2(home: string, id: string, log: string, lock?: string) {
  const folder = path.join(home, "sessions", "cli");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, `${id}.json`), v2Header(id));
  await writeFile(path.join(folder, `${id}.jsonl`), log);
  if (lock !== undefined) await writeFile(path.join(folder, `${id}.lock`), lock);
}

const adapterFor = (home: string, options: KiroCliAdapterOptions = {}) =>
  createKiroCliAdapter({ env: { AGENT_LOOKOUT_KIRO_HOME: home }, platform: "linux", ...options });

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

describe("the Kiro CLI adapter, on real files", () => {
  test("with no Kiro, on a home with no folder of its own, it is not found", async () => {
    const homeDir = await tempDir();
    const { health, sessions } = await createKiroCliAdapter({
      env: {},
      homeDir,
      platform: "linux",
    }).poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toMatch(/^Kiro CLI was not found: there is no /);
    expect(sessions).toEqual([]);
  });

  test("reads both stores side by side, from the log while a lock's process runs, and finished once it has ended", async () => {
    const home = await tempDir();
    await writeV3(
      home,
      V3,
      v3User() + v3TurnStart() + v3Pending("call-1"),
      lockText(process.pid, lockedAt()),
    );
    await writeV2(home, V2, v2Prompt() + v2Reply(), lockText(endedPid(), lockedAt()));
    const before = await tree(home);

    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    expect(sessions.map(({ id, status, waitingReason }) => [id, status, waitingReason])).toEqual([
      [`kiro-cli:${V3}`, "needs-you", "permission"],
      [`kiro-cli:${V2}`, "finished", undefined],
    ]);
    // On Linux the lock's process is not checked against ps, so it is not shown as open.
    expect(sessions[0]).not.toHaveProperty("pid");
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
    // Nothing is written, made or removed.
    expect(await tree(home)).toEqual(before);
  });

  test.runIf(process.platform === "darwin")(
    "on a Mac, asks the real ps when a lock's process started, and shows it open",
    async () => {
      const home = await tempDir();
      await writeV3(home, V3, v3TurnStart(), lockText(process.pid, Date.now()));
      const { sessions } = await adapterFor(home, { platform: "darwin" }).poll();
      expect(sessions[0]).toMatchObject({ status: "working", pid: process.pid, alive: true });
    },
  );

  test.skipIf(process.platform === "win32")("follows no link to a session's folder", async () => {
    // Windows lets only an administrator, or Developer Mode, make a link.
    const home = await tempDir();
    const elsewhere = await tempDir();
    const real = await writeV3(elsewhere, V3, v3TurnStart(), lockText(process.pid, lockedAt()));
    await mkdir(path.join(home, "sessions", BUCKET), { recursive: true });
    await symlink(real, path.join(home, "sessions", BUCKET, V3));
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toEqual([]);
  });

  test("a collector built with a Kiro folder of its own lists its sessions", async () => {
    const home = await tempDir();
    await writeV2(home, V2, v2Prompt(), lockText(endedPid(), lockedAt()));
    const env: Record<string, string> = {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_EDITOR_JUMP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_STOP: "off",
      AGENT_LOOKOUT_KIRO_HOME: home,
    };
    for (const name of [
      "AGENT_LOOKOUT_CODEX_HOME",
      "AGENT_LOOKOUT_ANTIGRAVITY_HOME",
      "AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME",
      "AGENT_LOOKOUT_VIBE_SESSION_DIR",
      "AGENT_LOOKOUT_GEMINI_CLI_HOME",
      "AGENT_LOOKOUT_OPENCODE_HOME",
      "AGENT_LOOKOUT_QWEN_HOME",
      "AGENT_LOOKOUT_HERMES_HOME",
      "AGENT_LOOKOUT_CLINE_HOME",
      "AGENT_LOOKOUT_GOOSE_HOME",
      "AGENT_LOOKOUT_PI_HOME",
      "AGENT_LOOKOUT_KIMI_CODE_HOME",
      "AGENT_LOOKOUT_CONTINUE_HOME",
      "AGENT_LOOKOUT_CRUSH_HOME",
      "AGENT_LOOKOUT_KILO_HOME",
      "AGENT_LOOKOUT_MIMO_CODE_HOME",
      "AGENT_LOOKOUT_KIMCHI_HOME",
      "AGENT_LOOKOUT_PRIME_AGENT_HOME",
      "AGENT_LOOKOUT_FX_HOME",
      "AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR",
      "AGENT_LOOKOUT_AUTOHAND_HOME",
      "AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME",
      "AGENT_LOOKOUT_DROID_HOME",
      "AGENT_LOOKOUT_GROK_HOME",
      "AGENT_LOOKOUT_OMP_HOME",
      "AGENT_LOOKOUT_MUSE_CODE_HOME",
      "AGENT_LOOKOUT_COPILOT_HOME",
    ]) {
      env[name] = await tempDir();
    }
    const collector = createCollector({ version: "9.9.9-test", env, platform: "linux" });
    onTestFinished(() => collector.stop());
    const snapshot = await collector.poller.pollOnce();
    expect(snapshot.sources.find((source) => source.id === "kiro-cli")).toMatchObject({
      label: "Kiro CLI",
      state: "ok",
    });
    expect(snapshot.sessions.filter((session) => session.source === "kiro-cli")).toEqual([
      expect.objectContaining({ id: `kiro-cli:${V2}`, status: "finished" }),
    ]);
  });
});
