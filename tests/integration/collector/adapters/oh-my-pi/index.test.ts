import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createDshProcessReader,
  type DshPrograms,
} from "@collector/adapters/deepseek-harness/processes";
import { createOhMyPiAdapter, ompNamesFor, STATUS_NOTE } from "@collector/adapters/oh-my-pi/index";
import { createOmpSessionReader } from "@collector/adapters/oh-my-pi/sessionFile";
import { createCollector } from "@collector/collector";
import { nodeIo } from "@collector/files/readOnlyIo";
import { runPs } from "@collector/processes/ps";
import {
  codexLines,
  CWD,
  message,
  PRIVATE_CODEX_TITLE,
  PRIVATE_WORDS,
  PROJECT_FOLDER_NAME,
  SESSION_ID,
  sessionExit,
  sessionIdOf,
  sessionText,
  toolStart,
} from "@tests/fixtures/oh-my-pi/ohMyPi";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Oh My
// Pi's source at v19.0.0 writes them, and through the collector, which runs
// the real `ps` on macOS and Linux. Whether an Oh My Pi, or on a Mac any
// `bun`, runs on the machine under test is not known, so a test that goes
// through the real `ps` takes any status, and the others give the adapter a
// stand-in for it. Every time a file holds is set from the clock when the
// test runs, so the real date does not matter.

const FILE_NAME = `2026-10-01T11-00-00-000Z_${SESSION_ID}.jsonl`;
const inProject = (name: string = FILE_NAME) => path.join(PROJECT_FOLDER_NAME, name);

/** An agent folder, with these files by their path in `sessions`. */
async function homeWith(files: Record<string, string>) {
  const home = path.join(await tempDir(), "agent");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(home, "sessions", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return home;
}

/** A session's text, its times set from the clock now. */
function textNow(lines: (at: number) => string, slot?: Parameters<typeof sessionText>[1]) {
  const now = Date.now();
  return sessionText(lines(now - 60_000), {
    ...slot,
    header: { at: now - 3_600_000, ...slot?.header },
  });
}

/** A stand-in for `ps` that lists an `omp` that started an hour ago, or none. */
function standInPs(running: boolean) {
  const programs = running ? [{ start: Date.now() - 3_600_000, desktop: true }] : [];
  const answer: DshPrograms = { ok: true, ownListed: true, programs };
  return { read: async () => answer };
}

/** An adapter of these real files, with a stand-in for `ps`. */
const adapterFor = (home: string, running = true, platform: NodeJS.Platform = "linux") =>
  createOhMyPiAdapter({
    env: { AGENT_LOOKOUT_OMP_HOME: home },
    platform,
    processes: standInPs(running),
  });

/** Sets a file's times to `secondsAgo` before now. */
async function writtenAgo(file: string, secondsAgo: number) {
  const at = new Date(Date.now() - secondsAgo * 1000);
  await utimes(file, at, at);
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
      AGENT_LOOKOUT_FX_HOME: await tempDir(),
      AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
      AGENT_LOOKOUT_DROID_HOME: await tempDir(),
      AGENT_LOOKOUT_GROK_HOME: await tempDir(),
      AGENT_LOOKOUT_OMP_HOME: home,
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
  test("reaches the snapshot with its folder and a status, and nothing of its prompts, replies or tools", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at }) + toolStart("bash", at), {
        slot: { title: "Fix the flaky tests", source: "user" },
      }),
    });
    const platform =
      process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    const snapshot = await pollOnce(home, platform);
    const session = snapshot.sessions.find(({ source }) => source === "oh-my-pi");
    expect(session).toMatchObject({
      id: `oh-my-pi:${SESSION_ID}`,
      cwd: CWD,
      project: "demo-project",
      surface: "unknown",
    });
    // The title is shown once two reads agree, so the first poll shows the folder's name.
    expect(session?.name).toBe("demo-project");
    // A real omp, or on a Mac a bun, may run here, so any status may show.
    expect(["unknown", "working", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "oh-my-pi")).toMatchObject({
      state: "ok",
      label: "Oh My Pi",
    });
    const said = JSON.stringify(snapshot);
    for (const word of PRIVATE_WORDS) expect(said).not.toContain(word);
  });

  test("on Windows, ps is not run, and only an exit says a session is finished", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at })),
      [inProject(`2026-10-01T11-00-00-000Z_${sessionIdOf(2)}.jsonl`)]: textNow(
        (at) => message("user", { at }) + sessionExit("normal", at),
        { header: { id: sessionIdOf(2) } },
      ),
    });
    const snapshot = await pollOnce(home, "win32");
    const statuses = new Map(
      snapshot.sessions
        .filter(({ source }) => source === "oh-my-pi")
        .map(({ id, status }) => [id, status]),
    );
    expect(statuses).toEqual(
      new Map([
        [`oh-my-pi:${SESSION_ID}`, "unknown"],
        [`oh-my-pi:${sessionIdOf(2)}`, "finished"],
      ]),
    );
    const card = snapshot.sources.find(({ id }) => id === "oh-my-pi");
    expect(card?.detail).toContain(STATUS_NOTE);
    expect(card?.watching).toContainEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
  });
});

describe("real files", () => {
  test("project folders and files loose in the sessions folder are read, and nothing else", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at })),
      [`2026-10-01T11-00-00-000Z_${sessionIdOf(2)}.jsonl`]: textNow(
        (at) => message("user", { at }),
        {
          header: { id: sessionIdOf(2) },
        },
      ),
      [path.join("notes", `x_${sessionIdOf(3)}.jsonl`)]: textNow((at) => message("user", { at }), {
        header: { id: sessionIdOf(3) },
      }),
      [inProject(`2026-10-01T11-00-00-000Z_${SESSION_ID}/agent-1.jsonl`)]: textNow(
        (at) => toolStart("ask", at),
        { header: { id: sessionIdOf(4) } },
      ),
    });
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map(({ id }) => id).sort()).toEqual(
      [`oh-my-pi:${SESSION_ID}`, `oh-my-pi:${sessionIdOf(2)}`].sort(),
    );
  });

  test("working, needing you, finished and failed, from each file's newest lines", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at })),
      [inProject(`a_${sessionIdOf(2)}.jsonl`)]: textNow((at) => toolStart("ask", at), {
        header: { id: sessionIdOf(2) },
      }),
      [inProject(`b_${sessionIdOf(3)}.jsonl`)]: textNow(
        (at) =>
          toolStart("bash", at) +
          sessionExit("fatal", at) +
          message("toolResult", { at }) +
          message("assistant", { at }),
        { header: { id: sessionIdOf(3) } },
      ),
    });
    const { sessions } = await adapterFor(home).poll();
    expect(new Map(sessions.map(({ id, status }) => [id, status]))).toEqual(
      new Map([
        [`oh-my-pi:${SESSION_ID}`, "working"],
        [`oh-my-pi:${sessionIdOf(2)}`, "needs-you"],
        [`oh-my-pi:${sessionIdOf(3)}`, "failed"],
      ]),
    );
  });

  test("finished once no omp runs, by an answer asked late enough after the last write", async () => {
    const file = inProject();
    const home = await homeWith({ [file]: textNow((at) => message("user", { at })) });
    await writtenAgo(path.join(home, "sessions", file), 60);
    expect((await adapterFor(home, false).poll()).sessions.map(({ status }) => status)).toEqual([
      "finished",
    ]);
    // Ahead of the clock, so the answer is asked too soon whatever time it is.
    await writtenAgo(path.join(home, "sessions", file), -30);
    expect((await adapterFor(home, false).poll()).sessions.map(({ status }) => status)).toEqual([
      "unknown",
    ]);
  });

  test("the title is shown once two reads agree, and a Codex session's copy's is not", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at }), {
        slot: { title: "Fix the flaky tests", source: "user" },
      }),
      [inProject(`a_${sessionIdOf(2)}.jsonl`)]: sessionText(codexLines(1), {
        slot: { title: PRIVATE_CODEX_TITLE, source: "auto" },
        header: { id: sessionIdOf(2), at: Date.now() - 3_600_000 },
      }),
    });
    const adapter = adapterFor(home);
    await adapter.poll();
    const { sessions } = await adapter.poll();
    expect(new Map(sessions.map(({ id, name }) => [id, name]))).toEqual(
      new Map([
        [`oh-my-pi:${SESSION_ID}`, "Fix the flaky tests"],
        [`oh-my-pi:${sessionIdOf(2)}`, "demo-project"],
      ]),
    );
  });

  test("nothing in Oh My Pi's folder is written, moved or touched by several polls", async () => {
    const home = await homeWith({
      [inProject()]: textNow((at) => message("user", { at })),
      [inProject(`.${FILE_NAME}.lock`)]: "123:456\n",
      [inProject(`2026-10-01T11-00-00-000Z_${SESSION_ID}/agent-1.jsonl`)]: "{}\n",
    });
    await mkdir(path.join(home, "..", "run", "session-owners"), { recursive: true });
    const before = await tree(path.dirname(home));
    const adapter = adapterFor(home);
    for (let poll = 0; poll < 3; poll += 1) await adapter.poll();
    expect(await tree(path.dirname(home))).toEqual(before);
  });

  // Windows gives a link to whoever may make one, and not to every test run.
  describe.skipIf(process.platform === "win32")("links", () => {
    test("a link in place of a session file, or of a project folder, is not read", async () => {
      const elsewhere = await tempDir();
      await writeFile(
        path.join(elsewhere, FILE_NAME),
        textNow((at) => message("user", { at })),
      );
      const home = await homeWith({});
      await mkdir(path.join(home, "sessions", PROJECT_FOLDER_NAME));
      await symlink(path.join(elsewhere, FILE_NAME), path.join(home, "sessions", inProject()));
      await symlink(elsewhere, path.join(home, "sessions", "-linked"));
      const { health, sessions } = await adapterFor(home).poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    });

    test("a project folder made a link after its file was looked up is not followed", async () => {
      const home = await homeWith({ [inProject()]: textNow((at) => message("user", { at })) });
      const sessions = path.join(home, "sessions");
      const file = path.join(sessions, inProject());
      const info = await nodeIo.lstat(file);
      const moved = path.join(await tempDir(), "moved");
      await rename(path.join(sessions, PROJECT_FOLDER_NAME), moved);
      await symlink(moved, path.join(sessions, PROJECT_FOLDER_NAME));
      const reader = createOmpSessionReader(sessions, nodeIo, "linux");
      expect(await reader.read({ path: file, info }, Date.now())).toEqual({ state: "none" });
    });
  });
});

// `ps` only reads, so the real one is asked, for each process's ID, when it
// started and the name it gives its program, and nothing else. Oh My Pi is a
// stand-in that only waits: a Node program titled `omp`. So this checks the
// names this looks for, not Oh My Pi, which was not run to write it. Windows
// has no `ps`.
describe.skipIf(process.platform === "win32")("the real ps", () => {
  test("lists a program titled omp as one that backs a session", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const child = spawn(
      process.execPath,
      ["-e", 'process.title = "omp"; console.log("ready"); setTimeout(() => {}, 60_000);'],
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
    const reader = createDshProcessReader({
      platform,
      run: runPs,
      ownPid: process.pid,
      names: ompNamesFor(platform),
    });
    const answer = await reader.read();
    // Another omp may run on the machine under test, so only that one is listed is checked.
    expect(answer).toMatchObject({ ok: true, ownListed: true });
    expect(answer.ok && answer.programs.some(({ desktop }) => desktop)).toBe(true);
  });
});
