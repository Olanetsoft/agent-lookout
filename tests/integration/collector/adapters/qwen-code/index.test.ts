import { execFileSync, spawnSync } from "node:child_process";
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
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test, vi } from "vitest";

import {
  createQwenCodeAdapter,
  type QwenCodeAdapterOptions,
} from "@collector/adapters/qwen-code/index";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import { createPidNamespaceRead } from "@collector/processes/linuxProcesses";
import {
  assistantLine,
  chatPath,
  fixture,
  HOME,
  lifecycleLine,
  MINUTE,
  NEVER_OPENED,
  NOW,
  PLACEHOLDER,
  PRIVATE_TOKEN,
  PRIVATE_WORDS,
  PROJECT,
  PID_NAMESPACE,
  PROJECT_FOLDER,
  promptLine,
  registeredAt,
  registryRecord,
  RUNNING_PIDS,
  SECOND,
  sessionIdOf,
  startToken,
  toolResultLine,
} from "@tests/fixtures/qwen-code/qwenCode";
import {
  handClock,
  healthy,
  standInStarts,
  standInTokens,
} from "@tests/support/adapters/qwenCodeAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

/** `tests/fixtures/qwen-code/home`, laid out as Qwen Code lays out its own folder. Never written in. */
const FIXTURE_HOME = fileURLToPath(new URL("../../../../fixtures/qwen-code/home", import.meta.url));

const CHATS = path.join("projects", PROJECT_FOLDER, "chats");

/** When the fixture's chat files were last written, set on each copy. */
const WRITTEN = {
  working: NOW - 28 * MINUTE,
  idle: NOW - 118 * MINUTE,
  headless: NOW - 19 * MINUTE,
  crashed: NOW - 170 * MINUTE,
} as const;

/**
 * A copy of the fixture folder that a test may change, with a `.env` beside
 * the others git keeps no copy of, and each chat file's modified time set.
 */
async function makeQwenHome(): Promise<string> {
  const home = await tempDir();
  await cp(FIXTURE_HOME, home, { recursive: true });
  await writeFile(path.join(home, ".env"), `QWEN_RUNTIME_DIR=/tmp/${PRIVATE_TOKEN}\n`);
  for (const [name, time] of Object.entries(WRITTEN)) {
    const { sessionId } = fixture[name as keyof typeof WRITTEN];
    await utimes(path.join(home, CHATS, `${sessionId}.jsonl`), time / 1000, time / 1000);
  }
  return home;
}

/**
 * An adapter pointed at this folder, with the clock at the fixture's `NOW` and
 * its processes stood in for, a `ps` among them that knows no start time, so
 * no process of this machine that has a fixture's pid is asked about.
 */
function adapterFor(home: string, options: QwenCodeAdapterOptions = {}) {
  return createQwenCodeAdapter({
    env: { AGENT_LOOKOUT_QWEN_HOME: home },
    homeDir: HOME,
    now: () => NOW,
    isAlive: (pid) => RUNNING_PIDS.has(pid),
    platform: "darwin",
    readProcessStarts: async () => new Map(),
    ...options,
  });
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
 * Everything under a folder: each ordinary file's hash, size and modified
 * time, each link's target and each other thing's kind. Nothing but ordinary
 * files is opened, so a pipe cannot hold it up.
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

describe("the Qwen Code adapter, on a folder laid out as Qwen Code lays it out", () => {
  test("lists each terminal session with its status, name, folder and token counts, and a crash's leftover as finished", async () => {
    const home = await makeQwenHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({
      id: "qwen-code",
      state: "ok",
      detail: healthy(path.join(home, "sessions"), path.join(home, "projects")),
    });
    expect(result.basis).toBe("files");
    const common = { source: "qwen-code", surface: "terminal", links: {}, stale: false };
    expect(result.sessions).toEqual([
      {
        ...common,
        id: `qwen-code:${fixture.working.sessionId}`,
        name: "Fix the flaky test",
        cwd: PROJECT,
        project: "demo-project",
        status: "working",
        startedAt: Date.UTC(2026, 9, 1, 11, 31),
        statusSince: Date.UTC(2026, 9, 1, 11, 31),
        lastWriteAt: WRITTEN.working,
        // Counted as Qwen Code writes them for Gemini's own API: 1,300 in all, less the prompt.
        tokens: { input: 1200, cached: 600, output: 100 },
        pid: fixture.working.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.idle.sessionId}`,
        name: "Tidy the release notes",
        cwd: PROJECT,
        project: "demo-project",
        status: "idle",
        startedAt: Date.UTC(2026, 9, 1, 10, 1),
        statusSince: Date.UTC(2026, 9, 1, 10, 2, 0, 1),
        lastWriteAt: WRITTEN.idle,
        // The newest of its two replies, counted as Qwen Code writes them for an
        // OpenAI-compatible provider, whose candidates already count the reasoning.
        tokens: { input: 2400, cached: 1800, output: 150 },
        pid: fixture.idle.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.fresh.sessionId}`,
        name: "demo-api",
        cwd: "/Users/example/code/demo-api",
        project: "demo-api",
        status: "idle",
        startedAt: registeredAt.fresh,
        statusSince: registeredAt.fresh,
        pid: fixture.fresh.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.crashed.sessionId}`,
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "finished",
        startedAt: registeredAt.crashed,
        statusSince: WRITTEN.crashed,
        lastWriteAt: WRITTEN.crashed,
        pid: fixture.crashed.pid,
        alive: false,
      },
    ]);
  });

  test("opens only the records and the chat files of the sessions it lists, and lists only two folders", async () => {
    const home = await makeQwenHome();
    const { io, calls } = recordingIo();
    const clock = handClock();
    const adapter = adapterFor(home, { io, now: clock.now });
    await adapter.poll();

    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [
        path.join(home, "sessions", "41001.json"),
        path.join(home, "sessions", "41002-0a1b2c3d.json"),
        path.join(home, "sessions", "41004.json"),
        path.join(home, "sessions", "41005.json"),
        path.join(home, "sessions", "41006.json"),
        path.join(home, CHATS, `${fixture.working.sessionId}.jsonl`),
        path.join(home, CHATS, `${fixture.idle.sessionId}.jsonl`),
      ].sort(),
    );
    const listed = calls.filter((call) => call.method === "readdir").map((call) => call.path);
    // The new session has no chat file yet, so the chat folders are looked through once for it.
    expect(listed.sort()).toEqual([path.join(home, "projects"), path.join(home, "sessions")]);
    for (const never of [...NEVER_OPENED, ".env"]) {
      expect(
        calls.filter((call) => call.path === path.join(home, never)),
        never,
      ).toEqual([]);
    }
    // Only chat files are looked at: the files beside them never are.
    for (const call of calls.filter((each) => each.method === "lstat")) {
      expect(call.path, call.path).toMatch(/[\\/]chats[\\/][0-9a-f-]{36}\.jsonl$/);
    }

    // A poll where nothing changed opens only the records.
    calls.length = 0;
    clock.advance(2_000);
    await adapter.poll();
    const again = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(again.every((file) => file.startsWith(path.join(home, "sessions")))).toBe(true);
  });

  test("lets no token, prompt, reply, thought or tool output out", async () => {
    const home = await makeQwenHome();
    const result = await adapterFor(home).poll();
    const said = JSON.stringify(result);
    expect(said).not.toContain(PRIVATE_TOKEN);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain(PLACEHOLDER);
    expect(said).not.toContain(".sock");
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const home = await makeQwenHome();
    const before = await snapshotOf(home);
    const clock = handClock();
    const adapter = adapterFor(home, { now: clock.now });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    // A session that goes on, and one that closes.
    await appendFile(
      path.join(home, CHATS, `${fixture.working.sessionId}.jsonl`),
      promptLine(NOW + 5_000, { sessionId: fixture.working.sessionId }),
    );
    const live = new Set(RUNNING_PIDS);
    live.delete(fixture.idle.pid);
    const after = adapterFor(home, { now: clock.now, isAlive: (pid) => live.has(pid) });
    await after.poll();
    const changed = await snapshotOf(home);
    await after.poll();
    expect(await snapshotOf(home)).toEqual(changed);
    expect(Object.keys(changed).sort()).toEqual(Object.keys(before).sort());
  });

  test("never follows a link at a record's or a chat file's name, and a pipe does not hold up the poll", async () => {
    // Windows keeps no named pipes among files, so there is no pipe there.
    const pipes = process.platform !== "win32";
    const home = await makeQwenHome();
    // A record that leads to a credential file, and a chat file that leads out of the folder.
    await symlink(path.join(home, "oauth_creds.json"), path.join(home, "sessions", "41007.json"));
    await writeFile(
      path.join(home, "sessions", "41008.json"),
      registryRecord({ pid: 41008, sessionId: sessionIdOf(8), kind: "tui" }),
    );
    const outside = path.join(await tempDir(), "elsewhere.jsonl");
    await writeFile(outside, promptLine(NOW - MINUTE, { sessionId: sessionIdOf(8) }));
    await symlink(outside, path.join(home, CHATS, `${sessionIdOf(8)}.jsonl`));
    if (pipes) execFileSync("mkfifo", [path.join(home, "sessions", "41009.json")]);
    const before = await snapshotOf(home);

    const { io, calls } = recordingIo();
    const started = Date.now();
    const { sessions } = await adapterFor(home, {
      io,
      isAlive: (pid) => RUNNING_PIDS.has(pid) || pid === 41008,
    }).poll();
    expect(Date.now() - started).toBeLessThan(3_000);

    // The session is listed with no chat file: a link is not one.
    expect(sessions.find((session) => session.id === `qwen-code:${sessionIdOf(8)}`)).toMatchObject({
      status: "idle",
    });
    expect(sessions.map((session) => session.pid)).not.toContain(41007);
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened).not.toContain(path.join(home, CHATS, `${sessionIdOf(8)}.jsonl`));
    expect(opened).not.toContain(outside);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_TOKEN);
    expect(await snapshotOf(home)).toEqual(before);
  }, 10_000);

  test("asks each process with signal 0 alone, and only the one its record's name gives", async () => {
    const home = await tempDir();
    const sessions = path.join(home, "sessions");
    await mkdir(sessions);
    const ended = spawnSync(process.execPath, ["-e", ""]);
    expect(ended.status).toBe(0);
    const startedAt = Date.now() - MINUTE;
    // This process's pid namespace, with none where it has none: with no
    // stand-in the adapter reads its own on Linux, and lists no record that
    // names no other.
    const pidNs = await createPidNamespaceRead()();
    const records: [string, number, string][] = [
      [`${process.pid}.json`, process.pid, sessionIdOf(11)],
      [`${ended.pid}.json`, ended.pid, sessionIdOf(12)],
      // A name that gives one pid and a record that names another is no record.
      [`${process.ppid}.json`, process.pid, sessionIdOf(13)],
    ];
    for (const [name, pid, sessionId] of records) {
      await writeFile(
        path.join(sessions, name),
        registryRecord({ pid, sessionId, startedAt, kind: "tui", pidNs }),
      );
    }

    const realKill = process.kill.bind(process);
    // Nothing but signal 0 is ever sent, even if the adapter asked for more.
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
    let result;
    let asked: Parameters<typeof process.kill>[];
    try {
      // The adapter's own check of each process, with no stand-in for it.
      result = await createQwenCodeAdapter({
        env: { AGENT_LOOKOUT_QWEN_HOME: home },
        homeDir: HOME,
      }).poll();
    } finally {
      asked = [...kill.mock.calls];
      kill.mockRestore();
    }
    expect(asked.map(([, signal]) => signal)).toEqual([0, 0]);
    expect(asked.map(([pid]) => pid).sort((a, b) => a - b)).toEqual(
      [process.pid, ended.pid].sort((a, b) => a - b),
    );
    expect(result.sessions.map((session) => [session.id, session.status, session.alive])).toEqual([
      [`qwen-code:${sessionIdOf(11)}`, "idle", true],
      [`qwen-code:${sessionIdOf(12)}`, "finished", false],
    ]);
  });

  test("a folder that is not there is watched and empty, and left so", async () => {
    const parent = await tempDir();
    const home = path.join(parent, "qwen");
    const result = await adapterFor(home).poll();
    expect(result.health.state).toBe("ok");
    expect(result.sessions).toEqual([]);
    expect(await readdir(parent)).toEqual([]);
    await mkdir(home);
    await adapterFor(home).poll();
    expect(await readdir(home)).toEqual([]);
  });
});

describe("a record whose pid another program was given, read from the real files", () => {
  const statusOf = (sessions: { id: string; status: string }[], name: keyof typeof fixture) =>
    sessions.find((session) => session.id === `qwen-code:${fixture[name].sessionId}`)?.status;

  test("on Linux, a record's start token tells its process from another given its pid, and one from a container is not listed", async () => {
    const home = await makeQwenHome();
    // The working and idle sessions' records as Qwen Code writes them on Linux,
    // and a session in a container that shares the folder, at a pid that runs here.
    for (const [name, ticks] of [
      ["working", 500],
      ["idle", 900],
    ] as const) {
      const { pid, sessionId } = fixture[name];
      await writeFile(
        path.join(home, "sessions", `${pid}.json`),
        registryRecord({
          pid,
          sessionId,
          startedAt: registeredAt[name],
          kind: "tui",
          procStart: startToken(ticks),
          pidNs: PID_NAMESPACE,
        }),
      );
    }
    await writeFile(
      path.join(home, "sessions", "41006.json"),
      registryRecord({
        pid: fixture.fresh.pid,
        sessionId: fixture.fresh.sessionId,
        kind: "tui",
        procStart: startToken(300),
        pidNs: 4026532001,
      }),
    );
    // The idle session's Qwen Code crashed, and another program has its pid.
    const tokens = standInTokens({ 41001: startToken(500), 41004: startToken(64_000) });
    const { sessions } = await adapterFor(home, {
      platform: "linux",
      readStartTokens: tokens.read,
      readPidNamespace: async () => PID_NAMESPACE,
    }).poll();

    expect(statusOf(sessions, "working")).toBe("working");
    expect(statusOf(sessions, "idle")).toBe("finished");
    expect(statusOf(sessions, "fresh")).toBeUndefined();
    expect(tokens.reads).toEqual([[41001, 41004]]);
  });

  test("on a Mac, a process ps says started after its record was written was given the pid, and its session is finished", async () => {
    const home = await makeQwenHome();
    const ps = standInStarts({
      [fixture.working.pid]: registeredAt.working - 2 * SECOND,
      [fixture.idle.pid]: NOW - 10 * MINUTE,
    });
    const { sessions } = await adapterFor(home, { readProcessStarts: ps.read }).poll();

    expect(statusOf(sessions, "working")).toBe("working");
    expect(statusOf(sessions, "idle")).toBe("finished");
    // ps knows nothing of it, so it stays as signal 0 says.
    expect(statusOf(sessions, "fresh")).toBe("idle");
    expect(ps.runs).toEqual([[fixture.working.pid, fixture.idle.pid, fixture.fresh.pid]]);
  });
});

describe("a question or a plan Qwen Code asks you, read from the real files", () => {
  const { sessionId } = fixture.working;
  const id = `qwen-code:${sessionId}`;

  async function asking(tool: string) {
    const home = await makeQwenHome();
    const file = path.join(home, CHATS, `${sessionId}.jsonl`);
    const clock = handClock();
    const adapter = adapterFor(home, { now: clock.now });
    const poll = async () => {
      clock.advance(2_000);
      return (await adapter.poll()).sessions.find((session) => session.id === id);
    };
    expect((await poll())?.status).toBe("working");
    // The working session's tools end, and the reply to its next request asks.
    await appendFile(
      file,
      toolResultLine(NOW - 25 * MINUTE, "success", { sessionId }) +
        lifecycleLine(NOW - 25 * MINUTE, "started", { sessionId }) +
        lifecycleLine(NOW - 24 * MINUTE, "ended", { sessionId }) +
        assistantLine(NOW - 24 * MINUTE, { sessionId, asks: tool }),
    );
    return { file, adapter, poll };
  }

  test("needs you from the reply that asks a question until its result, and lets nothing of the question out", async () => {
    const { file, adapter, poll } = await asking("ask_user_question");
    const asked = await poll();
    expect(asked).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 24 * MINUTE,
    });
    expect(asked).not.toHaveProperty("waitingText");
    const said = JSON.stringify(await adapter.poll());
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain("call-");

    await appendFile(
      file,
      toolResultLine(NOW - 20 * MINUTE, "success", { sessionId, tool: "ask_user_question" }),
    );
    const answered = await poll();
    expect(answered).toMatchObject({ status: "working", statusSince: NOW - 20 * MINUTE });
    expect(answered).not.toHaveProperty("waitingReason");
  });

  test("needs you while it asks to approve a plan, and is idle once the plan is declined", async () => {
    const { file, poll } = await asking("exit_plan_mode");
    expect(await poll()).toMatchObject({ status: "needs-you", waitingReason: "question" });
    await appendFile(
      file,
      toolResultLine(NOW - 20 * MINUTE, "cancelled", { sessionId, tool: "exit_plan_mode" }),
    );
    expect(await poll()).toMatchObject({ status: "idle", statusSince: NOW - 20 * MINUTE });
  });
});

describe("what a session last said, read from the real files", () => {
  /** A session whose newest reply is its own, listed by a poll, with a clock the test moves. */
  async function listedSession() {
    const home = await tempDir();
    const id = sessionIdOf(1);
    await mkdir(path.join(home, "sessions"));
    await writeFile(
      path.join(home, "sessions", "41001.json"),
      registryRecord({ pid: 41001, sessionId: id, kind: "tui" }),
    );
    const file = chatPath(home, id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      [
        promptLine(NOW - 2 * MINUTE, { sessionId: id }),
        assistantLine(NOW - MINUTE, { sessionId: id, says: "A reply of its own." }),
        assistantLine(NOW - 50 * SECOND, { sessionId: id, says: PRIVATE_WORDS, sidechain: true }),
        toolResultLine(NOW - 40 * SECOND, "success", { sessionId: id }),
      ].join(""),
    );
    // Beside it, a file of the session's own that is never opened.
    const beside = path.join(path.dirname(file), `${id}.runtime.json`);
    await writeFile(beside, JSON.stringify({ text: PRIVATE_WORDS }));
    let at = NOW;
    const { io, calls } = recordingIo();
    const adapter = adapterFor(home, { io, now: () => at, isAlive: (pid) => pid === 41001 });
    const { sessions } = await adapter.poll();
    expect(sessions.map((session) => session.id)).toContain(`qwen-code:${id}`);
    return {
      file,
      beside,
      calls,
      ask: () => adapter.lastMessage(`qwen-code:${id}`),
      later: () => (at += SECOND),
    };
  }

  test("is the newest reply's text, read from the session's own chat file when asked, and from no file beside it", async () => {
    const { file, beside, calls, ask } = await listedSession();
    calls.length = 0;
    const answer = await ask();
    expect(answer).toEqual({ message: { text: "A reply of its own.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORDS);
    // The adapter joins its paths as the system does, so on Windows with its own separator.
    expect(calls.filter((call) => call.method === "openRegular").map((call) => call.path)).toEqual([
      path.normalize(file),
    ]);
    expect(calls.filter((call) => call.path === beside)).toEqual([]);
  });

  test("is unreadable once a link is put in its chat file's place after the poll listed it, and is never read through", async () => {
    const elsewhere = path.join(await tempDir(), "elsewhere.jsonl");
    await writeFile(elsewhere, assistantLine(NOW - MINUTE, { says: "PRIVATE-ELSEWHERE reply" }));
    const { file, calls, ask, later } = await listedSession();

    // Put there before the first ask.
    await rm(file);
    await symlink(elsewhere, file);
    const linked = await ask();
    expect(linked).toEqual({ message: null, reason: "unreadable" });

    // Read as a file, then a link put in its place.
    await rm(file);
    await writeFile(file, assistantLine(NOW - MINUTE, { says: "A reply of its own." }));
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
    "is unreadable once a named pipe is put in its chat file's place after the poll listed it, and does not wait on it",
    async () => {
      const { file, ask, later } = await listedSession();
      const started = Date.now();

      // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
      await rm(file);
      execFileSync("mkfifo", [file]);
      await expect(ask()).resolves.toEqual({ message: null, reason: "unreadable" });

      await rm(file);
      await writeFile(file, assistantLine(NOW - MINUTE, { says: "A reply of its own." }));
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
