import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { createCollector } from "@collector/collector";
import { MAX_JUMP_BODY_BYTES } from "@collector/jumpRoute";
import { focusTabArgs, ITERM_SCRIPT, TERMINAL_SCRIPT } from "@collector/terminal/focusTab";
import { TAB_LOOK_SOONEST_MS } from "@collector/terminal/tabFinder";
import { PANE_LOOK_INTERVAL_MS } from "@collector/tmux/paneFinder";
import { LIST_CLIENTS_ARGS, describePaneArgs } from "@collector/tmux/selectPane";
import { JUMP_INTERVAL_MS } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { NOW as CODEX_NOW } from "@tests/fixtures/codex";
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
import { fakeTmux } from "@tests/support/node/tmux";

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
 * pane, whose process is this test's, and writes down what it is asked, a
 * table of processes of the test's own, and an osascript that runs nothing and
 * writes down what it is asked. Served over real HTTP on a free loopback port.
 */
async function serve(env: Record<string, string> = {}, processes: ProcessRow[] = []) {
  const tmux = fakeTmux({
    panes: [`${process.pid} %7 2 1 checkout-flow`],
    where: "$0 2 1 checkout-flow",
    clients: ["$0 /dev/ttys003", "$4 /dev/ttys004"],
  });
  const osascript = fakeOsascript();
  const ps = fakeProcesses(processes);
  const clock = { now: T0 };
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      ...env,
    },
    notifier: fakeSystemNotifier(),
    tmux: tmux.run,
    osascript: osascript.run,
    readProcesses: ps.read,
    now: () => clock.now,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  /** The request the dashboard's page makes, changed as a test says. */
  const jump = (sessionId: unknown = SESSION, options: TestRequest = {}) =>
    request(port, "/api/jump", {
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
  const sessions = async () =>
    (await request(port, "/api/sessions")).json<SessionsSnapshot>().sessions;
  /** What tmux was asked after the first look for panes. */
  const asked = () => tmux.ran.slice(1);

  return { port, tmux, osascript, ps, clock, collector, jump, sessions, asked };
}

const named = (sessions: Session[], name: string) =>
  sessions.find((session) => session.name === name);

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

  test("with AGENT_LOOKOUT_TMUX off, the tmux on this machine is never run and no session has a jump", async () => {
    const collector = createCollector({
      version: "9.9.9-test",
      env: {
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
        AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
        AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
        AGENT_LOOKOUT_TMUX: "off",
      },
      notifier: fakeSystemNotifier(),
      osascript: fakeOsascript().run,
      readProcesses: fakeProcesses().read,
      now: () => T0,
    });
    const port = await listen(createServer(collector.handler));
    await collector.poller.pollOnce();
    const { sessions } = (await request(port, "/api/sessions")).json<SessionsSnapshot>();

    expect(sessions.map((session) => session.name).sort()).toEqual(["checkout-flow", "docs-site"]);
    for (const session of sessions) expect(session).not.toHaveProperty("jump");
  });
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
