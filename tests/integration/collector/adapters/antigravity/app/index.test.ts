import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createAntigravityAppAdapter,
  type AntigravityAppAdapterOptions,
} from "@collector/adapters/antigravity/app/index";
import { findSqlite } from "@collector/adapters/antigravity/app/summaries";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  annotationPath,
  appStep,
  appTurn,
  conversationId,
  databasePath,
  DAY,
  failedTurn,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  replyStep,
  SECOND,
  summariesPath,
  textStep,
  transcriptPath,
  workspaceUris,
} from "@tests/fixtures/antigravity";
import { standInHub } from "@tests/support/adapters/antigravityAdapter";
import { NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter on real files laid out as Antigravity 2.0 lays out its folder,
// with the real sqlite3 where there is one, and a stand-in for `ps`, since
// this machine may have the app itself open.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const WORKING = conversationId("a1");
const IDLE = conversationId("b2");
const FAILED = conversationId("c3");
const OLD = conversationId("d4");
const FOLDER = "/Users/example/code/demo-project";

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof ReadOnlyIo; path: string }[] = [];
  const io: ReadOnlyIo = {
    readdir: (target) => (calls.push({ method: "readdir", path: target }), nodeIo.readdir(target)),
    stat: (target) => (calls.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (calls.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    openRegular: (target) => (
      calls.push({ method: "openRegular", path: target }),
      nodeIo.openRegular(target)
    ),
  };
  return { io, calls };
}

/** Everything under a folder: each ordinary file's hash, size and modified time, each link's target and each other thing's kind. */
async function snapshotOf(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const target = path.join(dir, name);
      const relative = path.relative(root, target);
      const info = await lstat(target);
      if (info.isDirectory()) {
        found[relative] = "folder";
        await walk(target);
      } else if (info.isSymbolicLink()) {
        found[relative] = `link to ${await readlink(target)}`;
      } else {
        const hash = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        found[relative] = `${hash} ${info.size} ${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return found;
}

/** Writes a file and sets its modified time. */
async function put(file: string, content: string, mtimeMs: number) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

/**
 * The app's list of chats, written with sqlite3 where there is one, holding a
 * folder for the idle chat and words for the rest of its columns. Where there
 * is none, a file that only begins as a database does.
 */
async function putSummaries(home: string) {
  const file = summariesPath(home);
  if (sqlite === null) {
    await put(file, "SQLite format 3\u0000", NOW - MINUTE);
    return;
  }
  const uris = workspaceUris(FOLDER).replaceAll("'", "''");
  execFileSync(sqlite, [
    file,
    [
      "PRAGMA journal_mode=WAL;",
      "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, workspace_uris TEXT, raw_summary TEXT);",
      `INSERT INTO conversation_summaries VALUES ('${IDLE}', 'Count the files', '${PRIVATE_WORDS}', '${uris}', '${PRIVATE_WORDS}');`,
    ].join(" "),
  ]);
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
}

/** Antigravity 2.0's folder, laid out as the app lays out its own, with the files it keeps beside its chats. */
async function makeAppHome(): Promise<string> {
  const home = path.join(await tempDir(), "antigravity");
  await put(
    transcriptPath(home, WORKING),
    appStep({ index: 0, type: "USER_INPUT", at: NOW - MINUTE }),
    NOW - MINUTE,
  );
  await put(databasePath(home, WORKING), "SQLite format 3\u0000", NOW - 30 * SECOND);
  await put(databasePath(home, WORKING, true), "", NOW - 20 * SECOND);
  await put(transcriptPath(home, IDLE), appTurn(0, NOW - 20 * MINUTE).join(""), NOW - 19 * MINUTE);
  await put(annotationPath(home, IDLE), 'title:"Count the files"\n', NOW - 19 * MINUTE);
  await put(
    transcriptPath(home, FAILED),
    failedTurn(0, NOW - 40 * MINUTE).join(""),
    NOW - 39 * MINUTE,
  );
  await put(transcriptPath(home, OLD), appTurn(0, NOW - 2 * DAY).join(""), NOW - 2 * DAY);
  const logs = path.join(home, "brain", IDLE, ".system_generated");
  await put(path.join(logs, "logs", "transcript_full.jsonl"), "{}\n", NOW);
  await put(path.join(logs, "logs", "chunks", "transcript", "00000000.jsonl"), "{}\n", NOW);
  await put(path.join(logs, "messages", "0.json"), "{}", NOW);
  await put(path.join(logs, "steps", "2", "output.txt"), PRIVATE_WORDS, NOW);
  await put(path.join(home, "agyhub_summaries_proto.pb"), "\u0000", NOW);
  await put(path.join(home, "antigravity_state.pbtxt"), "", NOW);
  await put(path.join(home, "installation_id"), "demo\n", NOW);
  await mkdir(path.join(home, "crashes"), { recursive: true });
  await putSummaries(home);
  return home;
}

function adapterFor(home: string, options: AntigravityAppAdapterOptions = {}) {
  return createAntigravityAppAdapter({
    env: { AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: home },
    homeDir: "/Users/example",
    now: () => NOW,
    platform: process.platform,
    hub: standInHub(true).reader,
    ...options,
  });
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.split(":")[1], session.status]));

describe("the Antigravity adapter, on a folder laid out as Antigravity 2.0 lays it out", () => {
  test("lists each chat of the last day by its last step, with its title and, read with sqlite3, its folder", async () => {
    const home = await makeAppHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({ id: "antigravity-app", state: "ok" });
    expect(statuses(result.sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
    const working = result.sessions.find((session) => session.id.endsWith(WORKING));
    expect(working).toMatchObject({ surface: "desktop", lastWriteAt: NOW - 20 * SECOND });
    // A chat with no reply yet has no counts. One with a reply has that reply's.
    expect(working).not.toHaveProperty("tokens");
    expect(result.sessions.find((session) => session.id.endsWith(IDLE))).toMatchObject({
      name: "Count the files",
      cwd: sqlite === null ? null : FOLDER,
      tokens: { input: 2_000, cached: 800, output: 64 },
    });
  });

  test("leaves every file as it found it, and creates nothing: no database gains a side file", async () => {
    const home = await makeAppHome();
    const before = await snapshotOf(home);
    let at = NOW;
    const adapter = adapterFor(home, { now: () => at });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      at += 2 * SECOND;
    }
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("itself opens only transcripts and titles of the last day, and never a database", async () => {
    const home = await makeAppHome();
    const { io, calls } = recordingIo();
    await adapterFor(home, { io }).poll();
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(
      opened.every((file) => file.endsWith("transcript.jsonl") || file.endsWith(".pbtxt")),
    ).toBe(true);
    expect(opened.filter((file) => file.endsWith("transcript.jsonl")).sort()).toEqual(
      [WORKING, IDLE, FAILED].map((id) => path.normalize(transcriptPath(home, id))).sort(),
    );
    const summaries = { method: "lstat", path: path.normalize(summariesPath(home)) };
    // sqlite3 is never run on Windows, so the folders file is not looked at there.
    if (process.platform === "win32") expect(calls).not.toContainEqual(summaries);
    else expect(calls).toContainEqual(summaries);
    for (const call of calls) {
      expect(call.path).not.toMatch(
        /transcript_full|chunks|messages|steps|agyhub|antigravity_state|installation_id/,
      );
    }
  });

  test("a transcript that is a link is not read", async () => {
    const home = await makeAppHome();
    const outside = path.join(await tempDir(), "transcript.jsonl");
    await writeFile(outside, appTurn(0, NOW - MINUTE).join(""));
    const linked = conversationId("e5");
    await mkdir(path.dirname(transcriptPath(home, linked)), { recursive: true });
    await symlink(outside, transcriptPath(home, linked));
    const { io, calls } = recordingIo();
    const { sessions } = await adapterFor(home, { io }).poll();
    expect(sessions.map((session) => session.id)).not.toContain(`antigravity-app:${linked}`);
    expect(
      calls.filter((call) => call.method === "openRegular").map((call) => call.path),
    ).not.toContain(path.normalize(transcriptPath(home, linked)));
  });
});

describe("finding Antigravity 2.0's folder", () => {
  test("with no ~/.gemini/antigravity, it is not found, and nothing is run", async () => {
    const userHome = await tempDir();
    const hub = standInHub();
    const result = await createAntigravityAppAdapter({
      env: {},
      homeDir: userHome,
      now: () => NOW,
      hub: hub.reader,
    }).poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail:
        "Antigravity was not found: there is no ~/.gemini/antigravity folder. Agent Lookout looks again every minute.",
    });
    expect(hub.asked()).toBe(0);
  });

  test("~/.gemini/antigravity is read when nothing names another folder, and the CLI's beside it is not", async () => {
    const userHome = await tempDir();
    const home = path.join(userHome, ".gemini", "antigravity");
    await put(transcriptPath(home, IDLE), appTurn(0, NOW - MINUTE).join(""), NOW - MINUTE);
    const cli = path.join(userHome, ".gemini", "antigravity-cli");
    await put(transcriptPath(cli, WORKING), appTurn(0, NOW - MINUTE).join(""), NOW - MINUTE);
    const { io, calls } = recordingIo();
    const result = await createAntigravityAppAdapter({
      env: {},
      homeDir: userHome,
      now: () => NOW,
      io,
      hub: standInHub(false).reader,
    }).poll();
    expect(result.health.detail).toContain("~/.gemini/antigravity/brain");
    expect(statuses(result.sessions)).toEqual({ [IDLE]: "finished" });
    expect(calls.filter((call) => call.path.startsWith(cli))).toEqual([]);
  });

  test("an AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME with nothing in it is watched and empty, and left so", async () => {
    const empty = await tempDir();
    const result = await adapterFor(empty).poll();
    expect(result.health.state).toBe("ok");
    expect(result.sessions).toEqual([]);
    expect(await readdir(empty)).toEqual([]);
  });
});

describe("what a chat last said, read from the real files", () => {
  const SAID = conversationId("f6");

  /** A chat whose newest reply the transcript cut, with the whole of it in transcript_full.jsonl beside it. */
  async function cutReply(home: string) {
    const kept = `${"Kept start. ".repeat(150)}`;
    await put(
      transcriptPath(home, SAID),
      [
        textStep(0, "USER_INPUT", NOW - 2 * MINUTE, `Prompt: ${PRIVATE_WORDS}`),
        replyStep({ index: 1, at: NOW - 90 * SECOND, content: "An older reply." }),
        replyStep({
          index: 2,
          at: NOW - MINUTE,
          content: kept,
          truncated: ["content"],
          counts: { input_tokens: 512, cache_read_tokens: 1_024, output_tokens: 66 },
        }),
        replyStep({ index: 3, at: NOW - 50 * SECOND, tools: ["run_command"] }),
        textStep(4, "GENERIC", NOW - 40 * SECOND, `Output: ${PRIVATE_WORDS}`),
      ].join(""),
      NOW - 40 * SECOND,
    );
    await put(
      path.join(path.dirname(transcriptPath(home, SAID)), "transcript_full.jsonl"),
      replyStep({ index: 2, at: NOW - MINUTE, content: `${kept} FULL-TRANSCRIPT-ONLY` }),
      NOW - 40 * SECOND,
    );
    return kept;
  }

  test("is the start of a reply its transcript cut, never the whole one beside it, and only once asked", async () => {
    const home = await makeAppHome();
    const kept = await cutReply(home);
    const { io, calls } = recordingIo();
    const adapter = adapterFor(home, {
      io,
      env: {
        AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: home,
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      },
    });
    await adapter.poll();
    const polled = calls.length;

    const answer = await adapter.lastMessage(`antigravity-app:${SAID}`);
    if (answer === null || answer === "busy" || answer.message === null) {
      throw new Error("A message was expected.");
    }
    expect(answer.message.cut).toBe(false);
    expect(answer.message.endCut).toBe(true);
    expect(kept.startsWith(answer.message.text)).toBe(true);
    expect(answer).not.toHaveProperty("tokens");
    const said = JSON.stringify(answer);
    for (const words of [
      PRIVATE_WORDS,
      "FULL-TRANSCRIPT-ONLY",
      "PRIVATE-THINKING",
      "PRIVATE-TOOL-CALL",
      "PRIVATE-MEDIA",
    ]) {
      expect(said).not.toContain(words);
    }
    // The ask opened only that chat's transcript, at the path the poll used.
    expect(calls.slice(polled)).toEqual([
      { method: "openRegular", path: path.normalize(transcriptPath(home, SAID)) },
    ]);
    for (const call of calls) expect(call.path).not.toMatch(/transcript_full/);
  });
});
