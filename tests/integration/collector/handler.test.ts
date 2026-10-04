import { createServer } from "node:http";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createClaudeCodeAdapter } from "@collector/adapters/claude-code/index";
import { createCollector } from "@collector/collector";
import { MAX_HISTORY_WINDOW_MS } from "@collector/handler";
import type { EventsResponse, HistoryResponse } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/session";
import { feedJson, registryFiles } from "@tests/fixtures/claudeCode";
import { makeSession } from "@tests/fixtures/session";
import { listen, request } from "@tests/support/http";
import { makeClaudeHome, tempDir } from "@tests/support/tempFiles";

const T0 = 1_700_000_000_000;

/** A collector fed by the test, served over real HTTP on a free loopback port. */
async function serve(initial: Session[] = []) {
  const state = { sessions: initial, now: T0 };
  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => ({
      health: { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: state.now },
      sessions: state.sessions,
    }),
  };
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [adapter],
    now: () => state.now,
  });
  const port = await listen(createServer(collector.handler));

  return {
    port,
    collector,
    /** Moves the clock, replaces the sessions and polls once. */
    async poll(atOffsetMs: number, sessions: Session[]) {
      state.now = T0 + atOffsetMs;
      state.sessions = sessions;
      await collector.poller.pollOnce();
    },
    setNow(atOffsetMs: number) {
      state.now = T0 + atOffsetMs;
    },
  };
}

describe("routes", () => {
  test("/api/health reports the version", async () => {
    const { port } = await serve();
    const response = await request(port, "/api/health");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true, version: "9.9.9-test" });
  });

  test("/api/sessions is searching before the first poll, then the latest poll", async () => {
    const server = await serve();

    const before = (await request(server.port, "/api/sessions")).json<SessionsSnapshot>();
    expect(before).toEqual({
      generatedAt: T0,
      sources: [
        {
          id: "claude-code",
          label: "Claude Code",
          state: "searching",
          detail: "Looking for sessions in a test.",
          checkedAt: T0,
        },
      ],
      sessions: [],
    });

    const idle = makeSession({ id: "claude-code:idle", status: "idle" });
    const waiting = makeSession({
      id: "claude-code:waiting",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
    });
    await server.poll(2_000, [idle, waiting]);

    const response = await request(server.port, "/api/sessions");
    expect(response.status).toBe(200);
    expect(response.json()).toEqual({
      generatedAt: T0 + 2_000,
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 + 2_000 }],
      sessions: [waiting, idle],
    });
  });

  test("/api/sessions gives the Claude Code source its facts: the folder, the command and how often each is used", async () => {
    const home = await makeClaudeHome(registryFiles);
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [
        createClaudeCodeAdapter({
          env: { AGENT_LOOKOUT_CLAUDE_HOME: home, AGENT_LOOKOUT_CLAUDE_BIN: "/opt/tools/claude" },
          homeDir: "/Users/example",
          now: () => T0 + 100_000,
          isAlive: () => true,
          isExecutable: async () => true,
          run: async () => ({ ok: true, stdout: feedJson }),
          readProcessStarts: async () => new Map(),
        }),
      ],
      now: () => T0 + 100_000,
    });
    const port = await listen(createServer(collector.handler));
    await collector.poller.pollOnce();

    const { sources, sessions } = (await request(port, "/api/sessions")).json<SessionsSnapshot>();
    expect(sessions).toHaveLength(5);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.state).toBe("ok");
    expect(sources[0]?.watching).toEqual([
      { label: "Registry folder", value: `${home}/sessions` },
      { label: "Registry read", value: "every 2 seconds" },
      { label: "Command", value: "claude agents --json --all" },
      { label: "Command run", value: "every 30 seconds" },
    ]);
    expect(sources[0]?.detail).not.toMatch(/surface/i);
    expect("advice" in (sources[0] ?? {})).toBe(false);
  });

  test("/api/sessions passes on a source's advice", async () => {
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [
        createClaudeCodeAdapter({
          env: { AGENT_LOOKOUT_CLAUDE_BIN: "/nowhere/claude" },
          homeDir: await tempDir(),
          isExecutable: async () => false,
        }),
      ],
    });
    const port = await listen(createServer(collector.handler));
    await collector.poller.pollOnce();

    const { sources } = (await request(port, "/api/sessions")).json<SessionsSnapshot>();
    expect(sources[0]).toMatchObject({
      state: "unavailable",
      advice: "Correct AGENT_LOOKOUT_CLAUDE_BIN, or unset it.",
    });
    expect(sources[0]?.detail).not.toContain("Correct");
  });

  test("/api/events lists changes newest first and honours since", async () => {
    const server = await serve();
    const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "working" });

    expect((await request(server.port, "/api/events")).json()).toEqual({ events: [] });

    await server.poll(0, [a]);
    await server.poll(2_000, [{ ...a, status: "needs-you", waitingReason: "question" }]);
    await server.poll(4_000, [{ ...a, status: "working" }]);
    await server.poll(6_000, []);

    const all = (await request(server.port, "/api/events")).json<EventsResponse>();
    expect(
      all.events.map((event) => [event.at - T0, event.kind, event.to, event.severity]),
    ).toEqual([
      [6_000, "ended", undefined, "advisory"],
      [4_000, "status-changed", "working", "advisory"],
      [2_000, "status-changed", "needs-you", "warning"],
    ]);

    const recent = (
      await request(server.port, `/api/events?since=${T0 + 2_000}`)
    ).json<EventsResponse>();
    expect(recent.events.map((event) => event.at - T0)).toEqual([6_000, 4_000]);

    const none = (await request(server.port, `/api/events?since=${T0 + 6_000}`)).json();
    expect(none).toEqual({ events: [] });
  });

  test("/api/events never returns more than 200", async () => {
    const server = await serve();
    const many = Array.from({ length: 250 }, (_, index) =>
      makeSession({ id: `claude-code:${index}`, name: `demo-${index}` }),
    );
    await server.poll(0, []);
    await server.poll(2_000, many);
    const body = (await request(server.port, "/api/events")).json<EventsResponse>();
    expect(body.events).toHaveLength(200);
  });

  test("/api/history returns one point per poll, the default 15 minute window, and startedAt", async () => {
    const server = await serve();
    const working = makeSession({ status: "working" });

    await server.poll(0, [working]);
    await server.poll(2_000, [working, makeSession({ id: "claude-code:2", status: "needs-you" })]);
    // 20 minutes later, the first two points are outside the default window.
    await server.poll(20 * 60_000, []);

    const recent = (await request(server.port, "/api/history")).json<HistoryResponse>();
    expect(recent).toEqual({
      points: [{ at: T0 + 20 * 60_000, needsYou: 0, working: 0, idle: 0, total: 0 }],
      startedAt: T0,
    });

    const wide = (
      await request(server.port, `/api/history?windowMs=${60 * 60_000}`)
    ).json<HistoryResponse>();
    expect(wide.points.map((point) => [point.at - T0, point.needsYou, point.working])).toEqual([
      [0, 0, 1],
      [2_000, 1, 1],
      [20 * 60_000, 0, 0],
    ]);
    expect(wide.startedAt).toBe(T0);
  });

  test("/api/history clamps a window longer than the buffer", async () => {
    const server = await serve();
    await server.poll(0, []);
    server.setNow(MAX_HISTORY_WINDOW_MS + 1_000);
    const response = await request(server.port, "/api/history?windowMs=999999999999999");
    expect(response.status).toBe(200);
    // The one point is now older than the longest window the buffer can serve.
    expect(response.json<HistoryResponse>().points).toEqual([]);
  });

  test("malformed query values are a 400 that says what is expected", async () => {
    const { port } = await serve();
    for (const target of [
      "/api/events?since=yesterday",
      "/api/events?since=-5",
      "/api/events?since=",
      "/api/events?since=1e3",
      "/api/history?windowMs=abc",
      "/api/history?windowMs=0",
      "/api/history?windowMs=-900000",
      "/api/history?windowMs=Infinity",
    ]) {
      const response = await request(port, target);
      expect([target, response.status]).toEqual([target, 400]);
      expect(response.json<{ error: string }>().error).toMatch(/milliseconds/);
    }
  });

  test("unknown paths are a JSON 404", async () => {
    const { port } = await serve();
    for (const target of ["/api", "/api/", "/api/nope", "/api/sessions/", "/api/sessions/1", "/"]) {
      const response = await request(port, target);
      expect([target, response.status]).toEqual([target, 404]);
      expect(response.json()).toEqual({ error: "There is nothing at that address." });
    }
  });

  test("a path that climbs out of /api finds nothing", async () => {
    const { port } = await serve();
    const response = await request(port, "/api/../package.json");
    expect(response.status).toBe(404);
    expect(response.body).not.toContain("agent-lookout");
  });

  test("only GET is answered", async () => {
    const { port } = await serve();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await request(port, "/api/sessions", { method });
      expect([method, response.status]).toEqual([method, 405]);
      expect(response.headers.allow).toBe("GET");
    }
  });
});

describe("response headers", () => {
  test("every answer is JSON, uncacheable and carries no CORS headers", async () => {
    const { port } = await serve();
    const responses = await Promise.all([
      request(port, "/api/health"),
      request(port, "/api/sessions"),
      request(port, "/api/events"),
      request(port, "/api/history"),
      request(port, "/api/nope"),
      request(port, "/api/sessions", { headers: { Host: "evil.example" } }),
      request(port, "/api/sessions", { headers: { Origin: "https://evil.example" } }),
      request(port, "/api/sessions", { method: "OPTIONS" }),
    ]);
    for (const response of responses) {
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
      const corsHeaders = Object.keys(response.headers).filter((name) =>
        name.startsWith("access-control-"),
      );
      expect(corsHeaders).toEqual([]);
      expect(() => response.json()).not.toThrow();
    }
  });

  test("CORS headers a host added before the handler ran are taken off again", async () => {
    // Vite's dev server does exactly this: its CORS middleware runs first and
    // allows any page on localhost, on any port, to read the response.
    const server = await serve();
    await server.poll(0, [makeSession()]);
    const port = await listen(
      createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary", "Origin");
        server.collector.handler(req, res);
      }),
    );

    for (const target of ["/api/sessions", "/api/health", "/api/nope"]) {
      const response = await request(port, target, {
        headers: { Origin: "http://localhost:3000" },
      });
      const corsHeaders = Object.keys(response.headers).filter((name) =>
        name.startsWith("access-control-"),
      );
      expect([target, corsHeaders]).toEqual([target, []]);
    }
  });
});

describe("the Host check", () => {
  test.each([
    "localhost",
    "localhost:5173",
    "LOCALHOST:4777",
    "127.0.0.1",
    "127.0.0.1:4777",
    "[::1]",
    "[::1]:4777",
  ])("a request to %s is answered", async (host) => {
    const { port } = await serve();
    const response = await request(port, "/api/health", { headers: { Host: host } });
    expect(response.status).toBe(200);
  });

  test.each([
    "evil.example",
    "evil.example:4777",
    // DNS rebinding: a hostile name that resolves to 127.0.0.1.
    "rebind.evil.example:5173",
    // Names built to look like loopback.
    "localhost.evil.example",
    "evil.example.localhost",
    "127.0.0.1.evil.example",
    "localhost:4777.evil.example",
    "localhost@evil.example",
    "127.0.0.2",
    "0.0.0.0:4777",
    "192.168.1.20:4777",
    "::1",
    "localhost:",
    "localhost:port",
    "",
  ])("a request to %j is refused and given no session data", async (host) => {
    const server = await serve();
    await server.poll(0, [makeSession({ name: "demo-project" })]);

    for (const target of ["/api/sessions", "/api/health", "/api/events", "/api/history"]) {
      const response = await request(server.port, target, { headers: { Host: host } });
      expect(response.status).toBe(403);
      expect(response.body).not.toContain("demo-project");
      expect(response.json()).toEqual({
        error: "This address only answers requests made to localhost.",
      });
    }
  });

  test("a request with no Host header at all is refused", async () => {
    const server = await serve();
    await server.poll(0, [makeSession({ name: "demo-project" })]);
    const response = await request(server.port, "/api/sessions", { headers: { Host: null } });
    // Node turns away an HTTP/1.1 request with no Host before the handler sees it.
    expect([400, 403]).toContain(response.status);
    expect(response.body).not.toContain("demo-project");
  });
});

describe("the Origin check", () => {
  test.each([
    "http://localhost:5173",
    "http://localhost",
    "http://127.0.0.1:4777",
    "http://[::1]:4777",
    "https://localhost:5173",
  ])("a page served from %s is answered", async (origin) => {
    const { port } = await serve();
    const response = await request(port, "/api/sessions", { headers: { Origin: origin } });
    expect(response.status).toBe(200);
  });

  test.each([
    "https://evil.example",
    "http://evil.example:5173",
    "http://localhost.evil.example",
    "http://localhost:5173.evil.example",
    "http://localhost@evil.example",
    "http://127.0.0.1.evil.example",
    "http://192.168.1.20:5173",
    "file://",
    "vscode-webview://abc",
    "chrome-extension://abcdefghijklmnop",
    // What a sandboxed frame or a local file sends.
    "null",
    "",
  ])("a page served from %j is refused and given no session data", async (origin) => {
    const server = await serve();
    await server.poll(0, [makeSession({ name: "demo-project" })]);

    const response = await request(server.port, "/api/sessions", { headers: { Origin: origin } });
    expect(response.status).toBe(403);
    expect(response.body).not.toContain("demo-project");
    expect(response.json()).toEqual({
      error: "This address only answers pages served from this machine.",
    });
  });

  test("a loopback Origin does not rescue a foreign Host", async () => {
    const { port } = await serve();
    const response = await request(port, "/api/sessions", {
      headers: { Host: "evil.example", Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(403);
  });

  test("a request the browser marks as cross-site is refused even without an Origin", async () => {
    const server = await serve();
    await server.poll(0, [makeSession({ name: "demo-project" })]);

    const crossSite = await request(server.port, "/api/sessions", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).not.toContain("demo-project");

    for (const site of ["same-origin", "none"]) {
      const response = await request(server.port, "/api/sessions", {
        headers: { "Sec-Fetch-Site": site },
      });
      expect(response.status).toBe(200);
    }
  });
});
