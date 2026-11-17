import { spawn } from "node:child_process";
import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createKimchiAdapter,
  KIMCHI_PROGRAMS,
  STATUS_NOTE,
} from "@collector/adapters/kimchi/index";
import { createPiProcessReader } from "@collector/adapters/pi/processes";
import { createCollector } from "@collector/collector";
import {
  childHeader,
  conversationLines,
  headerFields,
  internalMarkerLine,
  line,
  nameLine,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  PROJECT,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  subagentMarkerLine,
} from "@tests/fixtures/kimchi/kimchi";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Kimchi
// v1.35.0 lays them out through Pi 1.3.0, and through the collector, which
// runs the real `ps` on macOS and Linux. Whether a Kimchi runs on the machine
// under test is not known, so a test that goes through it takes either status.

const FOLDER = "--Users-example-code-demo-project--";
const FILE_NAME = path.basename(sessionPath(SESSION_ID));

/** Kimchi's agent folder, with one project folder that holds these files by name. */
async function homeWith(files: Record<string, string>, folder = FOLDER) {
  const home = path.join(await tempDir(), "harness");
  const dir = path.join(home, "sessions", folder);
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
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
      AGENT_LOOKOUT_CONTINUE_HOME: await tempDir(),
      AGENT_LOOKOUT_CRUSH_HOME: await tempDir(),
      AGENT_LOOKOUT_KILO_HOME: await tempDir(),
      AGENT_LOOKOUT_MIMO_CODE_HOME: await tempDir(),
      AGENT_LOOKOUT_KIMCHI_HOME: home,
      AGENT_LOOKOUT_PRIME_AGENT_HOME: await tempDir(),
      AGENT_LOOKOUT_FX_HOME: await tempDir(),
      AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
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

/** A header whose time is now, since a real file is listed by the time it was written. */
const fresh = (id = SESSION_ID, changes: Record<string, unknown> = {}) =>
  line(
    headerFields(id, {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      ...changes,
    }),
  );

describe("a session through the collector on a Mac", () => {
  test("reaches the snapshot with its folder's name and a status, and none of what was said", async () => {
    const home = await homeWith({
      [FILE_NAME]: fresh() + nameLine() + conversationLines() + nameLine(),
    });
    const snapshot = await pollOnce(home, "darwin");

    const session = snapshot.sessions.find(({ source }) => source === "kimchi");
    expect(session).toMatchObject({
      id: `kimchi:${SESSION_ID}`,
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      surface: "unknown",
    });
    expect(["unknown", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "kimchi")).toMatchObject({
      state: "ok",
      label: "Kimchi",
    });
    const said = JSON.stringify(snapshot);
    for (const words of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_SYSTEM_PROMPT]) {
      expect(said).not.toContain(words.slice(0, 30));
    }
  });

  test("lists the person's sessions and leaves out the ones Kimchi made for itself", async () => {
    const subagent = sessionIdOf(2);
    const evaluator = sessionIdOf(3);
    const branch = sessionIdOf(4);
    const home = await homeWith({
      [FILE_NAME]: fresh() + conversationLines(),
      [path.basename(sessionPath(subagent))]:
        childHeader(subagent) + subagentMarkerLine() + conversationLines(),
      [path.basename(sessionPath(evaluator))]:
        childHeader(evaluator) + internalMarkerLine() + conversationLines(),
      [path.basename(sessionPath(branch))]: childHeader(branch) + conversationLines(),
      [`side-chats/${SESSION_ID}/${sessionIdOf(5)}.jsonl`]:
        childHeader(sessionIdOf(5)) + conversationLines(),
    });
    const snapshot = await pollOnce(home, "darwin");
    expect(
      snapshot.sessions
        .filter(({ source }) => source === "kimchi")
        .map(({ id }) => id)
        .sort(),
    ).toEqual([`kimchi:${SESSION_ID}`, `kimchi:${branch}`].sort());
  });
});

describe("a session through the collector on Windows", () => {
  test("is listed as unknown, since ps is not run there, and the card says so", async () => {
    const cwd = "C:\\Users\\example\\code\\demo-project";
    const home = await homeWith(
      { [FILE_NAME]: fresh(SESSION_ID, { cwd }) + conversationLines() },
      "--C--Users-example-code-demo-project--",
    );
    const snapshot = await pollOnce(home, "win32");

    expect(snapshot.sessions.find(({ source }) => source === "kimchi")).toMatchObject({
      id: `kimchi:${SESSION_ID}`,
      name: "demo-project",
      cwd,
      status: "unknown",
      statusSince: null,
    });
    const card = snapshot.sources.find(({ id }) => id === "kimchi");
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
    createKimchiAdapter({
      env: { AGENT_LOOKOUT_KIMCHI_HOME: home },
      platform: "linux",
      processes: { read: async () => ({ ok: true, running }) },
    });

  test("a session is read, and a name added later is not taken", async () => {
    const home = await homeWith({
      [FILE_NAME]: fresh() + conversationLines(),
      "broken.jsonl": "not json\n",
    });
    const adapter = adapterFor(home);
    const first = await adapter.poll();
    expect(first.sessions.map((session) => session.id)).toEqual([`kimchi:${SESSION_ID}`]);

    await appendFile(path.join(home, "sessions", FOLDER, FILE_NAME), nameLine("Named later"));
    const next = await adapter.poll();
    expect(next.sessions[0].name).toBe("demo-project");
  });

  test("a subagent's file that is still being made is listed neither before nor after its marker", async () => {
    const child = sessionIdOf(6);
    const file = path.basename(sessionPath(child));
    const home = await homeWith({ [file]: childHeader(child) });
    const adapter = adapterFor(home, false);
    expect((await adapter.poll()).sessions).toEqual([]);
    await appendFile(path.join(home, "sessions", FOLDER, file), subagentMarkerLine());
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("the folder KIMCHI_CODING_AGENT_SESSION_DIR names holds its files directly", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, FILE_NAME), fresh() + conversationLines());
    const { sessions } = await createKimchiAdapter({
      env: { KIMCHI_CODING_AGENT_SESSION_DIR: dir },
      platform: "linux",
      processes: { read: async () => ({ ok: true, running: false }) },
    }).poll();
    expect(sessions.map(({ id, status }) => [id, status])).toEqual([
      [`kimchi:${SESSION_ID}`, "finished"],
    ]);
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(process.platform === "win32")("links", () => {
    test("a link in place of a session file is not read", async () => {
      const elsewhere = path.join(await tempDir(), "elsewhere.jsonl");
      await writeFile(elsewhere, fresh() + conversationLines());
      const home = await homeWith({});
      await symlink(elsewhere, path.join(home, "sessions", FOLDER, FILE_NAME));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });
  });
});

// `ps` only reads, so the real one is asked, for the name each process gives
// its program and nothing else. Kimchi is a stand-in that only waits: this
// Node, which sets `process.title` as Kimchi's `src/entry.ts` does. So this
// checks what Kimchi's source leads to, not Kimchi. Windows has no `ps`.
describe.skipIf(process.platform === "win32")("the real ps", () => {
  test("sees a Node program titled kimchi, and not one titled pi", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const reader = createPiProcessReader({ platform, programs: KIMCHI_PROGRAMS });
    for (const [title, running] of [
      ["pi", false],
      ["kimchi", true],
    ] as const) {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.title = ${JSON.stringify(title)}; console.log("ready"); setTimeout(() => {}, 60_000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      onTestFinished(async () => {
        child.kill();
        await ended;
      });
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      // Another program called kimchi may run on the machine under test, so only a yes is sure.
      if (running) expect(await reader.read(), title).toEqual({ ok: true, running: true });
      else expect((await reader.read()).ok, title).toBe(true);
    }
  });
});
