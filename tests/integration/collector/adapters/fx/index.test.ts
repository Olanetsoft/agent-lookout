import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createFxAdapter, WINDOWS_DETAIL } from "@collector/adapters/fx/index";
import { createCollector } from "@collector/collector";
import { CHILD_ID, fxLog, PRIVATE_WORDS, SESSION_ID } from "@tests/fixtures/fx/fx";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as fx
// v0.0.17 lays them out, and through the collector, which runs the real `ps`
// on macOS and Linux. Whether an fx program runs on the machine under test is
// not known, so an open turn may show as working, unknown or finished. A
// failed turn shows as failed whatever runs.

/** fx's folder, with one folder in `sessions/v2` for each log given, by its id. */
async function homeWith(logs: Record<string, string>) {
  const home = path.join(await tempDir(), "fx");
  const v2 = path.join(home, "sessions", "v2");
  await mkdir(v2, { recursive: true });
  for (const [id, text] of Object.entries(logs)) {
    await mkdir(path.join(v2, id, "blobs"), { recursive: true });
    await writeFile(path.join(v2, id, "log.jsonl"), text);
    await writeFile(path.join(v2, id, "lock"), "");
  }
  await writeFile(path.join(v2, "index.jsonl"), `{"op":"put","title":"${PRIVATE_WORDS}"}\n`);
  return home;
}

/** A collector that reads that folder and an empty folder for every other agent, polled once. */
async function pollOnce(home: string, platform: NodeJS.Platform) {
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
      AGENT_LOOKOUT_FX_HOME: home,
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

/** A log whose times are now, since a real file is listed by when it was written. */
const fresh = (first: Parameters<typeof fxLog>[0] = {}) =>
  fxLog({ ts: Date.now() - 60_000, ...first });

const OTHER_ID = "Zy8xW6vU4tS2";

describe.skipIf(process.platform === "win32")(
  "sessions through the collector, on macOS or Linux",
  () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";

    test("an open turn and a failed one are listed, a subagent's is not, and the index is never read", async () => {
      const home = await homeWith({
        [SESSION_ID]: fresh()
          .turnStarted(Date.now() - 30_000)
          .item(Date.now() - 20_000)
          .text(),
        [OTHER_ID]: fresh({ id: OTHER_ID })
          .turnStarted()
          .turnInterrupted("failed", Date.now() - 10_000)
          .text(),
        [CHILD_ID]: fresh({ id: CHILD_ID, role: "child", host: "child", parent: SESSION_ID })
          .turnStarted()
          .text(),
      });
      const snapshot = await pollOnce(home, platform);
      const fx = snapshot.sources.find((source) => source.id === "fx");
      expect(fx?.state).toBe("ok");
      const sessions = snapshot.sessions.filter((session) => session.source === "fx");
      expect(sessions.map((session) => session.id).sort()).toEqual(
        [`fx:${SESSION_ID}`, `fx:${OTHER_ID}`].sort(),
      );
      const open = sessions.find((session) => session.id === `fx:${SESSION_ID}`);
      expect(["working", "unknown", "finished"]).toContain(open?.status);
      expect(open?.name).toBe("demo-project");
      expect(sessions.find((session) => session.id === `fx:${OTHER_ID}`)?.status).toBe("failed");
      expect(JSON.stringify(snapshot)).not.toContain("placeholder");
    });

    test("a log added to is read on, and its new turn decides", async () => {
      const log = fresh().turnStarted().turnInterrupted("failed");
      const home = await homeWith({ [SESSION_ID]: log.text() });
      const adapter = createFxAdapter({ env: { AGENT_LOOKOUT_FX_HOME: home }, platform });
      expect((await adapter.poll()).sessions[0]?.status).toBe("failed");
      const mark = log.mark();
      log.turnStarted(Date.now()).item(Date.now());
      await appendFile(path.join(home, "sessions", "v2", SESSION_ID, "log.jsonl"), log.since(mark));
      expect(["working", "unknown", "finished"]).toContain(
        (await adapter.poll()).sessions[0]?.status,
      );
    });

    test("a link at v2 is not followed, and a link at a log is passed over", async () => {
      const real = await homeWith({
        [SESSION_ID]: fresh().turnStarted().turnInterrupted("failed").text(),
      });
      const linked = path.join(await tempDir(), "fx");
      await mkdir(path.join(linked, "sessions"), { recursive: true });
      await symlink(path.join(real, "sessions", "v2"), path.join(linked, "sessions", "v2"));
      const viaLink = await createFxAdapter({
        env: { AGENT_LOOKOUT_FX_HOME: linked },
        platform,
      }).poll();
      expect(viaLink.health.state).toBe("unavailable");
      expect(viaLink.sessions).toEqual([]);

      const home = await homeWith({});
      const dir = path.join(home, "sessions", "v2", SESSION_ID);
      await mkdir(dir);
      await symlink(
        path.join(real, "sessions", "v2", SESSION_ID, "log.jsonl"),
        path.join(dir, "log.jsonl"),
      );
      const result = await createFxAdapter({
        env: { AGENT_LOOKOUT_FX_HOME: home },
        platform,
      }).poll();
      expect(result.health.state).toBe("ok");
      expect(result.sessions).toEqual([]);
    });
  },
);

describe("on Windows", () => {
  test("nothing of fx's is read, through the collector too", async () => {
    const home = await homeWith({
      [SESSION_ID]: fresh().turnStarted().turnInterrupted("failed").text(),
    });
    const snapshot = await pollOnce(home, "win32");
    const fx = snapshot.sources.find((source) => source.id === "fx");
    expect(fx).toMatchObject({ state: "unavailable", detail: WINDOWS_DETAIL });
    expect(snapshot.sessions.filter((session) => session.source === "fx")).toEqual([]);
  });
});
