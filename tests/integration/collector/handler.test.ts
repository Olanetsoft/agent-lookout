import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createClaudeCodeAdapter } from "@collector/adapters/claude-code/index";
import { createCollector } from "@collector/collector";
import { createEventStore } from "@collector/eventStore";
import { createApiHandler, MAX_HISTORY_WINDOW_MS, type ApiAnswer } from "@collector/handler";
import { createHistoryStore } from "@collector/historyStore";
import {
  NOTIFICATIONS_HEADER,
  type EventsResponse,
  type HistoryResponse,
  type WaitsResponse,
  type WebhookStatusResponse,
} from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import { feedJson, registryFiles } from "@tests/fixtures/claudeCode";
import { makeSession } from "@tests/fixtures/session";
import { listen, request } from "@tests/support/node/http";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const T0 = 1_700_000_000_000;

/**
 * A collector fed by the test, served over real HTTP on a free loopback port.
 * Its notifier writes down what it is asked to show and shows nothing, and its
 * environment is empty, so no test here raises a notification on this machine.
 */
async function serve(initial: Session[] = []) {
  const state = { sessions: initial, now: T0 };
  const notifier = fakeSystemNotifier();
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
    env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE },
    notifier,
    now: () => state.now,
  });
  const port = await listen(createServer(collector.handler));

  return {
    port,
    collector,
    notifier,
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
      // The rules it was made by, which are all off until the person sets them,
      // and so it was not made in quiet hours.
      timeRules: DEFAULT_TIME_RULES,
      quiet: false,
    });
  });

  test("/api/sessions gives the Claude Code source its facts: the folder, the command and how often each is used", async () => {
    const home = await makeClaudeHome(registryFiles);
    const collector = createCollector({
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE },
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
      { label: "Registry folder", value: path.join(home, "sessions") },
      { label: "Registry read", value: "every 2 seconds" },
      { label: "Command", value: "claude agents --json --all" },
      { label: "Command run", value: "every 30 seconds" },
      { label: "Transcript read", value: "last message of a waiting session" },
    ]);
    expect(sources[0]?.detail).not.toMatch(/surface/i);
    expect("advice" in (sources[0] ?? {})).toBe(false);
  });

  test("/api/sessions passes on a source's advice", async () => {
    const collector = createCollector({
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE },
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

  test("/api/history returns one point per poll, the default 15 minute window, startedAt, that history is kept in memory only, and no restarts", async () => {
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
      since: { at: T0, by: "started" },
      kept: {
        where: "memory",
        folder: null,
        bytes: null,
        maxBytes: 20 * 1024 * 1024,
        maxAgeMs: 8 * 24 * 60 * 60 * 1000,
        canClear: false,
        problem: null,
      },
      restarts: [],
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

  test("/api/waits totals how long sessions waited, here since Agent Lookout started, as history is kept in memory only", async () => {
    const server = await serve();
    const working = makeSession({ status: "working" });
    const waiting = makeSession({ status: "needs-you", waitingReason: "permission" });
    await server.poll(0, [working]);
    for (let at = 2_000; at <= 60_000; at += 2_000) await server.poll(at, [waiting]);
    await server.poll(62_000, [working]);
    for (let at = 64_000; at <= 70_000; at += 2_000) await server.poll(at, [working]);

    const response = await request(server.port, "/api/waits");
    expect(response.status).toBe(200);
    const waits = response.json<WaitsResponse>();
    expect(waits).toMatchObject({
      at: T0 + 70_000,
      since: { at: T0, by: "started" },
      where: "memory",
    });
    for (const period of [waits.today, waits.sevenDays]) {
      expect(period).toMatchObject({ waitedMs: 60_000, openMs: 0, waits: 1, sessionCount: 1 });
      expect(period.sessions).toEqual([
        { sessionId: waiting.id, name: "demo-project", waitedMs: 60_000, waits: 1, open: false },
      ]);
    }
    expect(waits.sevenDays.days).toHaveLength(7);

    // It only reads.
    const posted = await request(server.port, "/api/waits", { method: "POST" });
    expect([posted.status, posted.headers.allow]).toEqual([405, "GET"]);
  });

  test("a handler built without the waits has no such route", async () => {
    const handler = createApiHandler({
      version: "9.9.9-test",
      poller: {
        getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: [] }),
        startedAt: T0,
      },
      events: createEventStore(),
      history: createHistoryStore(),
    });
    const port = await listen(createServer(handler));
    expect((await request(port, "/api/waits")).status).toBe(404);
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

  test("/api/email says whether email is set up, which with nothing set it is not, and can only be read", async () => {
    const { port } = await serve();
    const off = {
      on: false,
      to: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    };
    expect((await request(port, "/api/email")).json()).toEqual(off);
    expect((await request(port, "/api/email", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await request(port, "/api/email", { headers: { Host: "evil.example" } })).status).toBe(
      403,
    );

    // A handler given no email notifications at all says the same.
    const handler = createApiHandler({
      version: "9.9.9-test",
      poller: {
        getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: [] }),
        startedAt: T0,
      },
      events: createEventStore(),
      history: createHistoryStore(),
    });
    const bare = await listen(createServer(handler));
    expect((await request(bare, "/api/email")).json()).toEqual(off);
  });

  test("/api/webhook says whether a webhook is set up, which with nothing set it is not, and can only be read", async () => {
    const { port } = await serve();
    const off = {
      on: false,
      host: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    };
    expect((await request(port, "/api/webhook")).json()).toEqual(off);
    expect((await request(port, "/api/webhook", { method: "POST", body: "{}" })).status).toBe(405);
    expect(
      (await request(port, "/api/webhook", { headers: { Host: "evil.example" } })).status,
    ).toBe(403);

    // A handler given what answers it says what that says.
    const on: WebhookStatusResponse = {
      ...off,
      on: true,
      host: "hooks.example.com",
      events: ["needs-you"],
      afterMs: 0,
      asking: false,
    };
    const handler = createApiHandler({
      version: "9.9.9-test",
      poller: {
        getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: [] }),
        startedAt: T0,
      },
      events: createEventStore(),
      history: createHistoryStore(),
      webhook: () => on,
    });
    const answering = await listen(createServer(handler));
    expect((await request(answering, "/api/webhook")).json()).toEqual(on);
  });
});

describe("/api/pull-requests", () => {
  test("says whether pull requests are shown, which with nothing set they are not, and can only be read", async () => {
    const { port } = await serve();
    const off = { on: false, problem: null, gh: null, last: null };
    expect((await request(port, "/api/pull-requests")).json()).toEqual(off);
    expect((await request(port, "/api/pull-requests", { method: "POST", body: "{}" })).status).toBe(
      405,
    );
    expect(
      (await request(port, "/api/pull-requests", { headers: { Host: "evil.example" } })).status,
    ).toBe(403);

    // A handler given what answers it says what that says.
    const on = { on: true, problem: null, gh: "signed-out", last: null };
    const handler = createApiHandler({
      version: "9.9.9-test",
      poller: {
        getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: [] }),
        startedAt: T0,
      },
      events: createEventStore(),
      history: createHistoryStore(),
      pullRequests: () => ({ on: true, problem: null, gh: "signed-out", last: null }),
    });
    const answering = await listen(createServer(handler));
    expect((await request(answering, "/api/pull-requests")).json()).toEqual(on);
  });
});

describe("the route that acts", () => {
  /** The handler alone, with whatever answers `/api/jump`, or nothing that does. */
  async function handlerWith(jump?: () => Promise<ApiAnswer>) {
    const handler = createApiHandler({
      version: "9.9.9-test",
      poller: {
        getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: [] }),
        startedAt: T0,
      },
      events: createEventStore(),
      history: createHistoryStore(),
      jump,
    });
    return listen(createServer(handler));
  }
  const post = (port: number, headers: Record<string, string> = {}) =>
    request(port, "/api/jump", { method: "POST", body: "{}", headers });

  test("is handed the request only after the checks every request passes", async () => {
    let asked = 0;
    const port = await handlerWith(async () => {
      asked += 1;
      return { status: 200, body: { ok: true }, headers: { "Retry-After": "1" } };
    });

    const refused: Record<string, string>[] = [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of refused) {
      expect((await post(port, headers)).status).toBe(403);
    }
    expect(asked).toBe(0);

    // What it answers is sent as every answer is, with the headers it asked for.
    const response = await post(port);
    expect([response.status, response.json()]).toEqual([200, { ok: true }]);
    expect(response.headers["retry-after"]).toBe("1");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(asked).toBe(1);
  });

  test("a failure inside it is a plain 500, and the next request is still answered", async () => {
    const port = await handlerWith(async () => {
      throw new Error("The stand-in was told to throw.");
    });

    const response = await post(port);
    expect(response.status).toBe(500);
    expect(response.json()).toEqual({ error: "The collector ran into an unexpected problem." });
    expect(response.body).not.toContain("stand-in");
    expect((await request(port, "/api/health")).status).toBe(200);
  });

  test("a handler built without it has no such route", async () => {
    const port = await handlerWith();

    const posted = await post(port);
    expect([posted.status, posted.headers.allow]).toEqual([405, "GET"]);
    expect((await request(port, "/api/jump")).status).toBe(404);
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

describe("the notifications header", () => {
  const working = makeSession({ name: "checkout-flow", status: "working" });
  const waiting = makeSession({
    name: "checkout-flow",
    status: "needs-you",
    waitingReason: "question",
  });

  test.each(["on", "off"])(
    "a request that says %s is answered exactly as one that says nothing",
    async (said) => {
      const server = await serve();
      await server.poll(0, [working]);

      for (const target of ["/api/health", "/api/sessions", "/api/events", "/api/history"]) {
        const plain = await request(server.port, target);
        const saying = await request(server.port, target, {
          headers: { [NOTIFICATIONS_HEADER]: said, Origin: `http://localhost:${server.port}` },
        });
        expect([target, saying.status]).toEqual([target, 200]);
        expect(saying.body).toBe(plain.body);
        expect(saying.headers).toEqual({ ...plain.headers, date: saying.headers.date });
      }
    },
  );

  test("a page that says on turns the collector's notifications on, under any spelling of the header's name", async () => {
    const server = await serve();
    await server.poll(0, [working]);
    await request(server.port, "/api/health", {
      headers: { "x-agent-lookout-notifications": "on" },
    });

    await server.poll(60_000, [waiting]);
    expect(server.notifier.shown).toEqual([
      { title: "checkout-flow", body: "Asked you a question" },
    ]);
  });

  test.each(["yes", "true", "1", "", "on, on", "on, off"])(
    "a header that says %j says nothing",
    async (value) => {
      const server = await serve();
      await server.poll(0, [working]);
      const response = await request(server.port, "/api/sessions", {
        headers: { [NOTIFICATIONS_HEADER]: value },
      });
      expect(response.status).toBe(200);

      await server.poll(60_000, [waiting]);
      expect(server.notifier.shown).toEqual([]);
    },
  );

  test.each<[string, { method?: string; headers: Record<string, string> }]>([
    ["sent to another Host", { headers: { Host: "evil.example" } }],
    ["sent to a name rebound to this machine", { headers: { Host: "rebind.evil.example:4777" } }],
    ["from a page at another site", { headers: { Origin: "https://evil.example" } }],
    ["from a sandboxed frame", { headers: { Origin: "null" } }],
    ["the browser marks as cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
    ["that is not a GET", { method: "POST", headers: {} }],
    ["that is a preflight", { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } }],
  ])("a request %s is refused as before, and is not listened to", async (_what, options) => {
    const server = await serve();
    await server.poll(0, [working]);

    const response = await request(server.port, "/api/sessions", {
      method: options.method,
      headers: { ...options.headers, [NOTIFICATIONS_HEADER]: "on" },
    });
    expect([403, 405]).toContain(response.status);
    expect(response.body).not.toContain("checkout-flow");

    // Had it been listened to, this wait would be shown.
    await server.poll(60_000, [waiting]);
    expect(server.notifier.shown).toEqual([]);
  });

  test("a refused request cannot turn them off either", async () => {
    const server = await serve();
    await server.poll(0, [working]);
    await request(server.port, "/api/sessions", { headers: { [NOTIFICATIONS_HEADER]: "on" } });
    await request(server.port, "/api/sessions", {
      headers: { Origin: "https://evil.example", [NOTIFICATIONS_HEADER]: "off" },
    });

    await server.poll(60_000, [waiting]);
    expect(server.notifier.shown).toHaveLength(1);
  });
});
