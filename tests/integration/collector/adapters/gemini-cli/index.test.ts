import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createGeminiCliAdapter } from "@collector/adapters/gemini-cli/index";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  chatFile,
  chatName,
  geminiLine,
  headerLine,
  HOME,
  ids,
  messageIdOf,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  PROJECT,
  SECOND,
  sessionIdOf,
  SLUG,
  updatedLine,
  userLine,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { handClock } from "@tests/support/adapters/geminiCliAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

/** The fixture folder laid out as Gemini CLI lays out its own. Tests read it, and change only a copy. */
const FIXTURE_HOME = fileURLToPath(
  new URL("../../../../fixtures/gemini-cli/home", import.meta.url),
);

/** A copy of the fixture folder, with a `.env` beside it: git keeps no such file in the fixture. */
async function copyOfHome(): Promise<string> {
  const home = await tempDir();
  await cp(FIXTURE_HOME, home, { recursive: true });
  await writeFile(path.join(home, ".env"), "placeholder: must never be opened\n");
  return home;
}

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

/**
 * Everything under a folder: each ordinary file's hash, size and modified time,
 * each link's target and each other thing's kind.
 */
async function snapshotOf(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const target = path.join(dir, name);
      const relative = path.relative(root, target);
      const info = await lstat(target);
      if (info.isDirectory()) {
        found[relative] = `folder ${info.mtimeMs}`;
        await walk(target);
      } else if (info.isSymbolicLink()) {
        found[relative] = `link to ${await readlink(target)}`;
      } else if (info.isFile()) {
        const hash = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        found[relative] = `${hash} ${info.size} ${info.mtimeMs}`;
      } else {
        found[relative] = `other ${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return found;
}

function adapterFor(home: string, io: ReadOnlyIo = nodeIo, now = () => NOW) {
  return createGeminiCliAdapter({
    env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: home },
    homeDir: HOME,
    now,
    io,
  });
}

describe("the Gemini CLI adapter, on a folder laid out as Gemini CLI lays it out", () => {
  test("lists the working and the idle session, with their names and folder, and nothing private", async () => {
    const home = await copyOfHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({ id: "gemini-cli", state: "ok" });
    const sessions = [...result.sessions].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sessions).toEqual([
      expect.objectContaining({
        id: geminiCliSessionId("demo-project", ids.working),
        name: "demo-project",
        cwd: PROJECT,
        status: "working",
      }),
      expect.objectContaining({
        id: geminiCliSessionId("demo-project", ids.idle),
        name: "Tidy the demo readme",
        cwd: PROJECT,
        status: "idle",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
  });

  test("opens only each project's .project_root and session files, and lists only tmp/ and chats/", async () => {
    const home = await copyOfHome();
    const { io, calls } = recordingIo();
    const clock = handClock(NOW);
    const adapter = adapterFor(home, io, clock.now);
    await adapter.poll();

    const project = path.join(home, "tmp", "demo-project");
    const chats = path.join(project, "chats");
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [
        path.join(project, ".project_root"),
        path.join(chats, "session-2026-10-01T11-30-00000000.jsonl"),
        path.join(chats, "session-2026-10-01T11-50-00000000.jsonl"),
      ].sort(),
    );
    const listed = calls.filter((call) => call.method === "readdir").map((call) => call.path);
    expect(listed.sort()).toEqual([path.join(home, "tmp"), chats].sort());

    // Looked at, and never opened: the session file of the format before 0.39.
    const older = path.join(chats, "session-2026-09-20T08-00-00000000.json");
    expect(calls.filter((call) => call.path === older)).toEqual([{ method: "lstat", path: older }]);
    // Gemini CLI's own folders are looked at for a .project_root alone, and passed over.
    for (const own of ["bin", "background-processes"]) {
      const dir = path.join(home, "tmp", own);
      expect(
        calls.filter((call) => call.path.startsWith(dir)),
        own,
      ).toEqual([
        { method: "lstat", path: dir },
        { method: "lstat", path: path.join(dir, ".project_root") },
      ]);
    }
    for (const never of [
      ".env",
      "oauth_creds.json",
      "google_accounts.json",
      "settings.json",
      "installation_id",
      "mcp-oauth-tokens.json",
      "a2a-oauth-tokens.json",
      "gemini-credentials.json",
      "trustedFolders.json",
      "projects.json",
      `${path.sep}history`,
      "logs.json",
      "shell_history",
      "checkpoint",
      "tool-outputs",
      `${path.sep}logs${path.sep}`,
      `${path.sep}memory`,
      ".tmp-123",
      // The subagent's folder of the working session.
      path.join(chats, ids.working),
      "antigravity",
    ]) {
      expect(
        calls.filter((call) => call.path.includes(never)),
        never,
      ).toEqual([]);
    }

    // A poll where nothing changed opens nothing.
    calls.length = 0;
    clock.advance(2_000);
    await adapter.poll();
    expect(calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const home = await copyOfHome();
    const before = await snapshotOf(home);
    const clock = handClock(NOW);
    const adapter = adapterFor(home, nodeIo, clock.now);
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("reads what Gemini CLI adds to a session file as it is added", async () => {
    const home = await copyOfHome();
    const clock = handClock(NOW);
    const adapter = adapterFor(home, nodeIo, clock.now);
    const working = () => geminiCliSessionId("demo-project", ids.working);
    const first = await adapter.poll();
    expect(first.sessions.find((session) => session.id === working())?.status).toBe("working");

    const file = path.join(
      home,
      "tmp",
      "demo-project",
      "chats",
      "session-2026-10-01T11-50-00000000.jsonl",
    );
    await appendFile(file, `${geminiLine(messageIdOf("02"), NOW)}\n${updatedLine(NOW)}\n`);
    clock.advance(2_000);
    const next = await adapter.poll();
    expect(next.sessions.find((session) => session.id === working())).toMatchObject({
      status: "idle",
      statusSince: NOW,
    });
  });
});

describe("what a session last said, read from the real files", () => {
  /** A session file whose newest reply says this, written as Gemini CLI writes one. */
  const sessionLines = (sessionId: string, says: string) =>
    chatFile([
      headerLine({ sessionId, startTime: NOW - 10 * MINUTE }),
      userLine(messageIdOf("91"), NOW - 2 * MINUTE),
      geminiLine(messageIdOf("92"), NOW - MINUTE, { content: says }),
      updatedLine(NOW - MINUTE),
    ]);

  /**
   * A session listed by a poll, with another session's file, a subagent's file
   * of its own and a log beside it, and a clock the test moves.
   */
  async function listedSession() {
    const home = await tempDir();
    const id = sessionIdOf("21");
    const project = path.join(home, "tmp", SLUG);
    const chats = path.join(project, "chats");
    await mkdir(path.join(chats, id), { recursive: true });
    await writeFile(path.join(project, ".project_root"), PROJECT);
    const file = path.join(chats, chatName(NOW - 10 * MINUTE, id));
    await writeFile(file, sessionLines(id, "A reply of its own."));
    // Another session's file, which that session's ask alone may open.
    const other = path.join(chats, chatName(NOW - 5 * MINUTE, sessionIdOf("22")));
    await writeFile(other, sessionLines(sessionIdOf("22"), PRIVATE_WORDS));
    // A subagent's file of the session, and the project's log, which are never opened.
    const subagent = path.join(chats, id, "agent-0001.jsonl");
    await writeFile(
      subagent,
      chatFile([
        headerLine({ sessionId: "agent-0001", kind: "subagent" }),
        geminiLine(messageIdOf("93"), NOW, { content: PRIVATE_WORDS }),
      ]),
    );
    const log = path.join(project, "logs.json");
    await writeFile(log, JSON.stringify([{ message: PRIVATE_WORDS }]));
    let at = NOW;
    const { io, calls } = recordingIo();
    const adapter = createGeminiCliAdapter({
      env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: home },
      homeDir: HOME,
      now: () => at,
      io,
    });
    const { sessions } = await adapter.poll();
    const said = geminiCliSessionId(SLUG, id);
    expect(sessions.map((session) => session.id)).toContain(said);
    return {
      file,
      never: [other, subagent, log],
      calls,
      ask: () => adapter.lastMessage(said),
      later: () => (at += SECOND),
    };
  }

  test("is the newest reply's text, read from the session's own file when asked, and from no other file", async () => {
    const { file, never, calls, ask } = await listedSession();
    calls.length = 0;
    const answer = await ask();
    expect(answer).toEqual({ message: { text: "A reply of its own.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORDS);
    // The adapter joins its paths as the system does, so on Windows with its own separator.
    expect(calls.filter((call) => call.method === "openRegular").map((call) => call.path)).toEqual([
      path.normalize(file),
    ]);
    for (const target of never) expect(calls.filter((call) => call.path === target)).toEqual([]);
  });

  test("is unreadable once a link is put in its file's place after the poll listed it, and is never read through", async () => {
    const elsewhere = path.join(await tempDir(), "elsewhere.jsonl");
    await writeFile(elsewhere, sessionLines(sessionIdOf("21"), "PRIVATE-ELSEWHERE reply"));
    const { file, calls, ask, later } = await listedSession();

    // Put there before the first ask.
    await rm(file);
    await symlink(elsewhere, file);
    const linked = await ask();
    expect(linked).toEqual({ message: null, reason: "unreadable" });

    // Read as a file, then a link put in its place.
    await rm(file);
    await writeFile(file, sessionLines(sessionIdOf("21"), "A reply of its own."));
    later();
    await expect(ask()).resolves.toEqual({ message: { text: "A reply of its own.", cut: false } });
    await rm(file);
    await symlink(elsewhere, file);
    later();
    const swapped = await ask();
    expect(swapped).toEqual({ message: null, reason: "unreadable" });
    expect(JSON.stringify([linked, swapped])).not.toContain("PRIVATE-ELSEWHERE");
    expect(calls.filter((call) => call.path === elsewhere)).toEqual([]);
  });

  // Windows keeps no named pipes among files.
  test.skipIf(process.platform === "win32")(
    "is unreadable once a named pipe is put in its file's place after the poll listed it, and does not wait on it",
    async () => {
      const { file, ask, later } = await listedSession();
      const started = Date.now();

      // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
      await rm(file);
      execFileSync("mkfifo", [file]);
      await expect(ask()).resolves.toEqual({ message: null, reason: "unreadable" });

      await rm(file);
      await writeFile(file, sessionLines(sessionIdOf("21"), "A reply of its own."));
      later();
      await expect(ask()).resolves.toEqual({
        message: { text: "A reply of its own.", cut: false },
      });
      await rm(file);
      execFileSync("mkfifo", [file]);
      later();
      await expect(ask()).resolves.toEqual({ message: null, reason: "unreadable" });
      expect(Date.now() - started).toBeLessThan(3_000);
    },
    8_000,
  );
});
