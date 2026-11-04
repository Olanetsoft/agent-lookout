import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader } from "@collector/adapters/goose/database";
import { createGooseAdapter, WINDOWS_DETAIL } from "@collector/adapters/goose/index";
import { createCollector } from "@collector/collector";
import { nodeIo } from "@collector/files/readOnlyIo";
import {
  PRIVATE_TITLE,
  PRIVATE_WORDS,
  PROJECT,
  SCHEMA,
  sessionSql,
} from "@tests/fixtures/goose/goose";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, on a database this test writes,
// laid out as Goose v1.57.0's is, and through the collector, which runs the real
// `ps` on macOS and Linux. Whether a Goose runs on the machine under test is not
// known, so a test that goes through it takes either status. Where there is no
// sqlite3, as on Windows, nothing is read.

const sqlite = process.platform === "win32" ? null : await findSqlite();

/** Goose's data folder, with a database that holds these rows. */
async function homeWith(rows: string[]): Promise<string> {
  const home = path.join(await tempDir(), "goose");
  const file = path.join(home, "sessions", "sessions.db");
  await mkdir(path.dirname(file), { recursive: true });
  execFileSync(sqlite as string, ["-init", "/dev/null", file], {
    input: [SCHEMA, ...rows].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
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
      AGENT_LOOKOUT_GOOSE_HOME: home,
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
    const snapshot = await pollOnce(await homeWith([sessionSql()]), "darwin");

    const session = snapshot.sessions.find(({ source }) => source === "goose");
    expect(session).toMatchObject({
      id: "goose:20261001_1",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      surface: "unknown",
    });
    expect(["unknown", "finished"]).toContain(session?.status);
    expect(snapshot.sources.find(({ id }) => id === "goose")).toMatchObject({
      state: "ok",
      label: "Goose",
    });
    expect(snapshot.sources.find(({ id }) => id === "goose")?.watching).toContainEqual({
      label: "Read",
      value: "every 5 seconds",
    });
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_TITLE);
    expect(JSON.stringify(snapshot)).not.toContain(PRIVATE_WORDS);
  });

  test("a name the person set reaches it as they wrote it", async () => {
    const snapshot = await pollOnce(
      await homeWith([sessionSql({ name: "Release notes", userSetName: true })]),
      "darwin",
    );
    expect(snapshot.sessions.find(({ source }) => source === "goose")?.name).toBe("Release notes");
  });

  test("a folder with nothing in it lists no session, and is watched", async () => {
    const snapshot = await pollOnce(await tempDir(), "darwin");
    expect(snapshot.sources.find(({ id }) => id === "goose")?.state).toBe("ok");
    expect(snapshot.sessions.filter(({ source }) => source === "goose")).toEqual([]);
  });
});

describe("a session through the collector on Windows", () => {
  test("is not read, and the card says why", async () => {
    const home = await tempDir();
    const snapshot = await pollOnce(home, "win32");
    expect(snapshot.sources.find(({ id }) => id === "goose")).toMatchObject({
      state: "unavailable",
      detail: WINDOWS_DETAIL,
    });
    expect(snapshot.sessions.filter(({ source }) => source === "goose")).toEqual([]);
  });

  test.skipIf(sqlite === null)("is not read even with a database to read", async () => {
    const snapshot = await pollOnce(await homeWith([sessionSql()]), "win32");
    expect(snapshot.sessions.filter(({ source }) => source === "goose")).toEqual([]);
  });
});

describe("no sqlite3", () => {
  test("is a card that says so, with no session", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, "sessions"));
    await writeFile(path.join(home, "sessions", "sessions.db"), "database");
    const adapter = createGooseAdapter({
      env: { AGENT_LOOKOUT_GOOSE_HOME: home },
      platform: "linux",
      reader: createDatabaseReader({
        file: path.join(home, "sessions", "sessions.db"),
        io: nodeIo,
        platform: "linux",
        find: async () => null,
      }),
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toContain("No sqlite3 program was found");
    expect(sessions).toEqual([]);
  });
});
