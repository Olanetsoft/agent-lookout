import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createCollector } from "@collector/collector";
import { MAX_JUMP_BODY_BYTES } from "@collector/jumpRoute";
import { createPidNamespaceRead } from "@collector/processes/linuxProcesses";
import { focusTabArgs, ITERM_SCRIPT, TERMINAL_SCRIPT } from "@collector/terminal/focusTab";
import { TAB_LOOK_SOONEST_MS } from "@collector/terminal/tabFinder";
import { PANE_LOOK_INTERVAL_MS, PANE_LOOK_SOONEST_MS } from "@collector/tmux/paneFinder";
import { LIST_CLIENTS_ARGS, describePaneArgs } from "@collector/tmux/selectPane";
import { JUMP_INTERVAL_MS } from "@core/api";
import type { Session, SessionsSnapshot, SourceHealth } from "@core/sessions/session";
import { lstart } from "@tests/fixtures/antigravity";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { NOW as CODEX_NOW } from "@tests/fixtures/codex";
import { registryRecord as qwenRecord, sessionIdOf } from "@tests/fixtures/qwen-code/qwenCode";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import {
  CODEX_FIXTURE_HOME,
  makeClaudeHome,
  NO_SETTINGS_FILE,
  tempDir,
} from "@tests/support/node/tempFiles";
import {
  fakeOsascript,
  fakeProcesses,
  ITERM_PATH,
  MISSING,
  NOT_ALLOWED,
  TERMINAL_PATH,
  TIMED_OUT,
  type ProcessRow,
} from "@tests/support/node/terminal";
import { startStandIn } from "@tests/support/node/standIns";
import {
  fakeTmux,
  PANE_CHECK,
  PANE_CHECK_RUN,
  PANE_PARENT_CHECK,
  PANE_PARENT_CHECK_RUN,
} from "@tests/support/node/tmux";

const T0 = 1_700_000_100_000;

/** The session whose process is this test's own, so it is alive for as long as the test runs. */
const SESSION = `claude-code:${ids.busy}`;
/** A second session, whose process is this one's parent: alive, and in no pane the fake tmux lists. */
const ELSEWHERE = `claude-code:${ids.idle}`;

/** The registry's files for those two. Neither records a start time, so `ps` has nothing to refute. */
function registry(): Record<string, string> {
  return {
    [`${process.pid}.json`]: registryFile({
      pid: process.pid,
      sessionId: ids.busy,
      name: "checkout-flow",
      entrypoint: "cli",
      procStart: undefined,
    }),
    [`${process.ppid}.json`]: registryFile({
      pid: process.ppid,
      sessionId: ids.idle,
      name: "docs-site",
      entrypoint: "cli",
      status: "idle",
      procStart: undefined,
    }),
  };
}

/** When the Qwen Code session's process registered it, as its record says. */
const QWEN_REGISTERED = T0 - 30 * 60_000;
const QWEN_ID = sessionIdOf(21);
const QWEN_SESSION = `qwen-code:${QWEN_ID}`;

/** The soonest both finders look again for a process that has turned up. */
const SOONEST_MS = Math.max(PANE_LOOK_SOONEST_MS, TAB_LOOK_SOONEST_MS);

/**
 * A Qwen Code folder that lists one session in a terminal, whose process is
 * `pid`, in this process's pid namespace, with none where it has none: on
 * Linux the adapter reads its own, and lists no record that names no other.
 */
async function qwenHome(pid: number): Promise<string> {
  const home = await tempDir();
  const pidNs = await createPidNamespaceRead()();
  await mkdir(path.join(home, "sessions"));
  await writeFile(
    path.join(home, "sessions", `${pid}.json`),
    qwenRecord({ pid, sessionId: QWEN_ID, kind: "tui", startedAt: QWEN_REGISTERED, pidNs }),
  );
  return home;
}

/** A process in a tab of the app of its own: the app, a login and a shell on the tab's terminal. */
function inTabOf(app: string, pid: number): ProcessRow[] {
  return [
    [700, 1, "??", app],
    [701, 700, "ttys009", "/usr/bin/login"],
    [702, 701, "ttys009", "-zsh"],
    [pid, 702, "ttys009", "node"],
  ];
}

/**
 * The processes `ps` would list with both sessions in one tab of the app: the
 * app, a login and a shell on the tab's terminal, this test's parent, the
 * docs-site session, and this test, the checkout-flow session, which is in a
 * tmux pane as well.
 */
function inOneTab(app: string): ProcessRow[] {
  return [
    [600, 1, "??", app],
    [601, 600, "ttys004", "/usr/bin/login"],
    [602, 601, "ttys004", "-zsh"],
    [process.ppid, 602, "ttys004", "node"],
    [process.pid, process.ppid, "ttys004", "node"],
  ];
}

/**
 * The collector as every host builds it, with its real Claude Code adapter
 * reading a folder of the test's own, a tmux that runs nothing: it lists one
 * pane, whose process is this test's, and any more a test names, and writes
 * down what it is asked, a table of processes of the test's own, a `ps` of
 * start times that says each process started when a test says, by default a
 * moment before the Qwen Code session's record was written, and an osascript
 * that runs nothing and writes down what it is asked. Served over real HTTP on
 * a free loopback port.
 */
async function serve(
  env: Record<string, string> = {},
  processes: ProcessRow[] = [],
  more: { panes?: string[]; startedAt?: number } = {},
) {
  const tmux = fakeTmux({
    panes: [`${process.pid} %7 2 1 checkout-flow`, ...(more.panes ?? [])],
    where: "$0 2 1 checkout-flow",
    clients: ["$0 /dev/ttys003", "$4 /dev/ttys004"],
  });
  const osascript = fakeOsascript();
  const ps = fakeProcesses(processes);
  const clock = { now: T0 };
  const startedAt = more.startedAt ?? QWEN_REGISTERED - 2_000;
  const starts: number[][] = [];
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: await tempDir(),
      AGENT_LOOKOUT_VIBE_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_GEMINI_CLI_HOME: await tempDir(),
      AGENT_LOOKOUT_OPENCODE_HOME: await tempDir(),
      AGENT_LOOKOUT_QWEN_HOME: await tempDir(),
      AGENT_LOOKOUT_HERMES_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      ...env,
    },
    notifier: fakeSystemNotifier(),
    tmux: tmux.run,
    osascript: osascript.run,
    readProcesses: ps.read,
    readProcessStarts: async (pids) => {
      starts.push([...pids]);
      return new Map(pids.map((pid) => [pid, lstart(startedAt)]));
    },
    now: () => clock.now,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  const jump = (sessionId: unknown = SESSION, options: TestRequest = {}) =>
    jumpRequest(port, sessionId, options);
  const sessions = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sessions;
  const sources = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sources;
  /** What tmux was asked after the first look for panes. */
  const asked = () => tmux.ran.slice(1);

  return { port, tmux, osascript, ps, starts, clock, collector, jump, sessions, sources, asked };
}

/** What a source's card says of tmux and its `ps`. */
const paneRowsOf = (sources: readonly SourceHealth[], id: string) =>
  sources
    .find((source) => source.id === id)
    ?.watching?.filter((fact) => fact.label.startsWith("Pane "));

/** The rows of a card whose sessions tmux and `ps` have been asked about. */
const RAN = [
  { label: "Pane check", value: PANE_CHECK },
  { label: "Pane check run", value: PANE_CHECK_RUN },
  { label: "Pane parent check", value: PANE_PARENT_CHECK },
  { label: "Pane parent check run", value: PANE_PARENT_CHECK_RUN },
];

/** The rows of a card whose sessions neither has been asked about. */
const NOT_RUN = [
  { label: "Pane check", value: PANE_CHECK },
  { label: "Pane check run", value: "not run" },
  { label: "Pane parent check", value: PANE_PARENT_CHECK },
  { label: "Pane parent check run", value: "not run" },
];

/** The request the dashboard's page makes for a jump, changed as a test says. */
function jumpRequest(port: number, sessionId: unknown, options: TestRequest = {}) {
  return request(port, "/api/jump", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
    ...options,
    headers: {
      Origin: `http://localhost:${port}`,
      "Content-Type": "application/json",
      "X-Agent-Lookout-Action": "jump",
      ...options.headers,
    },
  });
}

const named = (sessions: Session[], name: string) =>
  sessions.find((session) => session.name === name);

// The stand-in tmux is a POSIX sh script, and tmux is never run on Windows.
const posixTest = test.skipIf(process.platform === "win32");

/**
 * A stand-in `tmux`, alone in a folder of its own, that leaves a mark each time
 * it is started and, asked for its panes, lists these. A program written
 * moments ago can take seconds to start the first time on a busy machine, more
 * than the 2 seconds tmux is given, so it is started once here, with no limit,
 * and the mark that leaves is removed.
 */
async function stubTmux(panes: string[]): Promise<{ bin: string; mark: string }> {
  const folder = await tempDir();
  const bin = path.join(folder, "bin");
  const mark = path.join(folder, "ran");
  await mkdir(bin);
  const file = path.join(bin, "tmux");
  const listed = panes.map((pane) => `  echo '${pane}'`).join("\n");
  await writeFile(
    file,
    `#!/bin/sh\n: > '${mark}'\nif [ "$2" = list-panes ]; then\n${listed}\nfi\n`,
  );
  await chmod(file, 0o755);
  execFileSync(file);
  await rm(mark);
  return { bin, mark };
}

/**
 * The collector as every host builds it, with the Claude Code sessions of
 * `serve` and, given a pid, a Qwen Code session whose process it is, and with
 * tmux run as the collector runs it, found on a `PATH` that holds only a
 * stand-in. That lists a pane for this test's process and one for the Qwen
 * Code session's. Polled twice, a look for a process that turned up apart, so
 * both adapters' processes are looked for.
 */
async function serveStubTmux(env: Record<string, string>, qwenPid?: number) {
  const panes = [`${process.pid} %7 2 1 checkout-flow`];
  if (qwenPid !== undefined) panes.push(`${qwenPid} %8 0 0 search-indexing`);
  const tmux = await stubTmux(panes);
  const clock = { now: T0 };
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: await tempDir(),
      AGENT_LOOKOUT_VIBE_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_GEMINI_CLI_HOME: await tempDir(),
      AGENT_LOOKOUT_OPENCODE_HOME: await tempDir(),
      AGENT_LOOKOUT_QWEN_HOME: qwenPid === undefined ? await tempDir() : await qwenHome(qwenPid),
      AGENT_LOOKOUT_HERMES_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      PATH: tmux.bin,
      ...env,
    },
    notifier: fakeSystemNotifier(),
    osascript: fakeOsascript().run,
    readProcesses: fakeProcesses().read,
    readProcessStarts: async (pids) =>
      new Map(pids.map((pid) => [pid, lstart(QWEN_REGISTERED - 2_000)])),
    now: () => clock.now,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();
  clock.now += SOONEST_MS;
  await collector.poller.pollOnce();

  const sessions = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sessions;
  const sources = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sources;
  const jump = (sessionId: string) => jumpRequest(port, sessionId);
  return { mark: tmux.mark, sessions, sources, jump };
}

describe("what the dashboard is told", () => {
  test("a session whose process runs in a pane names the place, and the pane's id stays with the collector", async () => {
    const server = await serve();
    const response = await request(server.port, "/api/sessions");
    const { sessions } = response.json<SessionsSnapshot>();

    expect(named(sessions, "checkout-flow")?.jump).toEqual({
      kind: "tmux",
      place: "checkout-flow:2.1",
    });
    expect(response.body).not.toContain("%7");
  });

  test("a session in no pane has no jump", async () => {
    const server = await serve();
    const docs = named(await server.sessions(), "docs-site");

    expect(docs).toBeDefined();
    expect(docs).not.toHaveProperty("jump");
  });

  test("a Codex session has no jump, and asking for one finds no pane", async () => {
    const server = await serve({ AGENT_LOOKOUT_CODEX_HOME: CODEX_FIXTURE_HOME });
    server.clock.now = CODEX_NOW;
    await server.collector.poller.pollOnce();
    const codex = (await server.sessions()).filter((session) => session.source === "codex");

    expect(codex.length).toBeGreaterThan(0);
    for (const session of codex) expect(session).not.toHaveProperty("jump");

    const response = await server.jump(codex[0]?.id);
    expect(response.status).toBe(404);
    // tmux was asked where its panes are, and never to select one.
    expect(new Set(server.tmux.names())).toEqual(new Set(["list-panes"]));
  });

  test("a session from a status file has no jump, even when its process runs in a pane", async () => {
    const folder = await tempDir();
    await writeFile(
      path.join(folder, "night-shift.json"),
      JSON.stringify({
        agent: "Night Shift",
        name: "api-rate-limits",
        status: "working",
        pid: process.pid,
      }),
    );
    const server = await serve({ AGENT_LOOKOUT_STATUS_DIR: folder });
    const custom = named(await server.sessions(), "api-rate-limits");

    expect(custom).toMatchObject({ source: "status-files", pid: process.pid, alive: true });
    expect(custom).not.toHaveProperty("jump");

    const response = await server.jump(custom?.id);
    expect(response.status).toBe(404);
    expect(new Set(server.tmux.names())).toEqual(new Set(["list-panes"]));
  });

  posixTest(
    "with AGENT_LOOKOUT_TMUX off, the tmux on this machine is never run and no session has a jump",
    async () => {
      const server = await serveStubTmux({ AGENT_LOOKOUT_TMUX: "off" });
      const sessions = await server.sessions();

      expect(sessions.map((session) => session.name).sort()).toEqual([
        "checkout-flow",
        "docs-site",
      ]);
      for (const session of sessions) expect(session).not.toHaveProperty("jump");
      expect((await server.jump(SESSION)).status).toBe(404);
      expect(existsSync(server.mark)).toBe(false);
    },
  );

  posixTest(
    "without it, the same collector runs the tmux on its PATH, and the session in a pane has a jump",
    async () => {
      const server = await serveStubTmux({});

      expect(named(await server.sessions(), "checkout-flow")?.jump).toEqual({
        kind: "tmux",
        place: "checkout-flow:2.1",
      });
      expect(existsSync(server.mark)).toBe(true);
    },
  );

  posixTest(
    "with AGENT_LOOKOUT_TMUX off, no card lists tmux, and with it on Claude Code's says it ran",
    async () => {
      const off = await serveStubTmux({ AGENT_LOOKOUT_TMUX: "off" });
      expect(paneRowsOf(await off.sources(), "claude-code")).toEqual([]);
      expect(paneRowsOf(await off.sources(), "qwen-code")).toEqual([]);

      const on = await serveStubTmux({});
      expect(paneRowsOf(await on.sources(), "claude-code")).toEqual(RAN);
      expect(paneRowsOf(await on.sources(), "qwen-code")).toEqual(NOT_RUN);
    },
  );

  posixTest(
    "each card says what was asked for its own sessions, and reading it adds no run",
    async () => {
      const server = await serve();
      const looks = server.tmux.ran.length;
      const reads = server.ps.runs;

      expect(paneRowsOf(await server.sources(), "claude-code")).toEqual(RAN);
      expect(paneRowsOf(await server.sources(), "qwen-code")).toEqual(NOT_RUN);
      expect(server.tmux.ran).toHaveLength(looks);
      expect(server.ps.runs).toBe(reads);
    },
  );

  posixTest(
    "with no session both cards say not run, and looking for tmux starts nothing",
    async () => {
      const server = await serveStubTmux({ AGENT_LOOKOUT_CLAUDE_HOME: await tempDir() });

      expect(paneRowsOf(await server.sources(), "claude-code")).toEqual(NOT_RUN);
      expect(paneRowsOf(await server.sources(), "qwen-code")).toEqual(NOT_RUN);
      expect(existsSync(server.mark)).toBe(false);
    },
  );

  posixTest(
    "with AGENT_LOOKOUT_TERMINAL_JUMP off tmux still runs, so the card still says so",
    async () => {
      const server = await serve({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" });

      expect(server.tmux.names()).toEqual(["list-panes"]);
      expect(paneRowsOf(await server.sources(), "claude-code")).toEqual(RAN);
    },
  );
});

describe("POST /api/jump", () => {
  test("selects the pane the collector found for the session, and says where", async () => {
    const server = await serve();
    const response = await server.jump();

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, kind: "tmux", place: "checkout-flow:2.1" });
    // The window, the pane, where it is, who is attached, and the one client elsewhere.
    expect(server.asked()).toEqual([
      ["select-window", "-t", "%7"],
      ["select-pane", "-t", "%7"],
      describePaneArgs("%7"),
      [...LIST_CLIENTS_ARGS],
      ["switch-client", "-c", "/dev/ttys004", "-t", "%7"],
    ]);
  });

  test("answers as every route does: JSON, uncacheable and with no CORS header", async () => {
    const server = await serve();
    const response = await server.jump();

    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
  });

  test("says where the pane is now, when it has moved since the collector last looked", async () => {
    const server = await serve();
    server.tmux.where = "$0 5 0 billing-webhooks";

    expect((await server.jump()).json()).toEqual({
      ok: true,
      kind: "tmux",
      place: "billing-webhooks:5.0",
    });
  });

  test.each([
    ["no session the collector lists", "claude-code:00000000-0000-4000-8000-00000000ffff"],
    ["a session in no pane", ELSEWHERE],
    ["a pane's id, as if the page could choose the pane", "%7"],
    ["a command", "checkout-flow; tmux kill-server"],
    ["an option", "-t %7"],
  ])("a body that names %s finds no pane, and tmux is not run", async (_what, sessionId) => {
    const server = await serve();
    const response = await server.jump(sessionId);

    expect(response.status).toBe(404);
    expect(response.json()).toEqual({
      error: "No tmux pane or terminal tab is known for that session.",
      reason: "no-pane",
    });
    expect(server.asked()).toEqual([]);
  });

  test.each([
    ["is not JSON", "sessionId=claude-code"],
    ["is empty", ""],
    ["names a pane beside the session", JSON.stringify({ sessionId: SESSION, pane: "%0" })],
    ["names arguments beside the session", JSON.stringify({ sessionId: SESSION, args: ["x"] })],
    ["names the session as a list", JSON.stringify({ sessionId: [SESSION] })],
    ["is a list", JSON.stringify([SESSION])],
  ])("a body that %s is a 400, and tmux is not run", async (_what, body) => {
    const server = await serve();
    const response = await server.jump(SESSION, { body });

    expect(response.status).toBe(400);
    expect(server.asked()).toEqual([]);
  });

  test("when tmux says the pane has gone, it is a 409, and the collector looks again at once", async () => {
    const server = await serve();
    server.tmux.panes = [];
    const response = await server.jump();

    expect(response.status).toBe(409);
    expect(response.json()).toEqual({ error: "That pane has closed.", reason: "pane-gone" });
    expect(server.asked()).toEqual([["select-window", "-t", "%7"]]);

    // The next poll, two seconds on and long before the beat, asks tmux again,
    // and the session is no longer said to be in a pane.
    server.clock.now += 2_000;
    await server.collector.poller.pollOnce();
    expect(server.tmux.names().at(-1)).toBe("list-panes");
    expect(named(await server.sessions(), "checkout-flow")).not.toHaveProperty("jump");

    server.clock.now += 2_000;
    expect((await server.jump()).status).toBe(404);
  });

  test("when tmux has stopped, it is a 409 that says so", async () => {
    const server = await serve();
    server.tmux.down = "no server running on /private/tmp/tmux-501/default";
    const response = await server.jump();

    expect(response.status).toBe(409);
    expect(response.json()).toEqual({ error: "tmux is not running.", reason: "tmux-stopped" });
  });

  test("when tmux fails without a reason, it is a 500 in plain words", async () => {
    const server = await serve();
    server.tmux.down = "";
    const response = await server.jump();

    expect(response.status).toBe(500);
    expect(response.json()).toEqual({
      error: "tmux could not be asked to select the pane.",
      reason: "failed",
    });
  });

  test("one jump is made a second", async () => {
    const server = await serve();
    expect((await server.jump()).status).toBe(200);
    const made = server.asked().length;

    server.clock.now += JUMP_INTERVAL_MS - 1;
    const second = await server.jump();
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");
    expect(second.json()).toMatchObject({ reason: "too-soon" });
    expect(server.asked()).toHaveLength(made);

    server.clock.now += 1;
    expect((await server.jump()).status).toBe(200);
  });

  test("the panes are looked for on a slow beat, not on every poll", async () => {
    const server = await serve();
    for (let polls = 0; polls < 14; polls += 1) {
      server.clock.now += 2_000;
      await server.collector.poller.pollOnce();
    }
    expect(server.tmux.names()).toEqual(["list-panes"]);

    server.clock.now = T0 + PANE_LOOK_INTERVAL_MS;
    await server.collector.poller.pollOnce();
    expect(server.tmux.names()).toEqual(["list-panes", "list-panes"]);
  });
});

describe("POST /api/jump for a Terminal or iTerm2 tab", () => {
  test("a session in a tab names the app, and the tab's terminal stays with the collector, with tmux first", async () => {
    const server = await serve({}, inOneTab(TERMINAL_PATH));
    const response = await request(server.port, "/api/sessions");
    const { sessions } = response.json<SessionsSnapshot>();

    expect(named(sessions, "docs-site")?.jump).toEqual({
      kind: "terminal",
      app: "Terminal",
      place: "Terminal",
    });
    // The session in a tmux pane is reached through tmux, though its pane is in a tab too.
    expect(named(sessions, "checkout-flow")?.jump).toEqual({
      kind: "tmux",
      place: "checkout-flow:2.1",
    });
    expect(response.body).not.toContain("ttys004");
    // One ps for both sessions' tabs, and the one the tmux pane finder reads its parents from.
    expect(server.ps.runs).toBe(2);
  });

  test.each([
    ["Terminal", TERMINAL_PATH, TERMINAL_SCRIPT],
    ["iTerm2", ITERM_PATH, ITERM_SCRIPT],
  ] as const)(
    "brings the %s tab forward: osascript with the app's fixed script, a -- and the terminal alone",
    async (app, program, script) => {
      const server = await serve({}, inOneTab(program));
      const response = await server.jump(ELSEWHERE);

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ ok: true, kind: "terminal", app, place: app });
      expect(server.osascript.ran).toEqual([focusTabArgs({ app, tty: "/dev/ttys004" })]);
      const [args] = server.osascript.ran as [string[]];
      expect(args.slice(-2)).toEqual(["--", "/dev/ttys004"]);
      expect(args.filter((_arg, index) => args[index - 1] === "-e")).toEqual([...script]);
      // tmux was not asked to do anything.
      expect(server.asked()).toEqual([]);
    },
  );

  test.each([
    ["a terminal", "/dev/ttys004"],
    ["a script", 'tell application "Terminal" to activate'],
    ["an option", "-e"],
    ["the app", "Terminal"],
  ])("a body that names %s finds no tab, and osascript is not run", async (_what, sessionId) => {
    const server = await serve({}, inOneTab(TERMINAL_PATH));
    const response = await server.jump(sessionId);

    expect(response.status).toBe(404);
    expect(response.json()).toMatchObject({ reason: "no-pane" });
    expect(server.osascript.ran).toEqual([]);
  });

  test("when no tab shows that terminal, it is a 409, and the tab is looked for again", async () => {
    const server = await serve({}, inOneTab(TERMINAL_PATH));
    server.osascript.answer = MISSING;
    const response = await server.jump(ELSEWHERE);

    expect(response.status).toBe(409);
    expect(response.json()).toEqual({ error: "That tab has closed.", reason: "tab-gone" });

    // The first look read the table twice, once for the tabs and once for the tmux panes.
    server.clock.now += TAB_LOOK_SOONEST_MS;
    await server.collector.poller.pollOnce();
    expect(server.ps.runs).toBe(3);
  });

  test("when macOS has not allowed it, it is a 403 that says where to allow it", async () => {
    const server = await serve({}, inOneTab(TERMINAL_PATH));
    server.osascript.answer = NOT_ALLOWED;
    const response = await server.jump(ELSEWHERE);

    expect(response.status).toBe(403);
    expect(response.json()).toEqual({
      error:
        "macOS has not allowed Agent Lookout to control Terminal. Allow it in System Settings, Privacy & Security, Automation.",
      reason: "not-allowed",
    });
  });

  test("when osascript runs out of time, it is a 500 in plain words", async () => {
    const server = await serve({}, inOneTab(ITERM_PATH));
    server.osascript.answer = TIMED_OUT;
    const response = await server.jump(ELSEWHERE);

    expect(response.status).toBe(500);
    expect(response.json()).toEqual({
      error: "iTerm2 could not be asked to bring the tab forward.",
      reason: "failed",
    });
  });

  test("while a tab's jump waits on macOS, no other jump is made", async () => {
    const server = await serve({}, inOneTab(TERMINAL_PATH));
    let answer: () => void = () => {};
    server.osascript.holdUntil = new Promise<void>((resolve) => (answer = resolve));
    const first = server.jump(ELSEWHERE);
    await vi.waitFor(() => expect(server.osascript.ran).toHaveLength(1));

    server.clock.now += 30_000;
    const second = await server.jump(SESSION);
    expect(second.status).toBe(429);
    expect(server.asked()).toEqual([]);

    answer();
    expect((await first).status).toBe(200);
  });

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off, ps is not asked for tabs and no session has a tab", async () => {
    const server = await serve({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" }, inOneTab(TERMINAL_PATH));

    expect(named(await server.sessions(), "docs-site")).not.toHaveProperty("jump");
    // The one read is the tmux pane finder's, for the pane tmux lists.
    expect(server.ps.runs).toBe(1);
    expect((await server.jump(ELSEWHERE)).status).toBe(404);
    expect(server.osascript.ran).toEqual([]);
  });

  test("a session in a terminal of another app has no jump", async () => {
    const server = await serve({}, inOneTab("/Applications/Warp.app/Contents/MacOS/stable"));

    expect(named(await server.sessions(), "docs-site")).not.toHaveProperty("jump");
    expect((await server.jump(ELSEWHERE)).status).toBe(404);
    expect(server.osascript.ran).toEqual([]);
  });
});

// Each test starts a stand-in whose start time `ps` gives, and Windows has no
// `ps`. Agent Lookout gives a Qwen Code session no Jump on Windows.
describe.skipIf(process.platform === "win32")("POST /api/jump for a Qwen Code session", () => {
  /**
   * The collector with a Qwen Code session whose process is a stand-in this
   * test starts, beside the Claude Code sessions, polled again once a look
   * for a process that turned up is due: the two adapters look at once, so
   * the one that names its process second waits for the next look.
   */
  async function serveQwen(
    env: Record<string, string> = {},
    processes: (pid: number) => ProcessRow[] = () => [],
    more: { inPane?: boolean; startedAt?: number } = {},
  ) {
    const standIn = await startStandIn();
    const server = await serve(
      { AGENT_LOOKOUT_QWEN_HOME: await qwenHome(standIn.pid), ...env },
      processes(standIn.pid),
      {
        panes: more.inPane === false ? [] : [`${standIn.pid} %8 0 0 search-indexing`],
        startedAt: more.startedAt,
      },
    );
    server.clock.now += SOONEST_MS;
    await server.collector.poller.pollOnce();
    return { ...server, standIn };
  }

  const qwenOf = (sessions: Session[]) => sessions.find((session) => session.id === QWEN_SESSION);

  test("a session whose process runs in a pane names the place, and Claude Code's keep theirs", async () => {
    const server = await serveQwen();
    const sessions = await server.sessions();

    expect(qwenOf(sessions)).toMatchObject({ source: "qwen-code", pid: server.standIn.pid });
    expect(qwenOf(sessions)?.jump).toEqual({ kind: "tmux", place: "search-indexing:0.0" });
    expect(named(sessions, "checkout-flow")?.jump).toEqual({
      kind: "tmux",
      place: "checkout-flow:2.1",
    });

    // Over a beat of polls, both keep their place, and tmux is asked on the beat alone.
    const looks = server.tmux.names().length;
    for (let polls = 0; polls < 12; polls += 1) {
      server.clock.now += 2_000;
      await server.collector.poller.pollOnce();
    }
    server.clock.now = T0 + SOONEST_MS + PANE_LOOK_INTERVAL_MS;
    await server.collector.poller.pollOnce();
    const later = await server.sessions();
    expect(qwenOf(later)?.jump).toEqual({ kind: "tmux", place: "search-indexing:0.0" });
    expect(named(later, "checkout-flow")?.jump).toEqual({
      kind: "tmux",
      place: "checkout-flow:2.1",
    });
    expect(server.tmux.names().length).toBe(looks + 1);
  });

  test("both cards say tmux ran for their sessions, from one look at each beat", async () => {
    const server = await serveQwen();
    const looks = server.tmux.names().length;

    server.clock.now += 2_000;
    await server.collector.poller.pollOnce();
    const sources = await server.sources();

    expect(paneRowsOf(sources, "claude-code")).toEqual(RAN);
    expect(paneRowsOf(sources, "qwen-code")).toEqual(RAN);
    expect(server.tmux.names()).toHaveLength(looks);
  });

  test("Jump selects the session's pane, and then a Claude Code session's", async () => {
    const server = await serveQwen();
    server.tmux.where = "$1 0 0 search-indexing";
    const before = server.tmux.ran.length;
    const response = await server.jump(QWEN_SESSION);

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, kind: "tmux", place: "search-indexing:0.0" });
    expect(server.tmux.ran.slice(before)).toEqual([
      ["select-window", "-t", "%8"],
      ["select-pane", "-t", "%8"],
      describePaneArgs("%8"),
      [...LIST_CLIENTS_ARGS],
      ["switch-client", "-c", "/dev/ttys003", "-t", "%8"],
      ["switch-client", "-c", "/dev/ttys004", "-t", "%8"],
    ]);

    server.clock.now += JUMP_INTERVAL_MS;
    server.tmux.where = "$0 2 1 checkout-flow";
    expect((await server.jump()).json()).toEqual({
      ok: true,
      kind: "tmux",
      place: "checkout-flow:2.1",
    });
  });

  test("a session in a tab of Terminal is given the app, and Jump brings the tab forward", async () => {
    const server = await serveQwen({}, (pid) => inTabOf(TERMINAL_PATH, pid), { inPane: false });

    expect(qwenOf(await server.sessions())?.jump).toEqual({
      kind: "terminal",
      app: "Terminal",
      place: "Terminal",
    });
    const response = await server.jump(QWEN_SESSION);
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      kind: "terminal",
      app: "Terminal",
      place: "Terminal",
    });
    expect(server.osascript.ran).toEqual([focusTabArgs({ app: "Terminal", tty: "/dev/ttys009" })]);
  });

  test("a process that started after the session's record was written has no jump, and Jump finds no pane", async () => {
    const server = await serveQwen({}, () => [], { startedAt: T0 - 60_000 });

    expect(qwenOf(await server.sessions())).toMatchObject({ pid: server.standIn.pid });
    expect(qwenOf(await server.sessions())).not.toHaveProperty("jump");
    // ps was asked when the process in the pane started.
    expect(server.starts).toContainEqual([server.standIn.pid]);

    const response = await server.jump(QWEN_SESSION);
    expect(response.status).toBe(404);
    expect(new Set(server.tmux.names())).toEqual(new Set(["list-panes"]));
  });

  test("a session whose process has ended has no jump, and Jump finds no pane", async () => {
    const server = await serveQwen();
    expect(qwenOf(await server.sessions())?.jump).toMatchObject({ kind: "tmux" });

    process.kill(server.standIn.pid, "SIGTERM");
    await server.standIn.exited;
    server.clock.now += 2_000;
    await server.collector.poller.pollOnce();

    const ended = qwenOf(await server.sessions());
    expect(ended).toMatchObject({ status: "finished", alive: false });
    expect(ended).not.toHaveProperty("jump");
    const before = server.tmux.ran.length;
    expect((await server.jump(QWEN_SESSION)).status).toBe(404);
    expect(server.tmux.ran.slice(before)).toEqual([]);
  });

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off, a session in a tab has no jump, and osascript is not run", async () => {
    const server = await serveQwen(
      { AGENT_LOOKOUT_TERMINAL_JUMP: "off" },
      (pid) => inTabOf(TERMINAL_PATH, pid),
      { inPane: false },
    );

    expect(qwenOf(await server.sessions())).toBeDefined();
    expect(qwenOf(await server.sessions())).not.toHaveProperty("jump");
    expect((await server.jump(QWEN_SESSION)).status).toBe(404);
    expect(server.osascript.ran).toEqual([]);
  });

  posixTest(
    "with AGENT_LOOKOUT_TMUX off, the tmux on this machine is never run and the session has no jump",
    async () => {
      const standIn = await startStandIn();
      const server = await serveStubTmux({ AGENT_LOOKOUT_TMUX: "off" }, standIn.pid);
      const sessions = await server.sessions();

      expect(qwenOf(sessions)).toMatchObject({ source: "qwen-code", alive: true });
      for (const session of sessions) expect(session).not.toHaveProperty("jump");
      expect((await server.jump(QWEN_SESSION)).status).toBe(404);
      expect(existsSync(server.mark)).toBe(false);
    },
  );

  posixTest(
    "without it, the same collector runs the tmux on its PATH, and the session has its pane",
    async () => {
      const standIn = await startStandIn();
      const server = await serveStubTmux({}, standIn.pid);

      expect(qwenOf(await server.sessions())?.jump).toEqual({
        kind: "tmux",
        place: "search-indexing:0.0",
      });
      expect(existsSync(server.mark)).toBe(true);
    },
  );
});

describe("what POST /api/jump refuses", () => {
  test.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "a %s, with 405 and no CORS header",
    async (method) => {
      const server = await serve();
      const response = await server.jump(SESSION, { method });

      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
      ).toEqual([]);
      expect(server.asked()).toEqual([]);
    },
  );

  // What a browser sends first, before a page at another origin may send the
  // jump's own headers. The checks every route makes turn away the ones from
  // another site, so only one from this machine's own name reaches the route.
  test.each([
    ["another site", "https://evil.example", "cross-site", 403],
    ["this machine under another name", "http://127.0.0.1:3000", "cross-site", 403],
    ["another port of this machine under the same name", "http://localhost:3000", "same-site", 405],
  ])(
    "a preflight from %s is never granted: it has no CORS header",
    async (_where, origin, site, status) => {
      const server = await serve();
      const response = await request(server.port, "/api/jump", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Sec-Fetch-Site": site,
          "Sec-Fetch-Mode": "cors",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-agent-lookout-action",
        },
      });

      expect(response.status).toBe(status);
      expect(
        Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
      ).toEqual([]);
      expect(server.asked()).toEqual([]);
    },
  );

  test.each<[string, number, Record<string, string | null>]>([
    ["sent to another Host", 403, { Host: "evil.example" }],
    ["sent to a name rebound to this machine", 403, { Host: "rebind.evil.example:4777" }],
    ["from a page at another site", 403, { Origin: "https://evil.example" }],
    ["from a sandboxed frame", 403, { Origin: "null" }],
    ["with no Origin, as a program that is not a browser sends", 403, { Origin: null }],
    ["the browser marks as cross-site", 403, { "Sec-Fetch-Site": "cross-site" }],
    [
      "the browser marks as from another port of this machine",
      403,
      { "Sec-Fetch-Site": "same-site" },
    ],
    ["without the header that names the action", 403, { "X-Agent-Lookout-Action": null }],
    ["whose header names another action", 403, { "X-Agent-Lookout-Action": "stop" }],
    ["sent as a form, which needs no preflight", 415, { "Content-Type": "text/plain" }],
    ["sent as form fields", 415, { "Content-Type": "application/x-www-form-urlencoded" }],
    ["with no content type", 415, { "Content-Type": null }],
  ])("a request %s", async (_what, status, headers) => {
    const server = await serve();
    const response = await server.jump(SESSION, { headers });

    expect(response.status).toBe(status);
    expect(response.json<{ error: string }>().error).toMatch(/^[A-Z].*\.$/);
    expect(response.body).not.toContain("checkout-flow");
    expect(server.asked()).toEqual([]);
  });

  test("a body larger than the limit, whether it says so or not", async () => {
    const server = await serve();
    const large = JSON.stringify({ sessionId: SESSION, padding: "x".repeat(MAX_JUMP_BODY_BYTES) });

    expect((await server.jump(SESSION, { body: large })).status).toBe(413);
    const chunked = await server.jump(SESSION, {
      body: large,
      headers: { "Transfer-Encoding": "chunked" },
    });
    expect(chunked.status).toBe(413);
    expect(server.asked()).toEqual([]);
  });

  test("a refused request does not use up the second a jump is given", async () => {
    const server = await serve();
    await server.jump(SESSION, { headers: { Origin: null } });
    await server.jump("claude-code:nobody");

    expect((await server.jump()).status).toBe(200);
  });

  test("every other route still answers GET alone", async () => {
    const server = await serve();
    for (const target of ["/api/sessions", "/api/health", "/api/events", "/api/history"]) {
      const response = await request(server.port, target, {
        method: "POST",
        body: JSON.stringify({ sessionId: SESSION }),
        headers: {
          Origin: `http://localhost:${server.port}`,
          "Content-Type": "application/json",
          "X-Agent-Lookout-Action": "jump",
        },
      });
      expect([target, response.status, response.headers.allow]).toEqual([target, 405, "GET"]);
    }
    expect(server.asked()).toEqual([]);
  });
});
