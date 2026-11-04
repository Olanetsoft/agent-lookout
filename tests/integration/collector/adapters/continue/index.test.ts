import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createContinueAdapter, STATUS_NOTE } from "@collector/adapters/continue/index";
import { createCollector } from "@collector/collector";
import {
  entryOf,
  indexText,
  PRIVATE_ARGUMENTS,
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_URI,
  SESSION_ID,
  sessionIdOf,
  sessionText,
} from "@tests/fixtures/continue/continue";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Continue
// v1.5.45 lays them out, and through the collector. No program of Continue's runs,
// and no `ps` is asked of it.

/** Continue's folder, with these sessions in its list and a file for each. */
async function homeWith(entries: Record<string, unknown>[]) {
  const home = await tempDir();
  const dir = path.join(home, "sessions");
  await mkdir(dir);
  await writeFile(path.join(dir, "sessions.json"), indexText(entries));
  for (const { sessionId } of entries) {
    await writeFile(path.join(dir, `${String(sessionId)}.json`), sessionText(String(sessionId)));
  }
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
      AGENT_LOOKOUT_CONTINUE_HOME: home,
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_STOP: "off",
    },
    intervalMs: 5_000,
    platform,
  });
  onTestFinished(() => collector.stop());
  return collector.poller.pollOnce();
}

describe("a session through the collector on a Mac", () => {
  test("reaches the snapshot with its name, folder and status, and none of what was said", async () => {
    const snapshot = await pollOnce(await homeWith([entryOf(SESSION_ID)]), "darwin");

    expect(snapshot.sessions.find(({ source }) => source === "continue")).toMatchObject({
      id: `continue:${SESSION_ID}`,
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      surface: "unknown",
      status: "unknown",
      statusSince: null,
    });
    const card = snapshot.sources.find(({ id }) => id === "continue");
    expect(card).toMatchObject({ state: "ok", label: "Continue" });
    expect(card?.detail).toContain(STATUS_NOTE);
    expect(card?.watching).toContainEqual({ label: "Read", value: "every 5 seconds" });
    const said = JSON.stringify(snapshot);
    for (const word of [PRIVATE_TITLE, PRIVATE_WORDS, PRIVATE_ARGUMENTS]) {
      expect(said).not.toContain(word);
    }
  });

  test("an editor's session has its folder from the URI Continue writes", async () => {
    const entry = entryOf(SESSION_ID, { workspaceDirectory: PROJECT_URI });
    const snapshot = await pollOnce(await homeWith([entry]), "darwin");
    expect(snapshot.sessions.find(({ source }) => source === "continue")).toMatchObject({
      name: "demo-project",
      cwd: PROJECT,
    });
  });

  test("a folder with nothing in it lists no session, and is watched", async () => {
    const snapshot = await pollOnce(await tempDir(), "darwin");
    expect(snapshot.sources.find(({ id }) => id === "continue")?.state).toBe("ok");
    expect(snapshot.sessions.filter(({ source }) => source === "continue")).toEqual([]);
  });
});

describe("a session through the collector on Windows", () => {
  test("is listed as it is on a Mac, with a folder on Windows' rules", async () => {
    const cwd = "C:\\Users\\example\\code\\demo-project";
    const snapshot = await pollOnce(
      await homeWith([entryOf(SESSION_ID, { workspaceDirectory: cwd })]),
      "win32",
    );
    expect(snapshot.sessions.find(({ source }) => source === "continue")).toMatchObject({
      id: `continue:${SESSION_ID}`,
      name: "demo-project",
      cwd,
      status: "unknown",
      statusSince: null,
    });
    expect(snapshot.sources.find(({ id }) => id === "continue")?.state).toBe("ok");
  });

  test("VS Code's URI is read on Windows' rules", async () => {
    const entry = entryOf(SESSION_ID, {
      workspaceDirectory: "file:///c%3A/Users/example/code/demo-project",
    });
    const snapshot = await pollOnce(await homeWith([entry]), "win32");
    expect(snapshot.sessions.find(({ source }) => source === "continue")).toMatchObject({
      name: "demo-project",
      cwd: "c:\\Users\\example\\code\\demo-project",
    });
  });
});

describe("real files", () => {
  const adapterFor = (home: string) =>
    createContinueAdapter({ env: { AGENT_LOOKOUT_CONTINUE_HOME: home }, platform: "linux" });

  const write = (home: string, name: string, text: string) =>
    writeFile(path.join(home, "sessions", name), text);

  test("a session in the list is read, and the list is read again when it changes", async () => {
    const home = await homeWith([entryOf(SESSION_ID)]);
    const adapter = adapterFor(home);
    expect((await adapter.poll()).sessions).toHaveLength(1);

    await write(home, `${sessionIdOf(2)}.json`, sessionText(sessionIdOf(2)));
    await write(home, "sessions.json", indexText([entryOf(SESSION_ID), entryOf(sessionIdOf(2))]));
    expect((await adapter.poll()).sessions).toHaveLength(2);
  });

  test("a session not written for a day is left alone", async () => {
    const home = await homeWith([entryOf(SESSION_ID), entryOf(sessionIdOf(2))]);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path.join(home, "sessions", `${sessionIdOf(2)}.json`), twoDaysAgo, twoDaysAgo);
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map((session) => session.id)).toEqual([`continue:${SESSION_ID}`]);
  });

  test("a broken list says so, and a good one read after it is shown", async () => {
    const home = await homeWith([entryOf(SESSION_ID)]);
    await write(home, "sessions.json", '[\n  {\n    "sessionId": "half');
    const adapter = adapterFor(home);
    expect((await adapter.poll()).health.state).toBe("error");

    await write(home, "sessions.json", indexText([entryOf(SESSION_ID)]));
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("a session's own file can be broken: it is never opened", async () => {
    const home = await homeWith([entryOf(SESSION_ID)]);
    await write(home, `${SESSION_ID}.json`, "not json");
    expect((await adapterFor(home).poll()).sessions).toHaveLength(1);
  });

  test("a folder in place of the list is not read", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, "sessions", "sessions.json"), { recursive: true });
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("error");
    expect(sessions).toEqual([]);
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(process.platform === "win32")("links", () => {
    test("a link in place of the list is not read", async () => {
      const elsewhere = path.join(await tempDir(), "elsewhere.json");
      await writeFile(elsewhere, indexText([entryOf(SESSION_ID)]));
      const home = await tempDir();
      await mkdir(path.join(home, "sessions"));
      await symlink(elsewhere, path.join(home, "sessions", "sessions.json"));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("error");
      expect(sessions).toEqual([]);
    });

    test("a link in place of a session's file is not a session", async () => {
      const elsewhere = path.join(await tempDir(), "elsewhere.json");
      await writeFile(elsewhere, sessionText(SESSION_ID));
      const home = await homeWith([]);
      await write(home, "sessions.json", indexText([entryOf(SESSION_ID)]));
      await symlink(elsewhere, path.join(home, "sessions", `${SESSION_ID}.json`));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });

    test("a link at Continue's own folder is followed", async () => {
      const real = await homeWith([entryOf(SESSION_ID)]);
      const home = path.join(await tempDir(), "linked");
      await symlink(real, home);
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toHaveLength(1);
    });

    test("a link in place of the sessions folder is not followed", async () => {
      const elsewhere = await homeWith([entryOf(SESSION_ID)]);
      const home = await tempDir();
      await symlink(path.join(elsewhere, "sessions"), path.join(home, "sessions"));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("error");
      expect(sessions).toEqual([]);
    });
  });
});
