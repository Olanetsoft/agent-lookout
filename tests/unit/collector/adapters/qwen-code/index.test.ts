import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTailLimits } from "@collector/messages/tailReader";
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import type { TmuxPane } from "@collector/tmux/panes";

import {
  BASIS,
  ELSEWHERE_NOTE,
  NEEDS_YOU_NOTE,
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
  OPENAI_USAGE,
  PID_NAMESPACE,
  PRIVATE_TOKEN,
  PRIVATE_WORDS,
  PROJECT,
  promptLine,
  QWEN_DIR,
  recordPath,
  registryRecord,
  SECOND,
  sessionIdOf,
  startToken,
  titleLine,
  toolResultLine,
} from "@tests/fixtures/qwen-code/qwenCode";
import {
  handClock,
  healthy,
  LINUX_PROCESS_CHECK,
  MAC_PROCESS_CHECK,
  memoryFiles,
  PROCESS_CHECK_RUN,
  qwenCodeAdapterFor,
  standInProcesses,
  standInStarts,
  standInTokens,
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
    /** The start token and namespace a record written on Linux carries. */
    procStart?: string;
    pidNs?: number;
  },
) {
  files.write(
    recordPath(QWEN_DIR, options.name ?? `${options.pid}.json`),
    registryRecord({
      pid: options.pid,
      sessionId: options.sessionId,
      startedAt: options.startedAt ?? NOW - 30 * MINUTE,
      kind: options.kind ?? "tui",
      procStart: options.procStart,
      pidNs: options.pidNs,
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
        tokens: { input: 1200, cached: 600, output: 100 },
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

  test("needs you while Qwen Code asks a question, and works again once it is answered", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();

    files.append(
      chatPath(QWEN_DIR, ID),
      lifecycleLine(NOW - 40_000, "started") +
        lifecycleLine(NOW - 30_000, "ended") +
        assistantLine(NOW - 30_000, { asks: "ask_user_question" }),
      { mtimeMs: NOW + 1 },
    );
    clock.advance(2_000);
    const asked = await adapter.poll();
    expect(asked.sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 30_000,
    });
    expect(asked.health.detail).toBe(healthy());
    expect(JSON.stringify(asked).toLowerCase()).not.toContain("placeholder");

    // With no newer line, a poll later is the same wait, at the same time.
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 30_000,
    });

    files.append(
      chatPath(QWEN_DIR, ID),
      toolResultLine(NOW, "success", { tool: "ask_user_question" }),
      {
        mtimeMs: NOW + 2,
      },
    );
    clock.advance(2_000);
    const answered = (await adapter.poll()).sessions[0];
    expect(answered).toMatchObject({ status: "working", statusSince: NOW });
    expect(answered).not.toHaveProperty("waitingReason");
  });

  test("a plan to approve needs you too, and a declined one is idle", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      lines: [
        promptLine(NOW - MINUTE),
        lifecycleLine(NOW - 30_000, "ended"),
        assistantLine(NOW - 30_000, { asks: "exit_plan_mode" }),
      ],
    });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
    });
    files.append(
      chatPath(QWEN_DIR, ID),
      toolResultLine(NOW, "cancelled", { tool: "exit_plan_mode" }),
      {
        mtimeMs: NOW + 1,
      },
    );
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "idle", statusSince: NOW });
  });

  test("a tool's approval writes nothing, so its session stays working", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      lines: [promptLine(NOW - MINUTE), assistantLine(NOW - 30_000, { calls: 1 })],
    });
    const adapter = qwenCodeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: NOW - MINUTE,
    });
  });

  test("carries the token counts of its newest reply that has them, read as the chat file grows", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).not.toHaveProperty("tokens");

    files.append(chatPath(QWEN_DIR, ID), assistantLine(NOW - 50_000, { calls: 1 }), {
      mtimeMs: NOW + 1,
    });
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual({
      input: 1200,
      cached: 600,
      output: 100,
    });

    // A subagent's reply, and a reply cut short with no counts, leave them as they were.
    files.append(
      chatPath(QWEN_DIR, ID),
      chatFile(
        toolResultLine(NOW - 40_000),
        assistantLine(NOW - 35_000, { sidechain: true, usage: OPENAI_USAGE }),
        assistantLine(NOW - 30_000, { usage: null }),
      ),
      { mtimeMs: NOW + 2 },
    );
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual({
      input: 1200,
      cached: 600,
      output: 100,
    });

    files.append(chatPath(QWEN_DIR, ID), assistantLine(NOW - 20_000, { usage: OPENAI_USAGE }), {
      mtimeMs: NOW + 3,
    });
    clock.advance(2_000);
    const result = await adapter.poll();
    expect(result.sessions[0]?.tokens).toEqual({ input: 2400, cached: 1800, output: 150 });
    expect(JSON.stringify(result)).not.toContain("placeholder");
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
    expect(NEEDS_YOU_NOTE).toBe(
      "A Qwen Code session shows as needing you while Qwen Code 0.25.1 or newer asks you a question or to approve a plan. Qwen Code does not record a wait for a tool's approval, so a session waiting for one shows as working.",
    );
    expect(adapter.lookingIn).toBe("Looking for Qwen Code sessions in ~/.qwen/sessions.");
  });
});

describe("Jump", () => {
  const REGISTERED = NOW - 30 * MINUTE;
  const pane: TmuxPane = { pid: 4100, id: "%3", place: "api-rate-limits:0.1" };
  const tab: TerminalTab = { app: "iTerm2", tty: "/dev/ttys007" };

  /** A stand-in for the collector's pane finder: it knows some panes, and writes down who it was asked about. */
  function knownPanes(panes: Record<number, TmuxPane>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      paneOf: (pid: number) => panes[pid],
    };
  }

  /** The same for the tab finder. */
  function knownTabs(tabs: Record<number, TerminalTab>) {
    const looked: number[][] = [];
    return {
      looked,
      look: async (asked: readonly number[]) => {
        looked.push([...asked].sort());
      },
      tabOf: (pid: number) => tabs[pid],
    };
  }

  /** Two open sessions, registered half an hour ago, each with a prompt. */
  function twoSessions() {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: sessionIdOf(1),
      startedAt: REGISTERED,
      lines: [promptLine(NOW - MINUTE, { sessionId: sessionIdOf(1) })],
    });
    addSession(files, {
      pid: 41004,
      sessionId: sessionIdOf(4),
      startedAt: REGISTERED,
      lines: [promptLine(NOW - MINUTE, { sessionId: sessionIdOf(4) })],
    });
    return files;
  }

  /** Both sessions' processes, started a moment before they registered. */
  const ownStarts = () => standInStarts({ 41001: REGISTERED - 2_000, 41004: REGISTERED - 2_000 });

  const jumps = (sessions: { id: string; jump?: unknown }[]) =>
    sessions.map((session) => [session.id, session.jump]);

  test("a session whose process runs in a pane is given the place, and the pane's id stays here", async () => {
    const panes = knownPanes({ 41004: pane });
    const ps = ownStarts();
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      panes,
      readProcessStarts: ps.read,
    }).poll();

    expect(panes.looked).toEqual([[41001, 41004]]);
    expect(jumps(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, undefined],
      [`qwen-code:${sessionIdOf(4)}`, { kind: "tmux", place: "api-rate-limits:0.1" }],
    ]);
    expect(JSON.stringify(sessions)).not.toContain("%3");
    // On a Mac, ps was asked when each open session's process started, in one
    // run, and that answer serves Jump too.
    expect(ps.runs).toEqual([[41001, 41004]]);
  });

  test("on Linux, ps is asked about the process found in a pane, and about no other", async () => {
    const ps = ownStarts();
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      platform: "linux",
      panes: knownPanes({ 41004: pane }),
      readProcessStarts: ps.read,
    }).poll();

    expect(jumps(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, undefined],
      [`qwen-code:${sessionIdOf(4)}`, { kind: "tmux", place: "api-rate-limits:0.1" }],
    ]);
    expect(ps.runs).toEqual([[41004]]);
  });

  test("a session in a tab of Terminal or iTerm2 is given the app, and one in a pane is reached through tmux", async () => {
    const panes = knownPanes({ 41001: pane });
    const terminals = knownTabs({ 41001: { app: "Terminal", tty: "/dev/ttys004" }, 41004: tab });
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      panes,
      terminals,
      readProcessStarts: ownStarts().read,
    }).poll();

    expect(terminals.looked).toEqual(panes.looked);
    expect(jumps(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, { kind: "tmux", place: "api-rate-limits:0.1" }],
      [`qwen-code:${sessionIdOf(4)}`, { kind: "terminal", app: "iTerm2", place: "iTerm2" }],
    ]);
    expect(JSON.stringify(sessions)).not.toContain("ttys");
  });

  test("a process that started after its session's record was written was given the pid: on a Mac the session is finished, with no Jump", async () => {
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE, 41004: REGISTERED - 2_000 });
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      panes: knownPanes({ 41001: pane }),
      terminals: knownTabs({ 41004: tab }),
      readProcessStarts: ps.read,
    }).poll();

    expect(jumps(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(4)}`, { kind: "terminal", app: "iTerm2", place: "iTerm2" }],
      [`qwen-code:${sessionIdOf(1)}`, undefined],
    ]);
    expect(sessions[1]).toMatchObject({ status: "finished", pid: 41001, alive: false });
  });

  test("on Linux, a process ps says started after its record was written has no Jump, and its session is as its token says", async () => {
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE, 41004: REGISTERED - 2_000 });
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      platform: "linux",
      panes: knownPanes({ 41001: pane, 41004: pane }),
      readProcessStarts: ps.read,
    }).poll();

    expect(jumps(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, undefined],
      [`qwen-code:${sessionIdOf(4)}`, { kind: "tmux", place: "api-rate-limits:0.1" }],
    ]);
    // These records have no token, so it is listed as it was.
    expect(sessions[0]).toMatchObject({ status: "working", pid: 41001, alive: true });
  });

  test("when ps cannot say when a process started, its session has no Jump", async () => {
    const ps = ownStarts();
    ps.fails = true;
    const { sessions } = await qwenCodeAdapterFor(twoSessions(), {
      panes: knownPanes({ 41001: pane }),
      readProcessStarts: ps.read,
    }).poll();

    expect(sessions.every((session) => session.jump === undefined)).toBe(true);
  });

  test("on a Mac, ps is asked about every open session's process, at most once in 30 seconds", async () => {
    const ps = ownStarts();
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(twoSessions(), {
      now: clock.now,
      panes: knownPanes({ 41001: pane }),
      terminals: knownTabs({}),
      readProcessStarts: ps.read,
    });
    for (let polls = 0; polls < 10; polls += 1) {
      expect(jumps((await adapter.poll()).sessions)[0]?.[1]).toMatchObject({ kind: "tmux" });
      clock.advance(2_000);
    }
    expect(ps.runs).toEqual([[41001, 41004]]);
  });

  test("on Linux, ps is asked about the processes found in a pane or a tab, at most once in 30 seconds", async () => {
    const ps = ownStarts();
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(twoSessions(), {
      platform: "linux",
      now: clock.now,
      panes: knownPanes({ 41001: pane }),
      terminals: knownTabs({}),
      readProcessStarts: ps.read,
    });
    for (let polls = 0; polls < 10; polls += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    expect(ps.runs).toEqual([[41001]]);
  });

  test("a session whose process has ended is finished with no Jump, and its process is not asked about again", async () => {
    const files = twoSessions();
    const processes = standInProcesses([41001, 41004]);
    const clock = handClock();
    const panes = knownPanes({ 41001: pane, 41004: pane });
    const terminals = knownTabs({});
    const adapter = qwenCodeAdapterFor(files, {
      now: clock.now,
      isAlive: processes.isAlive,
      panes,
      terminals,
      readProcessStarts: ownStarts().read,
    });
    await adapter.poll();

    processes.stop(41001);
    clock.advance(2_000);
    const { sessions } = await adapter.poll();
    expect(sessions).toMatchObject([
      { id: `qwen-code:${sessionIdOf(4)}`, status: "working", jump: { kind: "tmux" } },
      { id: `qwen-code:${sessionIdOf(1)}`, status: "finished", alive: false },
    ]);
    expect(sessions[1]).not.toHaveProperty("jump");

    processes.stop(41004);
    clock.advance(2_000);
    const closed = await adapter.poll();
    expect(closed.sessions.map((session) => session.jump)).toEqual([undefined, undefined]);
    expect(panes.looked).toEqual([[41001, 41004], [41004], []]);
    expect(terminals.looked).toEqual(panes.looked);
  });

  test("a poll that lists no session tells the finders it has no process to ask about", async () => {
    const files = twoSessions();
    const clock = handClock();
    const panes = knownPanes({ 41001: pane });
    const adapter = qwenCodeAdapterFor(files, { now: clock.now, panes });
    await adapter.poll();

    files.fail(SESSIONS);
    clock.advance(2_000);
    expect((await adapter.poll()).health.state).toBe("error");
    expect(panes.looked).toEqual([[41001, 41004], []]);
  });

  test("a poll that throws tells the finders it has no process to ask about", async () => {
    const panes = knownPanes({ 41001: pane });
    const terminals = knownTabs({});
    const result = await qwenCodeAdapterFor(twoSessions(), {
      isAlive: () => {
        throw new Error("boom");
      },
      panes,
      terminals,
    }).poll();

    expect(result.health.state).toBe("error");
    expect(panes.looked).toEqual([[]]);
    expect(terminals.looked).toEqual([[]]);
  });

  test("without a finder no pane or tab is looked for, and the sessions are as they were", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const ps = ownStarts();
      const without = await qwenCodeAdapterFor(twoSessions(), {
        platform,
        readProcessStarts: ps.read,
      }).poll();
      const withFinders = await qwenCodeAdapterFor(twoSessions(), {
        platform,
        panes: knownPanes({}),
        terminals: knownTabs({}),
        readProcessStarts: ps.read,
      }).poll();

      expect(withFinders.sessions, platform).toEqual(without.sessions);
      // On a Mac ps still tells each open session's process, once for each
      // adapter. On Linux it is asked only for Jump.
      expect(ps.runs, platform).toEqual(
        platform === "darwin"
          ? [
              [41001, 41004],
              [41001, 41004],
            ]
          : [],
      );
    }
  });

  test("the health of the source says nothing of Jump, found or not", async () => {
    const found = await qwenCodeAdapterFor(twoSessions(), {
      panes: knownPanes({ 41001: pane }),
      readProcessStarts: ownStarts().read,
    }).poll();
    const without = await qwenCodeAdapterFor(twoSessions()).poll();

    expect(found.health).toEqual(without.health);
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
    // Its process runs on with the new session, so the one before names no process that ended.
    expect(sessions[0]).toMatchObject({ pid: 41001, alive: true });
    expect(sessions[1]).not.toHaveProperty("pid");
    expect(sessions[1]).not.toHaveProperty("alive");
  });

  test("after /clear in a Qwen Code open for days, the new session counts from the clear", async () => {
    const files = memoryFiles();
    const startedAt = NOW - 2 * DAY;
    addSession(files, { pid: 41001, sessionId: ID, startedAt, lines: [promptLine(NOW - MINUTE)] });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    const record = (sessionId: string) =>
      registryRecord({ pid: 41001, sessionId, startedAt, kind: "tui" });
    files.rewrite(recordPath(QWEN_DIR, "41001.json"), record(sessionIdOf(7)));
    clock.set(NOW + NO_CHAT_AFTER_MS - 1);
    const cleared = await adapter.poll();
    // Idle since the last poll that found the session before, which is not stale, and no chat file is missed yet.
    expect(cleared.sessions[0]).toMatchObject({
      id: `qwen-code:${sessionIdOf(7)}`,
      status: "idle",
      statusSince: NOW,
      startedAt: NOW,
      stale: false,
    });
    expect(cleared.health.detail).toBe(healthy());

    // Its first prompt is its own.
    const prompt = NOW + NO_CHAT_AFTER_MS;
    files.write(chatPath(QWEN_DIR, sessionIdOf(7)), chatFile(promptLine(prompt)));
    clock.set(prompt + 2_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: prompt,
    });

    // /resume of a session last used before this Qwen Code started is idle since the resume.
    addSession(files, {
      pid: 41001,
      sessionId: sessionIdOf(8),
      startedAt,
      lines: [promptLine(NOW - 3 * DAY), assistantLine(NOW - 3 * DAY + 5_000)],
    });
    clock.set(prompt + 4_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      id: `qwen-code:${sessionIdOf(8)}`,
      status: "idle",
      statusSince: prompt + 2_000,
      stale: false,
    });
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

  test("a session whose Qwen Code crashes while it asks is finished, and needs you no more", async () => {
    const { files, clock, processes, adapter } = setUp();
    files.append(
      chatPath(QWEN_DIR, ID),
      lifecycleLine(NOW - 30_000, "ended") +
        assistantLine(NOW - 30_000, { asks: "ask_user_question" }),
      { mtimeMs: NOW + 1 },
    );
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    processes.stop(41001);
    clock.advance(2_000);
    const [closed] = (await adapter.poll()).sessions;
    expect(closed).toMatchObject({ status: "finished", statusSince: NOW + 2_000, alive: false });
    expect(closed).not.toHaveProperty("waitingReason");
  });

  test("a record a crash left behind while it asked is finished at the first poll", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41005,
      sessionId: sessionIdOf(5),
      startedAt: NOW - 3 * 60 * MINUTE,
      lines: [
        promptLine(NOW - 2 * 60 * MINUTE),
        lifecycleLine(NOW - 2 * 60 * MINUTE + 5 * SECOND, "ended"),
        assistantLine(NOW - 2 * 60 * MINUTE + 5 * SECOND, { asks: "exit_plan_mode" }),
      ],
      mtimeMs: NOW - 2 * 60 * MINUTE + 5 * SECOND,
    });
    const adapter = qwenCodeAdapterFor(files, { isAlive: () => false });
    const [leftBehind] = (await adapter.poll()).sessions;
    expect(leftBehind).toMatchObject({ status: "finished", alive: false });
    expect(leftBehind).not.toHaveProperty("waitingReason");
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

describe("a record whose pid another program was given", () => {
  const REGISTERED = NOW - 30 * MINUTE;
  const asked = (ask: string) => [
    promptLine(NOW - 2 * MINUTE),
    lifecycleLine(NOW - MINUTE, "ended"),
    assistantLine(NOW - MINUTE, { asks: ask }),
  ];

  /** Two sessions written on Linux, at pids 41001 and 41004, each with its start token. */
  function linuxSessions(more: { pidNs?: number } = {}) {
    const files = memoryFiles();
    for (const [pid, n, ticks] of [
      [41001, 1, 500],
      [41004, 4, 900],
    ] as const) {
      addSession(files, {
        pid,
        sessionId: sessionIdOf(n),
        startedAt: REGISTERED,
        procStart: startToken(ticks),
        pidNs: more.pidNs ?? PID_NAMESPACE,
        lines: [promptLine(NOW - MINUTE, { sessionId: sessionIdOf(n) })],
      });
    }
    return files;
  }

  const onLinux = (tokens: ReturnType<typeof standInTokens>, more: object = {}) => ({
    platform: "linux" as const,
    readStartTokens: tokens.read,
    readPidNamespace: async () => PID_NAMESPACE,
    ...more,
  });

  const statuses = (sessions: { id: string; status: string; alive?: boolean }[]) =>
    sessions.map((session) => [session.id, session.status, session.alive]);

  test("on Linux, a session whose process has its token is open, and one whose pid another program has is finished", async () => {
    const tokens = standInTokens({ 41001: startToken(500), 41004: startToken(77_000) });
    const { sessions } = await qwenCodeAdapterFor(linuxSessions(), onLinux(tokens)).poll();

    expect(statuses(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, "working", true],
      [`qwen-code:${sessionIdOf(4)}`, "finished", false],
    ]);
    // One read for both, and only the records' own pids.
    expect(tokens.reads).toEqual([[41001, 41004]]);
  });

  test("on Linux, a token from before the computer restarted is another process's", async () => {
    const restarted = startToken(500, "00000000-0000-4000-8000-00000000b002");
    const tokens = standInTokens({ 41001: restarted, 41004: startToken(900) });
    const { sessions } = await qwenCodeAdapterFor(linuxSessions(), onLinux(tokens)).poll();

    expect(statuses(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(4)}`, "working", true],
      [`qwen-code:${sessionIdOf(1)}`, "finished", false],
    ]);
  });

  test("on Linux, a token that cannot be read keeps the session open, as Qwen Code keeps its record", async () => {
    const tokens = standInTokens({ 41004: startToken(900) });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(linuxSessions(), onLinux(tokens, { now: clock.now }));
    expect(statuses((await adapter.poll()).sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, "working", true],
      [`qwen-code:${sessionIdOf(4)}`, "working", true],
    ]);

    tokens.fails = true;
    clock.advance(30 * SECOND);
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual([
      "working",
      "working",
    ]);
    expect(tokens.reads).toHaveLength(2);
  });

  test("on Linux, a session seen open is finished once its pid goes to another program, and stays finished", async () => {
    const files = linuxSessions();
    const tokens = standInTokens({ 41001: startToken(500), 41004: startToken(900) });
    const processes = standInProcesses([41001, 41004]);
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(
      files,
      onLinux(tokens, { now: clock.now, isAlive: processes.isAlive }),
    );
    await adapter.poll();

    // Qwen Code crashes, so its record stays, and later another program gets its pid.
    processes.stop(41001);
    clock.advance(2_000);
    const closed = await adapter.poll();
    expect(closed.sessions[1]).toMatchObject({ status: "finished", statusSince: NOW + 2_000 });

    processes.start(41001);
    tokens.tokens.set(41001, startToken(64_000));
    clock.advance(30 * SECOND);
    const later = await adapter.poll();
    expect(statuses(later.sessions)).toEqual([
      [`qwen-code:${sessionIdOf(4)}`, "working", true],
      [`qwen-code:${sessionIdOf(1)}`, "finished", false],
    ]);
    expect(later.sessions[1]).toMatchObject({ statusSince: NOW + 2_000 });
  });

  test("on Linux, the tokens are read only for records whose pid runs, at most once in 30 seconds", async () => {
    const tokens = standInTokens({ 41001: startToken(500) });
    const clock = handClock();
    const adapter = qwenCodeAdapterFor(
      linuxSessions(),
      onLinux(tokens, { now: clock.now, isAlive: (pid: number) => pid === 41001 }),
    );
    for (let polls = 0; polls < 10; polls += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    expect(tokens.reads).toEqual([[41001]]);
  });

  test("on Linux, a record from another pid namespace is not listed, and the Sources view says so", async () => {
    const tokens = standInTokens({ 41001: startToken(500), 41004: startToken(900) });
    const container = await qwenCodeAdapterFor(
      linuxSessions({ pidNs: 4026532001 }),
      onLinux(tokens),
    ).poll();
    expect(container.sessions).toEqual([]);
    expect(container.health.detail).toBe(`${healthy()} ${ELSEWHERE_NOTE}`);
    expect(tokens.reads).toEqual([]);

    // While Agent Lookout's own namespace cannot be read, none is left out.
    const unread = await qwenCodeAdapterFor(
      linuxSessions({ pidNs: 4026532001 }),
      onLinux(tokens, { readPidNamespace: async () => null }),
    ).poll();
    expect(unread.sessions.map((session) => session.status)).toEqual(["working", "working"]);
  });

  test("on Linux, a record that names no namespace, as one written on a Mac or Windows, is not listed, and the Sources view says so", async () => {
    const files = memoryFiles();
    addSession(files, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const tokens = standInTokens({ 41001: startToken(500) });
    const shared = await qwenCodeAdapterFor(files, onLinux(tokens)).poll();

    expect(shared.sessions).toEqual([]);
    expect(shared.health.detail).toBe(`${healthy()} ${ELSEWHERE_NOTE}`);
    expect(tokens.reads).toEqual([]);

    // While Agent Lookout's own namespace cannot be read, it is listed.
    const unread = await qwenCodeAdapterFor(
      files,
      onLinux(tokens, { readPidNamespace: async () => null }),
    ).poll();
    expect(statuses(unread.sessions)).toEqual([[`qwen-code:${ID}`, "working", true]]);
  });

  test("on Linux, a record of this namespace with no token is checked with signal 0 alone", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      pidNs: PID_NAMESPACE,
      lines: [promptLine(NOW - MINUTE)],
    });
    const tokens = standInTokens({ 41001: startToken(500) });
    const { sessions } = await qwenCodeAdapterFor(files, onLinux(tokens)).poll();

    expect(statuses(sessions)).toEqual([[`qwen-code:${ID}`, "working", true]]);
    expect(tokens.reads).toEqual([]);
  });

  test("of two records of one session, the one whose process runs is listed over a newer one whose pid another program has", async () => {
    // On Linux, by its token.
    const files = memoryFiles();
    addSession(files, {
      pid: 41004,
      sessionId: ID,
      startedAt: REGISTERED,
      procStart: startToken(900),
      pidNs: PID_NAMESPACE,
      lines: [promptLine(NOW - MINUTE)],
    });
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      startedAt: NOW - 10 * MINUTE,
      procStart: startToken(500),
      pidNs: PID_NAMESPACE,
    });
    const tokens = standInTokens({ 41001: startToken(64_000), 41004: startToken(900) });
    const linux = await qwenCodeAdapterFor(files, onLinux(tokens)).poll();

    // On a Mac, by when ps says each process started.
    const mac = memoryFiles();
    addSession(mac, {
      pid: 41004,
      sessionId: ID,
      startedAt: REGISTERED,
      lines: [promptLine(NOW - MINUTE)],
    });
    addSession(mac, { pid: 41001, sessionId: ID, startedAt: NOW - 10 * MINUTE });
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE, 41004: REGISTERED - 2 * SECOND });
    const darwin = await qwenCodeAdapterFor(mac, { readProcessStarts: ps.read }).poll();

    for (const { sessions } of [linux, darwin]) {
      expect(sessions).toMatchObject([
        { id: `qwen-code:${ID}`, status: "working", alive: true, pid: 41004 },
      ]);
    }
  });

  test("a new record at a pid already found another program's is not held closed", async () => {
    const newLines = [promptLine(NOW, { sessionId: sessionIdOf(2) })];

    // On Linux, by its token.
    const linuxFiles = memoryFiles();
    addSession(linuxFiles, {
      pid: 41001,
      sessionId: ID,
      startedAt: REGISTERED,
      procStart: startToken(500),
      pidNs: PID_NAMESPACE,
    });
    const tokens = standInTokens({ 41001: startToken(64_000) });
    const linuxClock = handClock();
    const linux = qwenCodeAdapterFor(linuxFiles, onLinux(tokens, { now: linuxClock.now }));

    // On a Mac, by when ps says its process started.
    const macFiles = memoryFiles();
    addSession(macFiles, { pid: 41001, sessionId: ID, startedAt: REGISTERED });
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE });
    const macClock = handClock();
    const darwin = qwenCodeAdapterFor(macFiles, {
      now: macClock.now,
      readProcessStarts: ps.read,
    });

    for (const adapter of [linux, darwin]) {
      expect((await adapter.poll()).sessions).toMatchObject([{ status: "finished", alive: false }]);
    }

    // The pid's new owner is Qwen Code, which writes a new record at the same name.
    linuxFiles.rewrite(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({
        pid: 41001,
        sessionId: sessionIdOf(2),
        startedAt: NOW + SECOND,
        kind: "tui",
        procStart: startToken(70_000),
        pidNs: PID_NAMESPACE,
      }),
    );
    linuxFiles.write(chatPath(QWEN_DIR, sessionIdOf(2)), chatFile(...newLines));
    tokens.tokens.set(41001, startToken(70_000));
    linuxClock.advance(2 * SECOND);

    macFiles.rewrite(
      recordPath(QWEN_DIR, "41001.json"),
      registryRecord({
        pid: 41001,
        sessionId: sessionIdOf(2),
        startedAt: NOW + SECOND,
        kind: "tui",
      }),
    );
    macFiles.write(chatPath(QWEN_DIR, sessionIdOf(2)), chatFile(...newLines));
    ps.starts.set(41001, NOW);
    macClock.advance(2 * SECOND);

    for (const adapter of [linux, darwin]) {
      const { sessions } = await adapter.poll();
      expect(
        sessions.find((session) => session.id === `qwen-code:${sessionIdOf(2)}`),
      ).toMatchObject({ status: "working", alive: true, pid: 41001 });
    }
  });

  test.each(["ask_user_question", "exit_plan_mode"])(
    "a session that crashed while it asked, with %s, and whose pid another program has, is finished, on Linux and on a Mac",
    async (ask) => {
      const files = memoryFiles();
      addSession(files, {
        pid: 41001,
        sessionId: ID,
        startedAt: REGISTERED,
        procStart: startToken(500),
        pidNs: PID_NAMESPACE,
        lines: asked(ask),
        mtimeMs: NOW - MINUTE,
      });
      const tokens = standInTokens({ 41001: startToken(64_000) });
      const linux = await qwenCodeAdapterFor(files, onLinux(tokens)).poll();

      const mac = memoryFiles();
      addSession(mac, {
        pid: 41001,
        sessionId: ID,
        startedAt: REGISTERED,
        lines: asked(ask),
        mtimeMs: NOW - MINUTE,
      });
      const ps = standInStarts({ 41001: NOW - 5 * MINUTE });
      const darwin = await qwenCodeAdapterFor(mac, { readProcessStarts: ps.read }).poll();

      for (const { sessions } of [linux, darwin]) {
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          status: "finished",
          statusSince: NOW - MINUTE,
          alive: false,
        });
        expect(sessions[0]).not.toHaveProperty("waitingReason");
      }
    },
  );

  test("a record found to be another program's stays finished while its pid runs, though a later check cannot answer", async () => {
    // On Linux, by its token.
    const tokens = standInTokens({ 41001: startToken(500), 41004: startToken(64_000) });
    const linuxClock = handClock();
    const linux = qwenCodeAdapterFor(linuxSessions(), onLinux(tokens, { now: linuxClock.now }));
    // On a Mac, by when ps says its process started.
    const mac = memoryFiles();
    addSession(mac, { pid: 41001, sessionId: ID, lines: [promptLine(NOW - MINUTE)] });
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE });
    const macClock = handClock();
    const darwin = qwenCodeAdapterFor(mac, { now: macClock.now, readProcessStarts: ps.read });

    const before = [(await linux.poll()).sessions, (await darwin.poll()).sessions];
    tokens.fails = true;
    ps.fails = true;
    linuxClock.advance(30 * SECOND);
    macClock.advance(30 * SECOND);
    const after = [(await linux.poll()).sessions, (await darwin.poll()).sessions];

    expect(after).toEqual(before);
    expect(after.flat().filter((session) => session.status === "finished")).toHaveLength(2);
    expect(tokens.reads).toHaveLength(2);
    expect(ps.runs).toHaveLength(2);
  });

  test("on a Mac, a session ps says started by its record's time is open, one that started after is finished, and one ps cannot tell is open", async () => {
    const files = memoryFiles();
    for (const n of [1, 4, 6]) {
      addSession(files, {
        pid: 41000 + n,
        sessionId: sessionIdOf(n),
        startedAt: REGISTERED,
        lines: [promptLine(NOW - MINUTE, { sessionId: sessionIdOf(n) })],
      });
    }
    const ps = standInStarts({ 41001: REGISTERED - 2 * SECOND, 41004: REGISTERED + 10 * MINUTE });
    const { sessions } = await qwenCodeAdapterFor(files, { readProcessStarts: ps.read }).poll();

    expect(statuses(sessions)).toEqual([
      [`qwen-code:${sessionIdOf(1)}`, "working", true],
      [`qwen-code:${sessionIdOf(6)}`, "working", true],
      [`qwen-code:${sessionIdOf(4)}`, "finished", false],
    ]);
    expect(ps.runs).toEqual([[41001, 41004, 41006]]);

    // With no answer from ps, every session stays as signal 0 says.
    ps.fails = true;
    const failed = await qwenCodeAdapterFor(files, { readProcessStarts: ps.read }).poll();
    expect(failed.sessions.map((session) => session.status)).toEqual([
      "working",
      "working",
      "working",
    ]);
  });

  test("on Windows nothing is compared: a session whose pid runs is open, and neither ps nor /proc is asked", async () => {
    const files = memoryFiles();
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      startedAt: REGISTERED,
      lines: asked("ask_user_question"),
    });
    const ps = standInStarts({ 41001: NOW - 5 * MINUTE });
    const tokens = standInTokens({ 41001: startToken(64_000) });
    const { sessions } = await qwenCodeAdapterFor(files, {
      platform: "win32",
      readProcessStarts: ps.read,
      readStartTokens: tokens.read,
    }).poll();

    expect(sessions).toMatchObject([{ status: "needs-you", alive: true }]);
    expect(ps.runs).toEqual([]);
    expect(tokens.reads).toEqual([]);
  });

  test.each(["darwin", "win32"] as const)(
    "on %s, the pid namespace is never looked up",
    async (platform) => {
      const files = memoryFiles();
      addSession(files, {
        pid: 41001,
        sessionId: ID,
        procStart: startToken(500),
        pidNs: PID_NAMESPACE,
      });
      let lookups = 0;
      const adapter = qwenCodeAdapterFor(files, {
        platform,
        readPidNamespace: async () => {
          lookups += 1;
          return PID_NAMESPACE;
        },
      });
      await adapter.poll();
      await adapter.poll();

      expect(lookups).toBe(0);
    },
  );

  test("Sources names the check each system makes", async () => {
    const sourcesOf = async (platform: NodeJS.Platform) =>
      (await qwenCodeAdapterFor(memoryFiles(), { platform }).poll()).health.watching?.filter(
        (fact) => fact.label.startsWith("Process check"),
      );

    expect(await sourcesOf("darwin")).toEqual([
      { label: "Process check", value: MAC_PROCESS_CHECK },
      { label: "Process check run", value: PROCESS_CHECK_RUN },
    ]);
    expect(await sourcesOf("linux")).toEqual([
      { label: "Process check", value: LINUX_PROCESS_CHECK },
      { label: "Process check run", value: PROCESS_CHECK_RUN },
    ]);
    expect(await sourcesOf("win32")).toEqual([
      { label: "Process check", value: "signal 0 alone, every 2 seconds" },
    ]);
  });
});

describe("what a session last said", () => {
  const SAID = `qwen-code:${ID}`;
  const FILE = chatPath(QWEN_DIR, ID);

  /** A session whose newest reply with text is followed by one that only calls a tool, and its result. */
  function saying(options: Parameters<typeof qwenCodeAdapterFor>[1] = {}) {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    const processes = standInProcesses([41001]);
    addSession(files, {
      pid: 41001,
      sessionId: ID,
      lines: [
        promptLine(NOW - 2 * MINUTE),
        assistantLine(NOW - MINUTE, { says: "The reply." }),
        assistantLine(NOW - 30 * SECOND, { parts: [{ functionCall: { name: "read_file" } }] }),
        toolResultLine(NOW - 20 * SECOND),
      ],
      mtimeMs: NOW - 20 * SECOND,
    });
    const adapter = qwenCodeAdapterFor(files, {
      now: clock.now,
      isAlive: processes.isAlive,
      ...options,
    });
    return { clock, files, processes, adapter };
  }

  test("is the newest reply's text for a listed session, read from its chat file only when asked", async () => {
    const { adapter, files } = saying();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    await adapter.poll();
    files.forget();
    const answer = await adapter.lastMessage(SAID);
    expect(answer).toEqual({ message: { text: "The reply.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
    files.forget();
    await expect(adapter.lastMessage(`qwen-code:${sessionIdOf(9)}`)).resolves.toBeNull();
    await expect(adapter.lastMessage(`codex:${ID}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a poll reads the chat files as it does with the reader off, and puts no message on a session", async () => {
    const on = saying();
    const off = saying({ env: { AGENT_LOOKOUT_LAST_MESSAGE: "off" } });
    const [onResult] = [await on.adapter.poll(), await off.adapter.poll()];
    expect(on.files.count("openRegular")).toBeGreaterThan(0);
    expect(on.files.count("openRegular")).toBe(off.files.count("openRegular"));
    expect(on.files.reads).toEqual(off.files.reads);
    expect(JSON.stringify(onResult?.sessions)).not.toContain("The reply.");
  });

  test("Sources says it reads the end of a session's chat file while its details are open", async () => {
    const { adapter } = saying();
    expect((await adapter.poll()).health.watching).toContainEqual({
      label: "Last message read",
      value: "end of a session's chat file, while its details are open",
    });
  });

  test.each([
    [{ AGENT_LOOKOUT_LAST_MESSAGE: "off" }, "AGENT_LOOKOUT_LAST_MESSAGE"],
    [{ AGENT_LOOKOUT_WAITING_TEXT: "off" }, "AGENT_LOOKOUT_WAITING_TEXT"],
  ])("with %j, is off by that setting, and no chat file is opened for it", async (env, setting) => {
    const { adapter, files } = saying({ env });
    const result = await adapter.poll();
    expect(result.health.watching).toContainEqual({ label: "Last message read", value: "Off" });
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: null,
      reason: "off",
      setting,
    });
    expect(files.calls).toEqual([]);
    expect(adapter.lastMessagesKept).toBe(0);
  });

  test("a listed session with no chat file yet is not found, and no file is opened for it", async () => {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    addSession(files, { pid: 41001, sessionId: ID });
    const adapter = qwenCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: null,
      reason: "not-found",
    });
    expect(files.calls).toEqual([]);
  });

  test("a session shown as finished is still read, from the chat file last found for it, until it leaves the list", async () => {
    const { adapter, clock, files, processes } = saying();
    await adapter.poll();
    processes.stop(41001);
    clock.advance(2 * SECOND);
    const closed = await adapter.poll();
    expect(closed.sessions.find((session) => session.id === SAID)?.status).toBe("finished");
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);

    // A day on, it has left the list, and nothing of it is kept or read.
    clock.advance(DAY);
    expect((await adapter.poll()).sessions.map((session) => session.id)).not.toContain(SAID);
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a record a crash left behind, found at the first poll, is read from the file in the folder named for its folder", async () => {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    addSession(files, {
      pid: 41005,
      sessionId: ID,
      lines: [promptLine(NOW - 2 * MINUTE), assistantLine(NOW - MINUTE, { says: "Before it." })],
      mtimeMs: NOW - MINUTE,
    });
    const adapter = qwenCodeAdapterFor(files, { now: clock.now, isAlive: () => false });
    const result = await adapter.poll();
    expect(result.sessions.find((session) => session.id === SAID)?.status).toBe("finished");
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "Before it.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);
  });

  test("keeps none once the session leaves the list, or after a poll that cannot read the list", async () => {
    const { adapter, clock, files } = saying();
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    files.fail(SESSIONS);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("error");
    expect(adapter.lastMessagesKept).toBe(0);
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
  });

  test("a session shown as finished is still read from the file found while it was open after a poll that could not read the list", async () => {
    const { adapter, clock, files, processes } = saying();
    await adapter.poll();
    processes.stop(41001);
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });

    files.fail(SESSIONS);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("error");
    files.heal(SESSIONS);
    clock.advance(SECOND);
    const again = await adapter.poll();
    expect(again.sessions.map((session) => [session.id, session.status])).toEqual([
      [SAID, "finished"],
    ]);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("a session that closes while the list cannot be read is read, once shown as finished, from the file found while it was open", async () => {
    const { adapter, clock, files, processes } = saying();
    await adapter.poll();
    files.fail(SESSIONS);
    processes.stop(41001);
    clock.advance(SECOND);
    expect((await adapter.poll()).health.state).toBe("error");
    files.heal(SESSIONS);
    clock.advance(SECOND);
    const again = await adapter.poll();
    expect(again.sessions.map((session) => [session.id, session.status])).toEqual([
      [SAID, "finished"],
    ]);
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("is dropped, and nothing may be read, after a poll that throws, and is read again once a poll lists the session", async () => {
    let broken = false;
    const processes = standInProcesses([41001]);
    const { adapter, clock, files } = saying({
      isAlive: (pid) => {
        if (broken) throw new Error("A stand-in that throws.");
        return processes.isAlive(pid);
      },
    });
    await adapter.poll();
    await adapter.lastMessage(SAID);
    expect(adapter.lastMessagesKept).toBe(1);

    broken = true;
    clock.advance(SECOND);
    const failed = await adapter.poll();
    expect(failed.health.state).toBe("error");
    expect(failed.health.detail).toBe(
      "Something unexpected went wrong while reading Qwen Code sessions.",
    );
    expect(adapter.lastMessagesKept).toBe(0);
    files.forget();
    await expect(adapter.lastMessage(SAID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    broken = false;
    clock.advance(SECOND);
    await adapter.poll();
    await expect(adapter.lastMessage(SAID)).resolves.toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("counts its reads against the limits the collector shares", async () => {
    const limits = createTailLimits();
    let asked = 0;
    const lastMessageLimits = {
      ...limits,
      mayRead(at: number) {
        asked += 1;
        return limits.mayRead(at);
      },
    };
    const { adapter } = saying({ lastMessageLimits });
    await adapter.poll();
    expect(asked).toBe(0);
    await adapter.lastMessage(SAID);
    expect(asked).toBe(1);
  });
});
