import { appendFile, mkdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createPiAdapter, STATUS_NOTE } from "@collector/adapters/pi/index";
import { createCollector } from "@collector/collector";
import {
  conversationLines,
  headerFields,
  line,
  nameLine,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  sessionText,
} from "@tests/fixtures/pi/pi";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Pi v1.5.0
// lays them out, and through the collector, which runs the real `ps` on macOS and
// Linux. Whether a Pi runs on the machine under test is not known, so a test that
// goes through it takes either status.

const FILE_NAME = path.basename(sessionPath(SESSION_ID));

/** Pi's agent folder, with one project folder that holds these files by name. */
async function homeWith(files: Record<string, string>, folder = "--Users-example-demo--") {
  const home = path.join(await tempDir(), "agent");
  const dir = path.join(home, "sessions", folder);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
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
      AGENT_LOOKOUT_PI_HOME: home,
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

/** A header whose time is now, since a real file is listed by the time it was written. */
const fresh = (changes: Record<string, unknown> = {}) =>
  line(
    headerFields(SESSION_ID, {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      ...changes,
    }),
  );

describe("a session through the collector on a Mac", () => {
  test("reaches the snapshot with its name, folder and a status, and none of what was said", async () => {
    const home = await homeWith({ [FILE_NAME]: fresh() + conversationLines() });
    const snapshot = await pollOnce(home, "darwin");

    const session = snapshot.sessions.find(({ source }) => source === "pi");
    expect(session).toMatchObject({
      id: `pi:${SESSION_ID}`,
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      surface: "unknown",
    });
    expect(["unknown", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "pi")).toMatchObject({
      state: "ok",
      label: "Pi",
    });
    expect(snapshot.sources.find(({ id }) => id === "pi")?.watching).toContainEqual({
      label: "Read",
      value: "every 5 seconds",
    });
    const said = JSON.stringify(snapshot);
    for (const word of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_SYSTEM_PROMPT]) {
      expect(said).not.toContain(word);
    }
  });

  test("a name given to it reaches it as it was written", async () => {
    const home = await homeWith({
      [FILE_NAME]: fresh() + nameLine("Release notes") + conversationLines(),
    });
    const snapshot = await pollOnce(home, "darwin");
    expect(snapshot.sessions.find(({ source }) => source === "pi")?.name).toBe("Release notes");
  });

  test("a folder with nothing in it lists no session, and is watched", async () => {
    const snapshot = await pollOnce(await tempDir(), "darwin");
    expect(snapshot.sources.find(({ id }) => id === "pi")?.state).toBe("ok");
    expect(snapshot.sessions.filter(({ source }) => source === "pi")).toEqual([]);
  });
});

describe("a session through the collector on Windows", () => {
  test("is listed as unknown, since ps is not run there, and the card says so", async () => {
    const cwd = "C:\\Users\\example\\code\\demo-project";
    const home = await homeWith(
      { [FILE_NAME]: fresh({ cwd }) + conversationLines() },
      "--C--Users-example-code-demo-project--",
    );
    const snapshot = await pollOnce(home, "win32");

    expect(snapshot.sessions.find(({ source }) => source === "pi")).toMatchObject({
      id: `pi:${SESSION_ID}`,
      name: "demo-project",
      cwd,
      status: "unknown",
      statusSince: null,
    });
    const card = snapshot.sources.find(({ id }) => id === "pi");
    expect(card?.state).toBe("ok");
    expect(card?.detail).toContain(STATUS_NOTE);
    expect(card?.detail).toContain("no session is shown as finished");
    expect(card?.watching).toContainEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
  });
});

describe("real files", () => {
  const adapterFor = (home: string, running = true) =>
    createPiAdapter({
      env: { AGENT_LOOKOUT_PI_HOME: home },
      platform: "linux",
      processes: { read: async () => ({ ok: true, running }) },
    });

  test("a session and its added name are read", async () => {
    const home = await homeWith({
      [FILE_NAME]: fresh() + conversationLines(),
      "broken.jsonl": "not json\n",
      [path.basename(sessionPath(sessionIdOf(2)))]: `${"x".repeat(100_000)}\n`,
    });
    const adapter = adapterFor(home);
    const first = await adapter.poll();
    expect(first.sessions.map((session) => session.id)).toEqual([`pi:${SESSION_ID}`]);

    const file = path.join(home, "sessions", "--Users-example-demo--", FILE_NAME);
    await appendFile(file, nameLine("Named later"));
    const next = await adapter.poll();
    expect(next.sessions[0].name).toBe("Named later");
  });

  test("a session not written for a day is left alone", async () => {
    const old = path.basename(sessionPath(sessionIdOf(3)));
    const home = await homeWith({
      [FILE_NAME]: fresh() + conversationLines(),
      [old]: fresh({ id: sessionIdOf(3) }),
    });
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(
      path.join(home, "sessions", "--Users-example-demo--", old),
      twoDaysAgo,
      twoDaysAgo,
    );
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map((session) => session.id)).toEqual([`pi:${SESSION_ID}`]);
  });

  test("a finished session's time is its file's modified time, which a disk gives with a fraction", async () => {
    const home = await homeWith({ [FILE_NAME]: fresh() });
    const { sessions } = await adapterFor(home, false).poll();
    const file = path.join(home, "sessions", "--Users-example-demo--", FILE_NAME);
    expect(sessions[0]).toMatchObject({
      status: "finished",
      statusSince: Math.floor((await stat(file)).mtimeMs),
    });
  });

  test("a large file is read at each end", async () => {
    const start = fresh() + nameLine("From the start") + conversationLines().repeat(4_000);
    const fromStart = await adapterFor(await homeWith({ [FILE_NAME]: start })).poll();
    expect(fromStart.sessions[0].name).toBe("From the start");

    const ended = start + nameLine("From the end");
    const fromEnd = await adapterFor(await homeWith({ [FILE_NAME]: ended })).poll();
    expect(fromEnd.sessions[0].name).toBe("From the end");
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(process.platform === "win32")("links", () => {
    test("a link in place of a session file is not read", async () => {
      const elsewhere = path.join(await tempDir(), "elsewhere.jsonl");
      await writeFile(elsewhere, sessionText(SESSION_ID));
      const home = await homeWith({});
      await symlink(elsewhere, path.join(home, "sessions", "--Users-example-demo--", FILE_NAME));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });

    test("a link in place of a project folder is not followed", async () => {
      const elsewhere = await tempDir();
      await writeFile(path.join(elsewhere, FILE_NAME), fresh());
      const home = await homeWith({});
      await symlink(elsewhere, path.join(home, "sessions", "--Users-example-other--"));
      const { sessions } = await adapterFor(home).poll();
      expect(sessions).toEqual([]);
    });

    test("the sessions folder itself can be a link, as Pi's own list allows", async () => {
      const elsewhere = await tempDir();
      const folder = path.join(elsewhere, "--Users-example-demo--");
      await mkdir(folder);
      await writeFile(path.join(folder, FILE_NAME), fresh());
      const home = await tempDir();
      await symlink(elsewhere, path.join(home, "sessions"));
      const { sessions } = await adapterFor(home).poll();
      expect(sessions).toHaveLength(1);
    });
  });
});
