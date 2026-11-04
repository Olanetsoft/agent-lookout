import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createGeminiCliAdapter, subagentsUnreadNote } from "@collector/adapters/gemini-cli/index";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  chatFile,
  chatName,
  DAY,
  geminiLine,
  headerLine,
  HOME,
  HOUR,
  ids,
  messageIdOf,
  MINUTE,
  MODEL,
  NOW,
  PRIVATE_WORDS,
  PROJECT,
  SECOND,
  sessionIdOf,
  SLUG,
  updatedLine,
  userLine,
  workingSession,
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
    realpath: (target) => (calls.push({ method: "realpath", path: target }), realpath(target)),
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

/** Sets a file's modified time. */
const writeTime = (file: string, ms: number) => utimes(file, new Date(ms), new Date(ms));

function adapterFor(home: string, io: ReadOnlyIo = nodeIo, now = () => NOW) {
  return createGeminiCliAdapter({
    env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: home },
    homeDir: HOME,
    now,
    io,
  });
}

describe("the Gemini CLI adapter, on a folder laid out as Gemini CLI lays it out", () => {
  test("lists the working and the idle session, with their names, folder and token counts, and nothing private", async () => {
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
        // Its reply's prompt and cached part, and its output with its 40 tokens of thoughts.
        tokens: { input: 1200, cached: 600, output: 120 },
      }),
    ]);
    // The working session has no reply yet.
    expect(sessions[0]).not.toHaveProperty("tokens");
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
    expect(JSON.stringify(result)).not.toContain(MODEL);
  });

  test("opens only each project's .project_root and session files, and lists only tmp/, chats/ and a listed session's subagent folder", async () => {
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
    const subagents = path.join(chats, ids.working);
    expect(listed.sort()).toEqual([path.join(home, "tmp"), chats, subagents].sort());

    // Looked at, and never opened: the session file of the format before 0.39.
    const older = path.join(chats, "session-2026-09-20T08-00-00000000.json");
    expect(calls.filter((call) => call.path === older)).toEqual([{ method: "lstat", path: older }]);
    // Looked at, and never opened: the subagent's file of the session that is working.
    const agent = path.join(subagents, "agent-0001.jsonl");
    expect(calls.filter((call) => call.path === agent)).toEqual([{ method: "lstat", path: agent }]);
    expect(calls.filter((call) => call.path === path.join(chats, ids.idle))).toEqual([
      { method: "lstat", path: path.join(chats, ids.idle) },
    ]);
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

describe("a subagent's writes, from the real files", () => {
  const AGENT = "11111111-1111-4111-8111-111111111111";
  const session = sessionIdOf("61");
  const NEVER_OPENED = "placeholder: must never be opened\n";

  /** A temporary home with one working session, whose own file was last written ten minutes ago. */
  async function homeWithSession() {
    const home = await tempDir();
    const project = path.join(home, "tmp", SLUG);
    const chats = path.join(project, "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(path.join(project, ".project_root"), `${PROJECT}\n`);
    const file = path.join(chats, chatName(NOW - 30 * MINUTE, session));
    await writeFile(file, workingSession(session, NOW - 30 * MINUTE));
    await writeTime(file, NOW - 10 * MINUTE);
    return { home, chats, subagents: path.join(chats, session) };
  }

  /** Writes a subagent's file with this modified time. */
  async function writeAgent(subagents: string, name: string, writtenAt: number) {
    await mkdir(subagents, { recursive: true });
    const file = path.join(subagents, name);
    await writeFile(file, NEVER_OPENED);
    await writeTime(file, writtenAt);
    return file;
  }

  const lastWrite = async (home: string, io: ReadOnlyIo = nodeIo) => {
    const { sessions } = await adapterFor(home, io).poll();
    expect(sessions).toHaveLength(1);
    return sessions[0]?.lastWriteAt;
  };

  test("a subagent newer than the session's file gives its last write", async () => {
    const { home, subagents } = await homeWithSession();
    await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 5 * SECOND);
    expect(await lastWrite(home)).toBe(NOW - 5 * SECOND);
  });

  test("a subagent older than the session's file does not", async () => {
    const { home, subagents } = await homeWithSession();
    await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 20 * MINUTE);
    expect(await lastWrite(home)).toBe(NOW - 10 * MINUTE);
  });

  test("with no subagent, it is the session's file", async () => {
    const { home } = await homeWithSession();
    expect(await lastWrite(home)).toBe(NOW - 10 * MINUTE);
  });

  test("a link in the folder is not followed, however new what it points to", async () => {
    const { home, subagents } = await homeWithSession();
    const outside = path.join(await tempDir(), "elsewhere.jsonl");
    await writeFile(outside, NEVER_OPENED);
    await writeTime(outside, NOW - 5 * SECOND);
    await mkdir(subagents);
    await symlink(outside, path.join(subagents, `${AGENT}.jsonl`));
    const { io, calls } = recordingIo();
    expect(await lastWrite(home, io)).toBe(NOW - 10 * MINUTE);
    expect(calls.filter((call) => call.path === outside)).toEqual([]);
  });

  // Windows makes a link to a folder only with rights a test does not have.
  test.skipIf(process.platform === "win32")(
    "a link in the folder's place is not followed",
    async () => {
      const { home, subagents } = await homeWithSession();
      const outside = await tempDir();
      await writeAgent(outside, `${AGENT}.jsonl`, NOW - 5 * SECOND);
      await symlink(outside, subagents);
      const { io, calls } = recordingIo();
      expect(await lastWrite(home, io)).toBe(NOW - 10 * MINUTE);
      expect(calls.filter((call) => call.method === "readdir" && call.path === subagents)).toEqual(
        [],
      );
    },
  );

  test("the folder of a session not listed is not looked at", async () => {
    const { home, chats, subagents } = await homeWithSession();
    await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 5 * SECOND);
    const older = sessionIdOf("62");
    const file = path.join(chats, chatName(NOW - 3 * DAY, older));
    await writeFile(file, workingSession(older, NOW - 3 * DAY));
    await writeTime(file, NOW - 2 * DAY);
    const otherFolder = path.join(chats, older);
    await writeAgent(otherFolder, `${AGENT}.jsonl`, NOW - 5 * SECOND);
    const { io, calls } = recordingIo();
    await lastWrite(home, io);
    expect(calls.filter((call) => call.path.startsWith(otherFolder))).toEqual([]);
  });

  // Windows keeps no such modes, and the root user is refused nothing.
  const withModes = test.runIf(process.platform !== "win32" && process.getuid?.() !== 0);

  withModes(
    "a folder the system will not let it look in is said on the card, and clears once it can",
    async () => {
      const { home, subagents } = await homeWithSession();
      await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 5 * SECOND);
      const clock = handClock(NOW);
      const adapter = adapterFor(home, nodeIo, clock.now);
      const healthy = await adapter.poll();
      expect(healthy.sessions[0]?.lastWriteAt).toBe(NOW - 5 * SECOND);
      const note = subagentsUnreadNote({ refused: 1, failed: 0 });

      try {
        // It can be listed, and no file in it looked at.
        await chmod(subagents, 0o600);
        clock.advance(2 * SECOND);
        const noFile = await adapter.poll();
        expect(noFile.health).toMatchObject({
          state: "ok",
          detail: `${healthy.health.detail} ${note}`,
        });
        expect(noFile.sessions).toEqual(healthy.sessions);

        // It cannot be listed, which a listing finds.
        await chmod(subagents, 0o000);
        clock.advance(31 * SECOND);
        const noListing = await adapter.poll();
        expect(noListing.health).toMatchObject({
          state: "ok",
          detail: `${healthy.health.detail} ${note}`,
        });
        expect(noListing.sessions[0]?.lastWriteAt).toBe(NOW - 5 * SECOND);
      } finally {
        await chmod(subagents, 0o700);
      }

      clock.advance(2 * SECOND);
      const back = await adapter.poll();
      expect(back.health.detail).toBe(healthy.health.detail);
      expect(back.sessions[0]?.lastWriteAt).toBe(NOW - 5 * SECOND);
    },
  );

  withModes(
    "a folder of more files than are looked at between listings keeps its last write past a listing that can look at none",
    async () => {
      const { home, subagents } = await homeWithSession();
      for (let number = 1; number <= 19; number += 1) {
        const name = `agent-${String(number).padStart(4, "0")}.jsonl`;
        await writeAgent(subagents, name, NOW - 3 * HOUR);
      }
      // It sorts last, and led at the listing before.
      await writeAgent(subagents, "agent-9999.jsonl", NOW - 5 * SECOND);
      const clock = handClock(NOW);
      const adapter = adapterFor(home, nodeIo, clock.now);
      const healthy = await adapter.poll();
      const leading = NOW - 5 * SECOND;
      expect(healthy.sessions[0]?.lastWriteAt).toBe(leading);

      try {
        await chmod(subagents, 0o600);
        clock.advance(32 * SECOND);
        const noFile = await adapter.poll();
        expect(noFile.health.detail).toContain("permission was refused for 1 session.");
        expect(noFile.sessions[0]?.lastWriteAt).toBe(leading);
      } finally {
        await chmod(subagents, 0o700);
      }

      for (let poll = 0; poll < 2; poll += 1) {
        clock.advance(2 * SECOND);
        const back = await adapter.poll();
        expect(back.health.detail).toBe(healthy.health.detail);
        expect(back.sessions[0]?.lastWriteAt).toBe(leading);
      }
    },
  );

  withModes(
    "a folder it can look in and not list moves on with the files it knows, and stays said on the card",
    async () => {
      const { home, subagents } = await homeWithSession();
      const agent = await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 5 * SECOND);
      const clock = handClock(NOW);
      const adapter = adapterFor(home, nodeIo, clock.now);
      const healthy = await adapter.poll();
      const note = subagentsUnreadNote({ refused: 1, failed: 0 });

      try {
        await chmod(subagents, 0o311);
        clock.advance(30 * SECOND);
        for (let poll = 0; poll < 2; poll += 1) {
          clock.advance(2 * SECOND);
          const writtenAt = clock.now() - SECOND;
          await writeTime(agent, writtenAt);
          const { health, sessions } = await adapter.poll();
          expect(health.detail).toBe(`${healthy.health.detail} ${note}`);
          expect(sessions[0]?.lastWriteAt).toBe(writtenAt);
        }
      } finally {
        await chmod(subagents, 0o700);
      }

      clock.advance(2 * SECOND);
      expect((await adapter.poll()).health.detail).toBe(healthy.health.detail);
    },
  );

  test("no subagent's file is opened, or changed, and only the session is listed", async () => {
    const { home, subagents } = await homeWithSession();
    const agent = await writeAgent(subagents, `${AGENT}.jsonl`, NOW - 5 * SECOND);
    const before = await snapshotOf(home);
    const { io, calls } = recordingIo();
    const clock = handClock(NOW);
    const adapter = adapterFor(home, io, clock.now);
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await adapter.poll()).sessions.map(({ id }) => id)).toEqual([
        geminiCliSessionId(SLUG, session),
      ]);
      clock.advance(2 * SECOND);
    }
    expect(new Set(calls.filter((call) => call.path === agent).map((call) => call.method))).toEqual(
      new Set(["lstat"]),
    );
    expect(calls.filter((call) => call.method === "openRegular" && call.path === agent)).toEqual(
      [],
    );
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("works for a session in the folder Gemini CLI keeps under macOS Seatbelt", async () => {
    const realHome = await tempDir();
    const project = path.join(realHome, ".cache", ".gemini", "tmp", SLUG);
    const chats = path.join(project, "chats");
    await mkdir(chats, { recursive: true });
    await writeFile(path.join(project, ".project_root"), `${PROJECT}\n`);
    const file = path.join(chats, chatName(NOW - 30 * MINUTE, session));
    await writeFile(file, workingSession(session, NOW - 30 * MINUTE));
    await writeTime(file, NOW - 10 * MINUTE);
    await writeAgent(path.join(chats, session), `${AGENT}.jsonl`, NOW - 5 * SECOND);
    const adapter = createGeminiCliAdapter({
      env: {},
      homeDir: realHome,
      now: () => NOW,
      platform: "darwin",
    });
    const { sessions } = await adapter.poll();
    expect(sessions.map(({ id, lastWriteAt }) => ({ id, lastWriteAt }))).toEqual([
      { id: geminiCliSessionId(SLUG, session, true), lastWriteAt: NOW - 5 * SECOND },
    ]);
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

describe("the folder Gemini CLI keeps under macOS Seatbelt, read from the real files", () => {
  const homeSession = sessionIdOf("41");
  const seatbeltSession = sessionIdOf("42");

  /** A session file whose newest reply says this. */
  const replying = (sessionId: string, says: string) =>
    chatFile([
      headerLine({ sessionId, startTime: NOW - 10 * MINUTE }),
      userLine(messageIdOf("43"), NOW - 2 * MINUTE),
      geminiLine(messageIdOf("44"), NOW - MINUTE, { content: says }),
      updatedLine(NOW - MINUTE),
    ]);

  /**
   * A home folder of its own with a session in `.gemini/tmp` and one in
   * `.cache/.gemini/tmp`, each in a project folder of the same name, and a log
   * beside the Seatbelt folder's chats that is never opened.
   */
  async function homeWithBoth() {
    const home = await tempDir();
    const files: Record<"home" | "seatbelt" | "log", string> = { home: "", seatbelt: "", log: "" };
    for (const [where, sessionId, says] of [
      ["home", homeSession, "A reply in its own folder."],
      ["seatbelt", seatbeltSession, "A reply under Seatbelt."],
    ] as const) {
      const gemini =
        where === "home" ? path.join(home, ".gemini") : path.join(home, ".cache", ".gemini");
      const project = path.join(gemini, "tmp", SLUG);
      await mkdir(path.join(project, "chats"), { recursive: true });
      await writeFile(path.join(project, ".project_root"), PROJECT);
      files[where] = path.join(project, "chats", chatName(NOW - 10 * MINUTE, sessionId));
      await writeFile(files[where], replying(sessionId, says));
      if (where === "seatbelt") {
        files.log = path.join(project, "logs.json");
        await writeFile(files.log, JSON.stringify([{ message: PRIVATE_WORDS }]));
      }
    }
    return { home, files };
  }

  function adapterIn(home: string, io: ReadOnlyIo, platform: NodeJS.Platform = "darwin") {
    return createGeminiCliAdapter({ env: {}, homeDir: home, now: () => NOW, io, platform });
  }

  test("on a Mac, lists the sessions in both with no setting, with ids that differ, and changes nothing", async () => {
    const { home, files } = await homeWithBoth();
    const before = await snapshotOf(home);
    const { io, calls } = recordingIo();
    const result = await adapterIn(home, io).poll();
    expect(result.health).toMatchObject({ state: "ok" });
    expect(result.health.watching).toContainEqual({
      label: "Seatbelt sessions folder",
      value: "~/.cache/.gemini/tmp",
    });
    const ids = result.sessions.map((session) => session.id).sort();
    expect(ids).toEqual(
      [
        geminiCliSessionId(SLUG, homeSession),
        geminiCliSessionId(SLUG, seatbeltSession, true),
      ].sort(),
    );
    expect(geminiCliSessionId(SLUG, seatbeltSession, true)).toBe(
      `${geminiCliSessionId(SLUG, seatbeltSession)}.seatbelt`,
    );
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [
        path.join(path.dirname(path.dirname(files.home)), ".project_root"),
        files.home,
        path.join(path.dirname(path.dirname(files.seatbelt)), ".project_root"),
        files.seatbelt,
      ].sort(),
    );
    expect(calls.filter((call) => call.path === files.log)).toEqual([]);
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("what a session in ~/.cache/.gemini last said is read from its own file, and from no other", async () => {
    const { home, files } = await homeWithBoth();
    const { io, calls } = recordingIo();
    const adapter = adapterIn(home, io);
    await adapter.poll();
    calls.length = 0;
    await expect(
      adapter.lastMessage(geminiCliSessionId(SLUG, seatbeltSession, true)),
    ).resolves.toEqual({
      message: { text: "A reply under Seatbelt.", cut: false },
    });
    expect(calls.filter((call) => call.method === "openRegular").map((call) => call.path)).toEqual([
      path.normalize(files.seatbelt),
    ]);
  });

  test("on Linux, only ~/.gemini is read", async () => {
    const { home } = await homeWithBoth();
    const { io, calls } = recordingIo();
    const result = await adapterIn(home, io, "linux").poll();
    expect(result.sessions.map((session) => session.id)).toEqual([
      geminiCliSessionId(SLUG, homeSession),
    ]);
    expect(calls.filter((call) => call.path.startsWith(path.join(home, ".cache")))).toEqual([]);
  });

  // Windows makes a link to a folder only with rights a test does not have.
  test.skipIf(process.platform === "win32")(
    "~/.cache/.gemini made a link to ~/.gemini is read once, as Gemini CLI's own",
    async () => {
      const home = await tempDir();
      const project = path.join(home, ".gemini", "tmp", SLUG);
      await mkdir(path.join(project, "chats"), { recursive: true });
      await writeFile(path.join(project, ".project_root"), PROJECT);
      await writeFile(
        path.join(project, "chats", chatName(NOW - 10 * MINUTE, homeSession)),
        replying(homeSession, "A reply in its own folder."),
      );
      await mkdir(path.join(home, ".cache"));
      await symlink(path.join(home, ".gemini"), path.join(home, ".cache", ".gemini"));
      const result = await adapterIn(home, nodeIo).poll();
      expect(result.sessions.map((session) => session.id)).toEqual([
        geminiCliSessionId(SLUG, homeSession),
      ]);
    },
  );
});
