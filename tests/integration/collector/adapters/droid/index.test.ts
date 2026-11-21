import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createDroidAdapter, DROID_PROGRAMS, STATUS_NOTE } from "@collector/adapters/droid/index";
import { createDroidSessionReader } from "@collector/adapters/droid/sessionFile";
import { createPiProcessReader } from "@collector/adapters/pi/processes";
import { createCollector } from "@collector/collector";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  CWD,
  messageLine,
  OWNER,
  PRIVATE_PROMPT,
  PRIVATE_TAG,
  PRIVATE_TITLE,
  PROJECT_FOLDER_NAME,
  SESSION_ID,
  sessionIdOf,
  sessionText,
  settings,
} from "@tests/fixtures/droid/droid";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as
// Factory's Droid SDKs read them, and through the collector, which runs the
// real `ps` on macOS and Linux. Whether a Droid runs on the machine under test
// is not known, so a test that goes through it takes either status, and the
// others give the adapter a stand-in for `ps`.

/** A Droid folder, `.factory`, with these files by their path in `sessions`. */
async function homeWith(files: Record<string, string>) {
  const home = path.join(await tempDir(), ".factory");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(home, "sessions", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return home;
}

const inProject = (name: string) => path.join(PROJECT_FOLDER_NAME, name);

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
      AGENT_LOOKOUT_FX_HOME: await tempDir(),
      AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
      AGENT_LOOKOUT_DROID_HOME: home,
      AGENT_LOOKOUT_GROK_HOME: await tempDir(),
      AGENT_LOOKOUT_OMP_HOME: await tempDir(),
      AGENT_LOOKOUT_MUSE_CODE_HOME: await tempDir(),
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

/** An adapter of these real files, with a stand-in for `ps` that says whether a droid runs. */
const adapterFor = (home: string, running = true, platform: NodeJS.Platform = "linux") =>
  createDroidAdapter({
    env: { AGENT_LOOKOUT_DROID_HOME: home },
    platform,
    processes: { read: async () => ({ ok: true, running }) },
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

describe("a session through the collector on a Mac", () => {
  test("reaches the snapshot with its folder's name and a status, and no title, owner, prompt or tag", async () => {
    const home = await homeWith({
      [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      [inProject(`${SESSION_ID}.settings.json`)]: settings(),
    });
    const snapshot = await pollOnce(home, "darwin");

    const session = snapshot.sessions.find(({ source }) => source === "droid");
    expect(session).toMatchObject({
      id: `droid:${SESSION_ID}`,
      name: "demo-project",
      cwd: CWD,
      project: "demo-project",
      surface: "unknown",
    });
    expect(["unknown", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "droid")).toMatchObject({
      state: "ok",
      label: "Droid",
    });
    const said = JSON.stringify(snapshot);
    for (const words of [PRIVATE_TITLE, OWNER, PRIVATE_PROMPT, PRIVATE_TAG]) {
      expect(said).not.toContain(words);
    }
  });
});

describe("a session through the collector on Windows", () => {
  test("is listed as unknown, since ps is not run there, and the card says so", async () => {
    const cwd = "C:\\Users\\example\\code\\demo-project";
    const home = await homeWith({
      [path.join("-C-Users-example-code-demo-project", `${SESSION_ID}.jsonl`)]: sessionText({
        cwd,
      }),
    });
    const snapshot = await pollOnce(home, "win32");

    expect(snapshot.sessions.find(({ source }) => source === "droid")).toMatchObject({
      id: `droid:${SESSION_ID}`,
      name: "demo-project",
      cwd,
      status: "unknown",
      statusSince: null,
    });
    const card = snapshot.sources.find(({ id }) => id === "droid");
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
  test("project folders and older loose files are read, and nothing else", async () => {
    const home = await homeWith({
      [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      [`${sessionIdOf(2)}.jsonl`]: sessionText({ cwd: CWD }),
      [path.join("notes", `${sessionIdOf(3)}.jsonl`)]: sessionText({ cwd: CWD }),
      ".favorites": JSON.stringify([SESSION_ID]),
    });
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map(({ id }) => id).sort()).toEqual(
      [`droid:${SESSION_ID}`, `droid:${sessionIdOf(2)}`].sort(),
    );
  });

  test("an archived session is left out, and shown again once unarchived", async () => {
    const settingsFile = inProject(`${SESSION_ID}.settings.json`);
    const home = await homeWith({
      [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      [settingsFile]: settings({ archivedAt: "2026-11-01T00:00:00Z" }),
    });
    // Written a minute ago, so ps's answer that no droid runs tells, whatever time it is.
    const before = new Date(Date.now() - 60_000);
    await utimes(path.join(home, "sessions", inProject(`${SESSION_ID}.jsonl`)), before, before);
    const adapter = adapterFor(home, false);
    expect((await adapter.poll()).sessions).toEqual([]);
    await writeFile(path.join(home, "sessions", settingsFile), settings());
    // A time of its own, so the change is seen on a disk that keeps whole seconds.
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(home, "sessions", settingsFile), later, later);
    expect((await adapter.poll()).sessions.map(({ id, status }) => [id, status])).toEqual([
      [`droid:${SESSION_ID}`, "finished"],
    ]);
  });

  test("a session written within 2 seconds of ps's answer is not finished by it", async () => {
    const file = inProject(`${SESSION_ID}.jsonl`);
    const home = await homeWith({ [file]: sessionText({ cwd: CWD }) });
    // Ahead of the clock, so the answer is asked too soon whatever time it is.
    const ahead = new Date(Date.now() + 30_000);
    await utimes(path.join(home, "sessions", file), ahead, ahead);
    const { sessions } = await adapterFor(home, false).poll();
    expect(sessions.map(({ status }) => status)).toEqual(["unknown"]);
    const before = new Date(Date.now() - 60_000);
    await utimes(path.join(home, "sessions", file), before, before);
    expect((await adapterFor(home, false).poll()).sessions.map(({ status }) => status)).toEqual([
      "finished",
    ]);
  });

  test("nothing in Droid's folder is written, moved or touched by several polls", async () => {
    const home = await homeWith({
      [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      [inProject(`${SESSION_ID}.settings.json`)]: settings({ archivedAt: "" }),
      [inProject(`${sessionIdOf(2)}.jsonl`)]: sessionText({ cwd: CWD }, ""),
      ".favorites": "[]",
    });
    await writeFile(path.join(home, "settings.json"), "{}");
    const before = await tree(home);
    const adapter = adapterFor(home);
    for (let poll = 0; poll < 3; poll += 1) await adapter.poll();
    expect(await tree(home)).toEqual(before);
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(process.platform === "win32")("links", () => {
    test("a link in place of a session file, or of a project folder, is not read", async () => {
      const elsewhere = await tempDir();
      await writeFile(path.join(elsewhere, `${SESSION_ID}.jsonl`), sessionText({ cwd: CWD }));
      const home = await homeWith({});
      await mkdir(path.join(home, "sessions", PROJECT_FOLDER_NAME));
      await symlink(
        path.join(elsewhere, `${SESSION_ID}.jsonl`),
        path.join(home, "sessions", inProject(`${SESSION_ID}.jsonl`)),
      );
      await symlink(elsewhere, path.join(home, "sessions", "-linked"));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });

    test("a linked settings file is not read, and its session is listed", async () => {
      const elsewhere = path.join(await tempDir(), "archived.json");
      await writeFile(elsewhere, settings({ archivedAt: "2026-11-01T00:00:00Z" }));
      const home = await homeWith({
        [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      });
      await symlink(
        elsewhere,
        path.join(home, "sessions", inProject(`${SESSION_ID}.settings.json`)),
      );
      expect((await adapterFor(home).poll()).sessions.map(({ id }) => id)).toEqual([
        `droid:${SESSION_ID}`,
      ]);
    });

    test("a project folder made a link after its file was looked up is not followed", async () => {
      const home = await homeWith({
        [inProject(`${SESSION_ID}.jsonl`)]: sessionText({ cwd: CWD }),
      });
      const sessions = path.join(home, "sessions");
      const file = path.join(sessions, inProject(`${SESSION_ID}.jsonl`));
      const info = await nodeIo.lstat(file);
      // The folder is moved away and a link to it put at its name.
      const moved = path.join(await tempDir(), "moved");
      await rename(path.join(sessions, PROJECT_FOLDER_NAME), moved);
      await symlink(moved, path.join(sessions, PROJECT_FOLDER_NAME));
      const reader = createDroidSessionReader(sessions, nodeIo, "linux");
      expect(await reader.read({ path: file, info }, SESSION_ID)).toEqual({ state: "none" });
    });
  });

  test("a file with only its first line is left out until Droid writes more", async () => {
    const file = inProject(`${SESSION_ID}.jsonl`);
    const home = await homeWith({ [file]: sessionText({ cwd: CWD }, "") });
    const adapter = adapterFor(home);
    expect((await adapter.poll()).sessions).toEqual([]);
    await writeFile(path.join(home, "sessions", file), sessionText({ cwd: CWD }, messageLine()));
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(home, "sessions", file), later, later);
    expect((await adapter.poll()).sessions.map(({ id }) => id)).toEqual([`droid:${SESSION_ID}`]);
  });
});

// `ps` only reads, so the real one is asked, for the name each process gives
// its program and nothing else. Droid is a stand-in that only waits: a Node
// program titled `droid`. So this checks the names this looks for, not Droid,
// which was not run to write it. Windows has no `ps`.
describe.skipIf(process.platform === "win32")("the real ps", () => {
  test.each(["droid", "droid-dev"])("sees a program titled %s", async (title) => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const reader = createPiProcessReader({ platform, programs: DROID_PROGRAMS });
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
    // Droid itself may run on the machine under test, so only a yes is sure.
    expect(await reader.read()).toEqual({ ok: true, running: true });
  });
});
