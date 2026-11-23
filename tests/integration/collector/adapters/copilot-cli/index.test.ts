import { cp, lstat, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import { createCopilotCliAdapter, LINK_NOTE } from "@collector/adapters/copilot-cli/index";
import { createCollector } from "@collector/collector";
import { PRIVATE_WORDS } from "@tests/fixtures/copilot-cli/copilotCli";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files: a copy of `fixtures/copilot-cli-home`,
// a folder laid out as Copilot CLI lays out its own, as
// docs/adapters/copilot-cli.md describes, with a lock this test makes for its
// own process, read through the collector, which runs the real `ps` on a Mac.
// Each file's modified time is set from the clock when the test runs, so the
// real date does not matter.

const FIXTURE = fileURLToPath(new URL("../../../../fixtures/copilot-cli-home", import.meta.url));
const DONE = "0aaa0000-0000-4000-8000-00000000a001";
const SHUT = "0aaa0000-0000-4000-8000-00000000b002";
const FLAT = "0aaa0000-0000-4000-8000-00000000c003";

/** Every name in a folder and below it, with each one's size and modified time. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const target = path.join(dir, name);
    const info = await lstat(target);
    found.push(`${name} ${info.size} ${info.mtimeMs}`);
    if (info.isDirectory()) found.push(...(await tree(target)).map((one) => `${name}/${one}`));
  }
  return found;
}

/** Sets a file's or folder's times to `secondsAgo` before now. */
async function writtenAgo(target: string, secondsAgo: number) {
  const at = new Date(Date.now() - secondsAgo * 1000);
  await utimes(target, at, at);
}

/** A copy of the fixture's folder, every log written a minute ago, and a lock of this process's in the first session. */
async function copilotHome(lock = true) {
  const home = await tempDir();
  await cp(FIXTURE, home, { recursive: true });
  const sessions = path.join(home, "session-state");
  for (const id of [DONE, SHUT]) {
    await writtenAgo(path.join(sessions, id, "events.jsonl"), 60);
    await writtenAgo(path.join(sessions, id), 60);
  }
  if (lock) {
    // Made now, after this process started, as Copilot makes its own.
    await writeFile(path.join(sessions, DONE, `inuse.${process.pid}.lock`), String(process.pid));
  }
  return home;
}

const adapterFor = (home: string, platform: NodeJS.Platform = process.platform) =>
  createCopilotCliAdapter({ env: { AGENT_LOOKOUT_COPILOT_HOME: home }, platform });

describe("the Copilot CLI adapter on real files", () => {
  test("reads each session's log and lock: a held session whose request is done is idle, and one that shut down finished", async () => {
    const home = await copilotHome();
    const before = await tree(home);
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect([...byId.keys()].sort()).toEqual([`copilot-cli:${DONE}`, `copilot-cli:${SHUT}`]);
    expect(byId.get(`copilot-cli:${DONE}`)).toMatchObject({
      status: "idle",
      name: "demo-project",
      cwd: "/Users/example/code/demo-project",
      startedAt: Date.parse("2026-11-20T09:00:00.000Z"),
      statusSince: Date.parse("2026-11-20T09:00:12.100Z"),
    });
    expect(byId.get(`copilot-cli:${SHUT}`)).toMatchObject({
      status: "finished",
      statusSince: Date.parse("2026-11-20T08:05:00.000Z"),
    });
    // The flat log is never read, workspace.yaml never opened, and nothing is written.
    expect(byId.has(`copilot-cli:${FLAT}`)).toBe(false);
    const answer = JSON.stringify({ health, sessions });
    for (const word of PRIVATE_WORDS) expect(answer, word).not.toContain(word);
    expect(await tree(home)).toEqual(before);
  });

  test("a lock whose process has gone does not hold its session", async () => {
    const home = await copilotHome(false);
    // A process ID no program can have.
    await writeFile(path.join(home, "session-state", DONE, "inuse.2147483646.lock"), "");
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.find((session) => session.id === `copilot-cli:${DONE}`)?.status).toBe(
      "finished",
    );
  });

  // Making a link on Windows needs a right a test cannot count on.
  test.skipIf(process.platform === "win32")(
    "a lock or a log that is a link is not followed",
    async () => {
      const home = await copilotHome(false);
      const folder = path.join(home, "session-state", DONE);
      const elsewhere = await tempDir();
      await writeFile(path.join(elsewhere, "inuse.lock"), "");
      await symlink(
        path.join(elsewhere, "inuse.lock"),
        path.join(folder, `inuse.${process.pid}.lock`),
      );
      const log = path.join(home, "session-state", SHUT, "events.jsonl");
      const kept = await readFile(log);
      await rm(log);
      await writeFile(path.join(elsewhere, "events.jsonl"), kept);
      await symlink(path.join(elsewhere, "events.jsonl"), log);
      const { health, sessions } = await adapterFor(home).poll();
      expect(sessions.map((session) => [session.id, session.status])).toEqual([
        [`copilot-cli:${DONE}`, "finished"],
      ]);
      expect(health.detail).toContain(LINK_NOTE);
    },
  );

  test("goes through the collector, with what it reads on its card", async () => {
    const home = await copilotHome();
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
        AGENT_LOOKOUT_GROK_HOME: await tempDir(),
        AGENT_LOOKOUT_OMP_HOME: await tempDir(),
        AGENT_LOOKOUT_MUSE_CODE_HOME: await tempDir(),
        AGENT_LOOKOUT_COPILOT_HOME: home,
        AGENT_LOOKOUT_KIRO_HOME: await tempDir(),
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
    const snapshot = await collector.poller.pollOnce();
    const card = snapshot.sources.find((source) => source.id === "copilot-cli");
    expect(card).toMatchObject({ label: "Copilot CLI", state: "ok" });
    expect(card?.watching).toContainEqual({
      label: "Sessions folder",
      value: path.join(home, "session-state"),
    });
    const mine = snapshot.sessions.filter((session) => session.source === "copilot-cli");
    // This process started before its lock was made, so on a Mac `ps` agrees with signal 0.
    expect(mine.map((session) => [session.id, session.status]).sort()).toEqual([
      [`copilot-cli:${DONE}`, "idle"],
      [`copilot-cli:${SHUT}`, "finished"],
    ]);
    const answer = JSON.stringify(snapshot);
    for (const word of PRIVATE_WORDS) expect(answer, word).not.toContain(word);
  });
});
