import { appendFile, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createUnrealAgentAdapter, WINDOWS_DETAIL } from "@collector/adapters/unreal-agent/index";
import { createCollector } from "@collector/collector";
import type { UnrealAgentPrograms } from "@core/mapping/unreal-agent/unrealAgentLiveness";
import { REPLY_SETTLE_MS } from "@core/mapping/unreal-agent/unrealAgentMapping";
import {
  PRIVATE_WORDS,
  SESSION_ID,
  SessionLines,
  shellCall,
  uuidOf,
} from "@tests/fixtures/unreal-agent/unrealAgent";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as
// Unreal Agent v0.3.1 lays them out, and through the collector, which runs
// the real `ps` on macOS and Linux. Each file's time is set a few seconds
// back, so no reply is still taken as a turn under way. Whether an Unreal
// Agent program runs on the machine under test is not known, so a waiting
// session may show as idle, unknown or finished. A session the terminal app
// quit, and one whose reply failed, show as they do whatever runs.

const OTHER_ID = uuidOf(1, 2);
const FAILED_ID = uuidOf(1, 3);

/**
 * A sessions folder with these files, by ID, beside the command output and copies Unreal Agent keeps.
 * Each file's time is set after its newest line, and past the 2 seconds a reply that is the newest
 * line counts as busy, so only what `ps` shows moves a status.
 */
async function folderWith(sessions: Record<string, string>) {
  const dir = path.join(await tempDir(), "sessions");
  await mkdir(path.join(dir, "operations", SESSION_ID, uuidOf(5, 1)), { recursive: true });
  await writeFile(path.join(dir, "operations", SESSION_ID, uuidOf(5, 1), "out"), PRIVATE_WORDS);
  await writeFile(path.join(dir, ".session-123.tmp"), PRIVATE_WORDS);
  const writtenAt = new Date(Date.now() - REPLY_SETTLE_MS - 3_000);
  for (const [id, text] of Object.entries(sessions)) {
    const file = path.join(dir, `${id}.session.jsonl`);
    await writeFile(file, text);
    await utimes(file, writtenAt, writtenAt);
  }
  return dir;
}

/** A collector that reads that folder and an empty folder for every other agent, polled once. */
async function pollOnce(dir: string, platform: NodeJS.Platform) {
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
      AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: dir,
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
      AGENT_LOOKOUT_DROID_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_EDITOR_JUMP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_STOP: "off",
    },
    intervalMs: 5_000,
    platform,
  });
  onTestFinished(() => collector.stop());
  return collector.poller.pollOnce();
}

/** A session that ran one command and waits, with times of now, since a real file is listed by when it was written. */
function waiting(id: string) {
  const at = Date.now() - 60_000;
  const lines = new SessionLines(id, at);
  lines.settings(at).message(at).turn(at);
  shellCall(lines, at + 1_000, 1);
  return lines.turn(at + 3_000).reply(at + 4_000);
}

describe.skipIf(process.platform === "win32")(
  "sessions through the collector, on macOS or Linux",
  () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";

    test("a waiting session, a quit one and a failed one are listed, and no command's output is read", async () => {
      const quit = waiting(OTHER_ID).hard(Date.now() - 50_000);
      const failed = new SessionLines(FAILED_ID, Date.now() - 60_000);
      failed.settings(Date.now() - 60_000).turn(Date.now() - 60_000);
      failed.reply(Date.now() - 55_000, {
        failure: { Code: "server_error", Message: PRIVATE_WORDS },
      });
      const dir = await folderWith({
        [SESSION_ID]: waiting(SESSION_ID).text(),
        [OTHER_ID]: quit.text(),
        [FAILED_ID]: failed.text(),
      });
      const snapshot = await pollOnce(dir, platform);
      const source = snapshot.sources.find((one) => one.id === "unreal-agent");
      expect(source?.state).toBe("ok");
      const sessions = snapshot.sessions.filter((session) => session.source === "unreal-agent");
      expect(sessions.map((session) => session.id).sort()).toEqual(
        [SESSION_ID, OTHER_ID, FAILED_ID].map((id) => `unreal-agent:${id}`).sort(),
      );
      const open = sessions.find((session) => session.id === `unreal-agent:${SESSION_ID}`);
      expect(["idle", "unknown", "finished"]).toContain(open?.status);
      expect(open?.name).toBe("demo-project");
      expect(sessions.find((session) => session.id === `unreal-agent:${OTHER_ID}`)?.status).toBe(
        "finished",
      );
      expect(sessions.find((session) => session.id === `unreal-agent:${FAILED_ID}`)?.status).toBe(
        "failed",
      );
      expect(JSON.stringify(snapshot)).not.toContain("placeholder");
    });

    test("a file added to is read on, and its newest lines decide", async () => {
      const lines = waiting(SESSION_ID);
      const dir = await folderWith({ [SESSION_ID]: lines.text() });
      const adapter = createUnrealAgentAdapter({
        env: { AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: dir },
        platform,
      });
      const first = (await adapter.poll()).sessions[0]?.status;
      expect(["idle", "unknown", "finished"]).toContain(first);
      const before = lines.text().length;
      lines.hard(Date.now());
      await appendFile(path.join(dir, `${SESSION_ID}.session.jsonl`), lines.text().slice(before));
      expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    });

    test("a waiting session is idle while a program may hold it, and unknown when ps cannot say", async () => {
      const dir = await folderWith({ [SESSION_ID]: waiting(SESSION_ID).text() });
      const statusWith = async (programs: UnrealAgentPrograms) =>
        (
          await createUnrealAgentAdapter({
            env: { AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: dir },
            platform,
            processes: { read: async () => programs },
          }).poll()
        ).sessions[0]?.status;
      const started = Date.now() - 3_600_000;
      expect(await statusWith({ ok: true, starts: [started], unknownStart: false })).toBe("idle");
      expect(await statusWith({ ok: false })).toBe("unknown");
    });

    test("a link at a session file's name is passed over", async () => {
      const real = await folderWith({ [SESSION_ID]: waiting(SESSION_ID).text() });
      const dir = await folderWith({});
      await symlink(
        path.join(real, `${SESSION_ID}.session.jsonl`),
        path.join(dir, `${SESSION_ID}.session.jsonl`),
      );
      const result = await createUnrealAgentAdapter({
        env: { AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: dir },
        platform,
      }).poll();
      expect(result.health.state).toBe("ok");
      expect(result.sessions).toEqual([]);
    });
  },
);

describe("on Windows", () => {
  test("nothing of Unreal Agent's is read, through the collector too", async () => {
    const dir = await folderWith({ [SESSION_ID]: waiting(SESSION_ID).text() });
    const snapshot = await pollOnce(dir, "win32");
    const source = snapshot.sources.find((one) => one.id === "unreal-agent");
    expect(source).toMatchObject({ state: "unavailable", detail: WINDOWS_DETAIL });
    expect(snapshot.sessions.filter((session) => session.source === "unreal-agent")).toEqual([]);
  });
});
