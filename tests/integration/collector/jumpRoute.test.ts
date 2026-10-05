import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createCollector } from "@collector/collector";
import { MAX_JUMP_BODY_BYTES } from "@collector/jumpRoute";
import { PANE_LOOK_INTERVAL_MS } from "@collector/tmux/paneFinder";
import { LIST_CLIENTS_ARGS, describePaneArgs } from "@collector/tmux/selectPane";
import { JUMP_INTERVAL_MS } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { NOW as CODEX_NOW } from "@tests/fixtures/codex";
import { listen, request, type TestRequest } from "@tests/support/node/http";
import { fakeSystemNotifier } from "@tests/support/node/systemNotifier";
import { CODEX_FIXTURE_HOME, makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";
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
 * The collector as every host builds it, with its real Claude Code adapter
 * reading a folder of the test's own, and a tmux that runs nothing: it lists
 * one pane, whose process is this test's, and writes down what it is asked.
 * Served over real HTTP on a free loopback port.
 */
async function serve(env: Record<string, string> = {}) {
  const tmux = fakeTmux({
    panes: [`${process.pid} %7 2 1 checkout-flow`],
    where: "$0 2 1 checkout-flow",
    clients: ["$0 /dev/ttys003", "$4 /dev/ttys004"],
  });
  const clock = { now: T0 };
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      ...env,
    },
    notifier: fakeSystemNotifier(),
    tmux: tmux.run,
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

  return { port, tmux, clock, collector, jump, sessions, asked };
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
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(registry()),
        AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
        AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
        AGENT_LOOKOUT_TMUX: "off",
      },
      notifier: fakeSystemNotifier(),
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
      error: "No tmux pane is known for that session.",
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
