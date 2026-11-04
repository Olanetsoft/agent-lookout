import { execFileSync } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createCrushAdapter, WINDOWS_DETAIL } from "@collector/adapters/crush/index";
import { databaseOf, PROJECT_LIST_FILE } from "@collector/adapters/crush/projects";
import { projectPrefix } from "@collector/adapters/crush/toSession";
import { createCollector } from "@collector/collector";
import {
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  projectListJson,
  SCHEMA,
  SESSION_ID,
  sessionSql,
} from "@tests/fixtures/crush/crush";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, on databases this test writes,
// laid out as Crush v0.99.0's are, and through the collector, which runs the real
// `ps` on macOS and Linux. Whether a Crush runs on the machine under test is not
// known, so a test that goes through it takes either status. Where there is no
// sqlite3, as on Windows, nothing is read.

const sqlite = process.platform === "win32" ? null : await findSqlite();

/** A project's folder, under this folder, with a database that holds these rows. */
async function projectWith(parent: string, name: string, rows: string[]): Promise<string> {
  const folder = path.join(parent, name);
  const file = databaseOf(folder);
  await mkdir(path.dirname(file), { recursive: true });
  execFileSync(sqlite as string, ["-init", "/dev/null", file], {
    input: [SCHEMA, ...rows].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  return folder;
}

/** Crush's data folder, with a list of these folders. */
async function homeListing(folders: readonly string[]): Promise<string> {
  const home = path.join(await tempDir(), "crush");
  await mkdir(home);
  await writeFile(path.join(home, PROJECT_LIST_FILE), projectListJson(folders));
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
      AGENT_LOOKOUT_CRUSH_HOME: home,
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

describe.skipIf(sqlite === null)("a session through the collector on a Mac", () => {
  test("reaches the snapshot with its name, folder and a status, and none of what was said", async () => {
    const folder = await projectWith(await tempDir(), "demo-project", [sessionSql()]);
    const snapshot = await pollOnce(await homeListing([folder]), "darwin");

    const session = snapshot.sessions.find(({ source }) => source === "crush");
    expect(session).toMatchObject({
      id: `${projectPrefix(folder)}${SESSION_ID}`,
      name: "demo-project",
      cwd: folder,
      project: "demo-project",
      surface: "unknown",
    });
    expect(["unknown", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "crush")).toMatchObject({
      state: "ok",
      label: "Crush",
    });
    expect(snapshot.sources.find(({ id }) => id === "crush")?.watching).toContainEqual({
      label: "Read",
      value: "every 5 seconds",
    });
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_WORDS);
  });

  test("sessions of two projects both reach it, each with its own folder", async () => {
    const parent = await tempDir();
    const first = await projectWith(parent, "demo-project", [sessionSql()]);
    const second = await projectWith(parent, "other-project", [sessionSql()]);
    const snapshot = await pollOnce(await homeListing([first, second]), "darwin");
    const sessions = snapshot.sessions.filter(({ source }) => source === "crush");
    expect(sessions.map(({ cwd }) => cwd).sort()).toEqual([first, second].sort());
  });

  test("a project that has gone, and one reached by a link, leave the other read", async () => {
    const parent = await tempDir();
    const real = await projectWith(parent, "demo-project", [sessionSql()]);
    const link = path.join(parent, "linked-project");
    await symlink(await projectWith(await tempDir(), "elsewhere", [sessionSql()]), link);
    const gone = path.join(parent, "gone-project");
    const snapshot = await pollOnce(await homeListing([gone, link, real]), "darwin");
    const sessions = snapshot.sessions.filter(({ source }) => source === "crush");
    expect(sessions.map(({ cwd }) => cwd)).toEqual([real]);
    const card = snapshot.sources.find(({ id }) => id === "crush");
    expect(card?.state).toBe("ok");
    expect(card?.detail).toContain("Not read: linked-project, because a link");
  });

  test("a list that names a relative path reaches no folder", async () => {
    const snapshot = await pollOnce(
      await homeListing(["demo-project", "../demo-project"]),
      "darwin",
    );
    expect(snapshot.sources.find(({ id }) => id === "crush")?.state).toBe("ok");
    expect(snapshot.sessions.filter(({ source }) => source === "crush")).toEqual([]);
  });

  test("a folder with nothing in it lists no session, and is watched", async () => {
    const snapshot = await pollOnce(await tempDir(), "darwin");
    expect(snapshot.sources.find(({ id }) => id === "crush")?.state).toBe("ok");
    expect(snapshot.sessions.filter(({ source }) => source === "crush")).toEqual([]);
  });
});

describe("a session through the collector on Windows", () => {
  test("is not read, and the card says why", async () => {
    const snapshot = await pollOnce(await tempDir(), "win32");
    expect(snapshot.sources.find(({ id }) => id === "crush")).toMatchObject({
      state: "unavailable",
      detail: WINDOWS_DETAIL,
    });
    expect(snapshot.sessions.filter(({ source }) => source === "crush")).toEqual([]);
  });

  test.skipIf(sqlite === null)("is not read even with a database to read", async () => {
    const folder = await projectWith(await tempDir(), "demo-project", [sessionSql()]);
    const snapshot = await pollOnce(await homeListing([folder]), "win32");
    expect(snapshot.sessions.filter(({ source }) => source === "crush")).toEqual([]);
  });
});

// A folder on Windows is no POSIX path, so nothing there is taken from the list.
describe.skipIf(process.platform === "win32")("no sqlite3", () => {
  test("is a card that says so, with no session", async () => {
    const parent = await tempDir();
    const folder = path.join(parent, "demo-project");
    await mkdir(path.join(folder, ".crush"), { recursive: true });
    await writeFile(path.join(folder, ".crush", "crush.db"), "database");
    const adapter = createCrushAdapter({
      env: { AGENT_LOOKOUT_CRUSH_HOME: await homeListing([folder]) },
      platform: "linux",
      find: async () => null,
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("no sqlite3 program was found");
    expect(sessions).toEqual([]);
  });
});
