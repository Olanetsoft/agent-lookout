import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  ELSEWHERE_NOTE,
  NEWER_FORMAT_NOTE,
  NO_CHAT_AFTER_MS,
  NO_CHAT_NOTE,
  OLDER_QWEN_NOTE,
  QWEN_CODE_CAPABILITIES,
  QWEN_CODE_HOME_ENV,
  QWEN_OWN_HOME_ENV,
  QWEN_OWN_RUNTIME_ENV,
  qwenFolders,
  RECHECK_MS,
  UNKNOWN_NOTE,
} from "@collector/adapters/qwen-code/index";
import {
  assistantLine,
  chatFile,
  chatPath,
  DAY,
  HOME,
  lifecycleLine,
  MINUTE,
  NOW,
  PRIVATE_TOKEN,
  PROJECT,
  promptLine,
  QWEN_DIR,
  recordPath,
  registryRecord,
  sessionIdOf,
  titleLine,
  toolResultLine,
} from "@tests/fixtures/qwen-code/qwenCode";
import {
  handClock,
  healthy,
  memoryFiles,
  qwenCodeAdapterFor,
  standInProcesses,
  watching,
  type MemoryFiles,
} from "@tests/support/adapters/qwenCodeAdapter";

const SESSIONS = `${QWEN_DIR}/sessions`;
const PROJECTS = `${QWEN_DIR}/projects`;
const ID = sessionIdOf(1);

const NOT_INSTALLED =
  "Qwen Code was not found: there is no ~/.qwen/sessions or ~/.qwen/projects folder. Agent Lookout looks again every minute.";

/** A record of a terminal session, and its chat file when it has lines. */
function addSession(
  files: MemoryFiles,
  options: {
    pid: number;
    sessionId: string;
    startedAt?: number;
    kind?: string;
    lines?: string[];
    mtimeMs?: number;
    name?: string;
  },
) {
  files.write(
    recordPath(QWEN_DIR, options.name ?? `${options.pid}.json`),
    registryRecord({
      pid: options.pid,
      sessionId: options.sessionId,
      startedAt: options.startedAt ?? NOW - 30 * MINUTE,
      kind: options.kind ?? "tui",
    }),
  );
  if (options.lines) {
    files.write(chatPath(QWEN_DIR, options.sessionId), chatFile(...options.lines), {
      mtimeMs: options.mtimeMs,
    });
  }
}

describe("qwenFolders", () => {
  test("Qwen Code's own folder, ~/.qwen, holds both, unless a setting moves them", () => {
    expect(qwenFolders({}, HOME)).toEqual({
      home: path.resolve(QWEN_DIR),
      runtime: path.resolve(QWEN_DIR),
      homeFrom: "default",
    });
    expect(qwenFolders({ [QWEN_OWN_HOME_ENV]: "/Users/example/qwen-home" }, HOME)).toEqual({
      home: path.resolve("/Users/example/qwen-home"),
      runtime: path.resolve("/Users/example/qwen-home"),
      homeFrom: "qwen",
    });
    expect(
      qwenFolders(
        {
          [QWEN_OWN_HOME_ENV]: "/Users/example/qwen-home",
          [QWEN_OWN_RUNTIME_ENV]: "/tmp/qwen-runtime",
        },
        HOME,
      ),
    ).toEqual({
      home: path.resolve("/Users/example/qwen-home"),
      runtime: path.resolve("/tmp/qwen-runtime"),
      homeFrom: "qwen",
    });
  });

  test("Agent Lookout's own setting names both folders and wins outright", () => {
    expect(
      qwenFolders(
        {
          [QWEN_CODE_HOME_ENV]: "/tmp/empty-qwen",
          [QWEN_OWN_HOME_ENV]: "/Users/example/qwen-home",
          [QWEN_OWN_RUNTIME_ENV]: "/tmp/qwen-runtime",
        },
        HOME,
      ),
    ).toEqual({
      home: path.resolve("/tmp/empty-qwen"),
      runtime: path.resolve("/tmp/empty-qwen"),
      homeFrom: "agent-lookout",
    });
  });

  test("a value is trimmed, an empty one is none, and ~ is the home folder, as Qwen Code reads it", () => {
    expect(
      qwenFolders({ [QWEN_OWN_HOME_ENV]: "  ", [QWEN_OWN_RUNTIME_ENV]: "" }, HOME),
    ).toMatchObject({
      home: path.resolve(QWEN_DIR),
      runtime: path.resolve(QWEN_DIR),
      homeFrom: "default",
    });
    expect(qwenFolders({ [QWEN_OWN_HOME_ENV]: " ~/qwen " }, HOME).home).toBe(
      path.resolve("/Users/example/qwen"),
    );
    expect(qwenFolders({ [QWEN_OWN_RUNTIME_ENV]: "~" }, HOME).runtime).toBe(path.resolve(HOME));
    expect(qwenFolders({ [QWEN_CODE_HOME_ENV]: "~\\qwen" }, HOME).home).toBe(
      path.resolve("/Users/example/qwen"),
    );
  });
});

describe("when Qwen Code is not installed", () => {
  test("is unavailable, says so calmly, and looks again only once a minute", async () => {
    const files = memoryFiles();
    // ~/.qwen with neither a list of sessions nor chat files.
    files.write(`${QWEN_DIR}/settings.json`, "{}");
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });

    const first = await adapter.poll();
    expect(first.health).toMatchObject({
      id: "qwen-code",
      label: "Qwen Code",
      state: "unavailable",
      detail: NOT_INSTALLED,
      watching: watching("not found"),
    });
    expect(first.sessions).toEqual([]);
    expect(first).not.toHaveProperty("basis");
    expect(files.calls.map((call) => call.method)).toEqual(["stat", "stat"]);

    files.forget();
    clock.advance(RECHECK_MS - 1);
    expect((await adapter.poll()).health.state).toBe("unavailable");
    expect(files.calls).toEqual([]);

    clock.advance(1);
    files.mkdir(SESSIONS);
    expect((await adapter.poll()).health.state).toBe("ok");
  });

  test("names QWEN_HOME when it says where Qwen Code is", async () => {
    const files = memoryFiles();
    const adapter = qwenCodeAdapterFor(files, {
      env: { [QWEN_OWN_HOME_ENV]: "/Users/example/qwen-home" },
    });
    expect((await adapter.poll()).health.detail).toBe(
      "Qwen Code was not found: QWEN_HOME is set to ~/qwen-home, and there is no ~/qwen-home/sessions or ~/qwen-home/projects folder. Agent Lookout looks again every minute.",
    );
  });

  test(`a folder ${QWEN_CODE_HOME_ENV} names is an answer, read on every poll`, async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, {
      env: { [QWEN_CODE_HOME_ENV]: "/Users/example/code/demo/qwen" },
      now: clock.now,
    });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "ok",
      watching: watching("not found", "~/code/demo/qwen/sessions", "~/code/demo/qwen/projects"),
    });
    expect(result.health.detail).toContain(
      `${QWEN_CODE_HOME_ENV} is set to ~/code/demo/qwen, which has no sessions folder, so no Qwen Code sessions are listed.`,
    );
    expect(result.sessions).toEqual([]);
    expect(result.basis).toBe(BASIS);

    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    expect(files.count("readdir")).toBe(1);
  });

  test("with chat files and no list of running sessions, says which Qwen Code lists them", async () => {
    const files = memoryFiles();
    files.write(chatPath(QWEN_DIR, ID), chatFile(promptLine(NOW - MINUTE)));
    const result = await qwenCodeAdapterFor(files).poll();
    expect(result.health.state).toBe("ok");
    expect(result.health.detail).toContain(OLDER_QWEN_NOTE);
    expect(result.sessions).toEqual([]);
    // The chat files are not read: with no list, no session is known to be open.
    expect(files.opened()).toEqual([]);
  });
});

describe("reading the sessions", () => {
  test("lists each terminal session with its status, name, folder and last write", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: sessionIdOf(1),
      lines: [promptLine(NOW - 10 * MINUTE), lifecycleLine(NOW - 10 * MINUTE + 10, "started")],
      mtimeMs: NOW - 9 * MINUTE,
    });
    addSession(files, {
      pid: 41004,
      sessionId: sessionIdOf(4),
      startedAt: NOW - 2 * 60 * MINUTE,
      lines: [
        promptLine(NOW - 60 * MINUTE),
        assistantLine(NOW - 59 * MINUTE),
        titleLine(NOW - 59 * MINUTE, "Tidy the release notes"),
      ],
      mtimeMs: NOW - 59 * MINUTE,
    });
    // An editor's session is left out, whatever it holds.
    addSession(files, {
      pid: 41002,
      sessionId: sessionIdOf(2),
      kind: "headless",
      name: "41002-0a1b2c3d.json",
      lines: [promptLine(NOW - MINUTE)],
    });
    const processes = standInProcesses([41001, 41002, 41004]);
    const result = await qwenCodeAdapterFor(files, { isAlive: processes.isAlive }).poll();

    expect(result.health).toMatchObject({
      id: "qwen-code",
      state: "ok",
      detail: healthy(),
      watching: watching("every 2 seconds"),
    });
    expect(result.basis).toBe(BASIS);
    expect(result.sessions).toEqual([
      {
        id: `qwen-code:${sessionIdOf(1)}`,
        source: "qwen-code",
        surface: "terminal",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "working",
        startedAt: NOW - 10 * MINUTE,
        statusSince: NOW - 10 * MINUTE,
        lastWriteAt: NOW - 9 * MINUTE,
        pid: 41001,
        alive: true,
        links: {},
        stale: false,
      },
      {
        id: `qwen-code:${sessionIdOf(4)}`,
        source: "qwen-code",
        surface: "terminal",
        name: "Tidy the release notes",
        cwd: PROJECT,
        project: "demo-project",
        status: "idle",
        startedAt: NOW - 60 * MINUTE,
        statusSince: NOW - 59 * MINUTE,
        lastWriteAt: NOW - 59 * MINUTE,
        pid: 41004,
        alive: true,
        links: {},
        stale: false,
      },
    ]);
    // Signal 0 is asked of each terminal session's process, and of nothing else.
    expect(processes.asked.sort()).toEqual([41001, 41004]);
    expect(files.opened().sort()).toEqual([
      chatPath(QWEN_DIR, sessionIdOf(1)),
      chatPath(QWEN_DIR, sessionIdOf(4)),
      recordPath(QWEN_DIR, "41001.json"),
      recordPath(QWEN_DIR, "41002-0a1b2c3d.json"),
      recordPath(QWEN_DIR, "41004.json"),
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_TOKEN);
    expect(JSON.stringify(result)).not.toContain("placeholder");
    expect(files.openHandles()).toBe(0);
  });

  test("of two records of one session, the newest whose process runs is listed", async () => {
    const files = memoryFiles();
    // An older process still holds the session, and a newer one that resumed it has crashed.
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      startedAt: NOW - 60 * MINUTE,
      lines: [promptLine(NOW - MINUTE)],
    });
    addSession(files, { pid: 41002, sessionId: ID, startedAt: NOW - 10 * MINUTE });
    const processes = standInProcesses([41001]);
    const result = await qwenCodeAdapterFor(files, { isAlive: processes.isAlive }).poll();
    expect(result.sessions).toMatchObject([
      { id: `qwen-code:${ID}`, status: "working", pid: 41001, alive: true },
    ]);
    expect(processes.asked.sort()).toEqual([41001, 41002]);
  });

  test("a poll where nothing changed opens only the records", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    expect(files.opened()).toEqual([recordPath(QWEN_DIR, "41001.json")]);
    expect(files.count("readdir")).toBe(1);
  });

  test("a session with no chat file is idle since it registered, and after ten minutes the Sources view says why", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, startedAt: NOW - NO_CHAT_AFTER_MS + 1 });
    files.mkdir(PROJECTS);
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    const first = await adapter.poll();
    expect(first.sessions[0]).toMatchObject({
      status: "idle",
      statusSince: NOW - NO_CHAT_AFTER_MS + 1,
    });
    expect(first.health.detail).toBe(healthy());

    clock.advance(1);
    expect((await adapter.poll()).health.detail).toBe(`${healthy()} ${NO_CHAT_NOTE}`);
  });

  test("follows a session's chat file as it grows: working, then idle", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    files.append(chatPath(QWEN_DIR, ID), assistantLine(NOW - 30_000, { calls: 1 }), {
      mtimeMs: NOW + 1,
    });
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    files.append(chatPath(QWEN_DIR, ID), toolResultLine(NOW, "cancelled"), { mtimeMs: NOW + 2 });
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "idle", statusSince: NOW });
  });

  test("a session whose chat file says nothing it reads is unknown, and the Sources view says so", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      lines: [
        promptLine(NOW - MINUTE),
        JSON.stringify({ type: "summary", timestamp: new Date(NOW).toISOString() }) + "\n",
      ],
    });
    const result = await qwenCodeAdapterFor(files).poll();
    expect(result.sessions[0]?.status).toBe("unknown");
    expect(result.health.detail).toBe(`${healthy()} ${UNKNOWN_NOTE}`);
  });

  test("a chat file that cannot be read gives an unknown status, and the session stays listed", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    // It is there, and opening it fails.
    const io = {
      ...files.io,
      openRegular: (target: string) =>
        target.endsWith(".jsonl")
          ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
          : files.io.openRegular(target),
    };
    const result = await qwenCodeAdapterFor(files, { io }).poll();
    expect(result.sessions.map((session) => session.status)).toEqual(["unknown"]);
  });

  test("a record of a newer format, or from a container, is not listed, and the Sources view says so", async () => {
    const files = memoryFiles();
    files.write(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({ pid: 41001, sessionId: ID, schemaVersion: 2 }),
    );
    files.write(
      recordPath(QWEN_DIR, "1.json"),
      registryRecord({
        pid: 1,
        sessionId: sessionIdOf(2),
        procStart: "0000:42",
        pidNs: 4026531836,
      }),
    );
    const result = await qwenCodeAdapterFor(files).poll();
    expect(result.sessions).toEqual([]);
    expect(result.health.detail).toBe(`${healthy()} ${NEWER_FORMAT_NOTE} ${ELSEWHERE_NOTE}`);
  });

  test("a list that cannot be read is an error, and the poll before it stands", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();

    files.fail(SESSIONS);
    clock.advance(2_000);
    const failed = await adapter.poll();
    expect(failed.health).toMatchObject({
      state: "error",
      detail:
        "Qwen Code sessions could not be read: the folder ~/.qwen/sessions could not be listed.",
      watching: watching("cannot be read"),
    });
    expect(failed.sessions).toEqual([]);

    // The session closes while the list cannot be read. Nothing was taken to
    // have closed then: it is finished from the first poll that could read the list.
    files.remove(recordPath(QWEN_DIR, "41001.json"));
    files.heal(SESSIONS);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toMatchObject([
      { id: `qwen-code:${ID}`, status: "finished", statusSince: NOW + 4_000 },
    ]);
  });

  test("never throws: any failure of the files is a sentence", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const adapter = qwenCodeAdapterFor(files, {
      isAlive: () => {
        throw new Error("boom");
      },
    });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Qwen Code sessions.",
    });
    expect(result.sessions).toEqual([]);

    const broken = memoryFiles();
    broken.failAll("EIO");
    const answer = await qwenCodeAdapterFor(broken).poll();
    expect(answer.health).toMatchObject({
      state: "error",
      detail:
        "Qwen Code sessions could not be read: the folder ~/.qwen/sessions could not be listed.",
    });
  });

  test("carries its own declaration, and says where it looks", () => {
    const adapter = qwenCodeAdapterFor(memoryFiles());
    expect(adapter.capabilities).toBe(QWEN_CODE_CAPABILITIES);
    expect(adapter.lookingIn).toBe("Looking for Qwen Code sessions in ~/.qwen/sessions.");
  });
});

describe("closed sessions", () => {
  function setUp() {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const processes = standInProcesses([41001]);
    const adapter = qwenCodeAdapterFor(files, { now: clock.now, isAlive: processes.isAlive });
    return { files, clock, processes, adapter };
  }

  test("a session whose record has gone is finished from that poll, for a day", async () => {
    const { files, clock, adapter } = setUp();
    const [open] = (await adapter.poll()).sessions;
    files.remove(recordPath(QWEN_DIR, "41001.json"));
    clock.advance(2_000);
    const closed = await adapter.poll();
    expect(closed.sessions).toEqual([
      { ...open, status: "finished", statusSince: NOW + 2_000, alive: false, stale: false },
    ]);
    files.forget();
    clock.advance(2_000);
    await adapter.poll();
    // Its chat file is not read again.
    expect(files.opened()).toEqual([]);

    clock.set(NOW + 2_000 + DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("a session whose process has gone is finished, though its record is left behind", async () => {
    const { clock, processes, adapter } = setUp();
    await adapter.poll();
    processes.stop(41001);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toMatchObject([
      { status: "finished", statusSince: NOW + 2_000, alive: false, pid: 41001 },
    ]);
  });

  test("after /clear, the session before is finished and the new one idle", async () => {
    const { files, clock, adapter } = setUp();
    await adapter.poll();
    files.rewrite(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({
        pid: 41001,
        sessionId: sessionIdOf(7),
        startedAt: NOW - 30 * MINUTE,
        kind: "tui",
      }),
    );
    clock.advance(2_000);
    const sessions = (await adapter.poll()).sessions;
    expect(sessions.map((session) => [session.id, session.status])).toEqual([
      [`qwen-code:${sessionIdOf(7)}`, "idle"],
      [`qwen-code:${ID}`, "finished"],
    ]);
  });

  test("with the whole list gone, every session shown open has closed", async () => {
    const { files, clock, adapter } = setUp();
    await adapter.poll();
    files.remove(SESSIONS);
    clock.advance(2_000);
    const result = await adapter.poll();
    expect(result.health.detail).toContain(OLDER_QWEN_NOTE);
    expect(result.sessions.map((session) => session.status)).toEqual(["finished"]);
  });

  test("a record a crash left behind is finished from its last write, at the first poll only", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41005,
      sessionId: sessionIdOf(5),
      startedAt: NOW - 3 * 60 * MINUTE,
      lines: [promptLine(NOW - 2 * 60 * MINUTE)],
      mtimeMs: NOW - 2 * 60 * MINUTE,
    });
    addSession(files, {
      pid: 41008,
      sessionId: sessionIdOf(8),
      startedAt: NOW - 2 * DAY,
      lines: [promptLine(NOW - 2 * DAY)],
      mtimeMs: NOW - 2 * DAY,
    });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now, isAlive: () => false });
    const first = await adapter.poll();
    expect(first.sessions).toEqual([
      expect.objectContaining({
        id: `qwen-code:${sessionIdOf(5)}`,
        name: "demo-project",
        status: "finished",
        statusSince: NOW - 2 * 60 * MINUTE,
        alive: false,
      }),
    ]);
    // Only looked at, never opened.
    expect(files.opened().filter((file) => file.endsWith(".jsonl"))).toEqual([]);

    // A record left behind later is a session that closed before it was seen open.
    addSession(files, { pid: 41009, sessionId: sessionIdOf(9), startedAt: NOW - MINUTE });
    clock.advance(2_000);
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([
      `qwen-code:${sessionIdOf(5)}`,
    ]);
  });
});
