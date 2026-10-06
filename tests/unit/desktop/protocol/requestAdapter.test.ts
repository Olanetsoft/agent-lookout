import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, test } from "vitest";

import { createEventStore } from "@collector/eventStore";
import { createApiHandler, type ApiAnswer } from "@collector/handler";
import { createHistoryStore } from "@collector/historyStore";
import { jumpRefusalFor, sessionIdIn } from "@collector/jumpRoute";
import { APP_ORIGIN } from "@core/appAddress";
import {
  AnswerCollector,
  answerWith,
  FOREIGN_ORIGIN,
  LOOPBACK_HOST,
  LOOPBACK_ORIGIN,
  nodeHeaders,
  originOf,
  toIncomingMessage,
  toResponse,
  type AppRequest,
  type NodeHandler,
} from "@desktop/protocol/requestAdapter";

/** A request as Electron hands one over, made by `initiator` when given. */
function appRequest(path: string, init: RequestInit = {}, initiator?: string): AppRequest {
  const request = new Request(`agent-lookout://app${path}`, init) as AppRequest;
  if (initiator !== undefined) request.initiatorOrigin = initiator;
  return request;
}

/** Reads a request's whole body, as the jump route does. */
function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The collector's real handler, over empty stores. Its jump route makes the
 * route's own checks and then answers with the session the body names, so a
 * test sees what reached it without anything being run.
 */
function api() {
  return createApiHandler({
    version: "9.9.9-test",
    poller: {
      getSnapshot: () => ({ generatedAt: 0, sources: [], sessions: [] }),
      startedAt: 0,
    },
    events: createEventStore(),
    history: createHistoryStore(),
    jump: async (req): Promise<ApiAnswer> =>
      jumpRefusalFor(req) ?? { status: 200, body: { named: sessionIdIn(await readAll(req)) } },
  });
}

const JUMP: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json", "x-agent-lookout-action": "jump" },
  body: JSON.stringify({ sessionId: "claude-code:1" }),
};

describe("who made a request", () => {
  test("the origin Electron gives is believed before the page's own header", () => {
    expect(originOf(appRequest("/", {}, APP_ORIGIN))).toBe(APP_ORIGIN);
    expect(
      originOf(appRequest("/", { headers: { origin: APP_ORIGIN } }, "https://evil.example")),
    ).toBe("https://evil.example");
    expect(originOf(appRequest("/", { headers: { origin: APP_ORIGIN } }))).toBe(APP_ORIGIN);
    // One the app made itself, such as opening the window.
    expect(originOf(appRequest("/"))).toBeUndefined();
  });

  test("Host is always loopback, and Origin is loopback only for the app's own page", () => {
    const headers = (request: AppRequest) => nodeHeaders(request, APP_ORIGIN);

    const own = headers(
      appRequest("/api/sessions", { headers: { host: "evil.example" } }, APP_ORIGIN),
    );
    expect(own.host).toBe(LOOPBACK_HOST);
    expect(own.origin).toBe(LOOPBACK_ORIGIN);

    // Any other origin, a loopback one included, is one no check accepts.
    for (const other of [
      "https://evil.example",
      "http://127.0.0.1:5173",
      "http://localhost",
      "null",
      "agent-lookout://other",
      "file://",
    ]) {
      expect(headers(appRequest("/api/sessions", {}, other)).origin, other).toBe(FOREIGN_ORIGIN);
      expect(
        headers(appRequest("/api/sessions", { headers: { origin: other } })).origin,
        other,
      ).toBe(FOREIGN_ORIGIN);
    }

    // The app's own requests carry none.
    expect(headers(appRequest("/")).origin).toBeUndefined();
    expect(headers(appRequest("/")).host).toBe(LOOPBACK_HOST);
  });

  test("the other headers pass as they were sent, with their names in lower case", () => {
    const headers = nodeHeaders(
      appRequest(
        "/api/sessions",
        { headers: { "X-Agent-Lookout-Notifications": "on", "Sec-Fetch-Site": "same-origin" } },
        APP_ORIGIN,
      ),
      APP_ORIGIN,
    );
    expect(headers["x-agent-lookout-notifications"]).toBe("on");
    expect(headers["sec-fetch-site"]).toBe("same-origin");
  });

  test("the message has the method, the path and query, and nothing of the scheme or host", () => {
    const message = toIncomingMessage(
      appRequest("/api/events?since=5", {}, APP_ORIGIN),
      APP_ORIGIN,
    );
    expect(message.method).toBe("GET");
    expect(message.url).toBe("/api/events?since=5");
  });
});

describe("through the collector's own handler", () => {
  test("a request from the app's own page is answered as one made on this machine", async () => {
    const response = await answerWith(api(), appRequest("/api/health", {}, APP_ORIGIN), APP_ORIGIN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "9.9.9-test" });
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect([...response.headers.keys()].join()).not.toContain("access-control");
  });

  test.each(["https://evil.example", "http://127.0.0.1:4777", "null"])(
    "a request from %s is refused by the handler's own check",
    async (other) => {
      const response = await answerWith(api(), appRequest("/api/sessions", {}, other), APP_ORIGIN);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "This address only answers pages served from this machine.",
      });
    },
  );

  test("a request the browser calls cross-site is refused, as it is by the server", async () => {
    const request = appRequest(
      "/api/sessions",
      { headers: { "sec-fetch-site": "cross-site" } },
      APP_ORIGIN,
    );
    expect((await answerWith(api(), request, APP_ORIGIN)).status).toBe(403);
  });

  test("the page's Jump passes the jump route's checks, and its body arrives whole", async () => {
    const response = await answerWith(api(), appRequest("/api/jump", JUMP, APP_ORIGIN), APP_ORIGIN);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ named: "claude-code:1" });
  });

  test("a Jump from anywhere else, or with no origin at all, is refused before its body is read", async () => {
    for (const request of [
      appRequest("/api/jump", JUMP, "https://evil.example"),
      appRequest("/api/jump", JUMP),
      appRequest("/api/jump", {
        ...JUMP,
        headers: { ...JUMP.headers, origin: "http://127.0.0.1" },
      }),
    ]) {
      const response = await answerWith(api(), request, APP_ORIGIN);
      expect(response.status).toBe(403);
      // A refused request's connection header is the server's business, not the window's.
      expect(response.headers.get("connection")).toBeNull();
    }
  });

  test("a GET to the jump route is refused with 405, as anywhere else", async () => {
    const response = await answerWith(api(), appRequest("/api/jump", {}, APP_ORIGIN), APP_ORIGIN);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("the answer", () => {
  test("what a handler writes becomes the response, with the headers that describe a connection left out", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.setHeader("X-One", "1");
      res.writeHead(201, {
        "Content-Type": "text/plain",
        Connection: "close",
        "Transfer-Encoding": "chunked",
        "Keep-Alive": "timeout=5",
      });
      res.write("hello, ");
      res.end("app");
    };
    const response = await answerWith(handler, appRequest("/", {}, APP_ORIGIN), APP_ORIGIN);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("hello, app");
    expect(response.headers.get("x-one")).toBe("1");
    expect(response.headers.get("content-type")).toBe("text/plain");
    for (const name of ["connection", "transfer-encoding", "keep-alive"]) {
      expect(response.headers.get(name), name).toBeNull();
    }
  });

  test("an answer to HEAD, or with a status that has no body, has none", async () => {
    const written = {
      status: 200,
      headers: new Map([["content-length", "4"]]),
      body: Buffer.from("body"),
    };
    expect(toResponse(written, "HEAD").body).toBeNull();
    expect(toResponse({ ...written, status: 204 }, "GET").body).toBeNull();
    expect(toResponse({ ...written, status: 304 }, "GET").body).toBeNull();
    expect(await toResponse(written, "GET").text()).toBe("body");
  });

  test("an answer that comes later is waited for", async () => {
    const handler: NodeHandler = (_req, res) => {
      setTimeout(() => res.end("later"), 20);
    };
    const response = await answerWith(handler, appRequest("/", {}, APP_ORIGIN), APP_ORIGIN);
    expect(await response.text()).toBe("later");
  });

  test("a handler that fails before it answers gives a plain 500, and one that fails after is ended", async () => {
    const early = await answerWith(
      () => {
        throw new Error("broken");
      },
      appRequest("/", {}, APP_ORIGIN),
      APP_ORIGIN,
    );
    expect(early.status).toBe(500);
    expect(await early.text()).toBe("The app ran into an unexpected problem.");

    const late = await answerWith(
      async (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.write("part");
        throw new Error("broken");
      },
      appRequest("/", {}, APP_ORIGIN),
      APP_ORIGIN,
    );
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("part");
  });

  test("the stand-in keeps headers as Node's does: by name in any case, and removable", () => {
    const res = new AnswerCollector();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Count", 3);
    expect(res.getHeaderNames()).toEqual(["access-control-allow-origin", "x-count"]);
    expect(res.getHeader("X-COUNT")).toBe("3");
    res.removeHeader("ACCESS-CONTROL-ALLOW-ORIGIN");
    expect(res.hasHeader("access-control-allow-origin")).toBe(false);
    // The collector's handler strips CORS headers a host set before it, through these.
    const asNode = res as unknown as ServerResponse;
    expect(asNode.getHeaderNames()).toEqual(["x-count"]);
  });
});
