import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import type { NotificationTestOutcome } from "@core/notices/appNotifications";
import {
  createNotificationRoute,
  MAX_NOTIFICATIONS_BODY_BYTES,
} from "@desktop/notifications/notificationRoute";
import { AnswerCollector } from "@desktop/protocol/requestAdapter";

/**
 * The headers a request from the app's own page arrives with, once the
 * protocol's adapter has given it the loopback `Host` and `Origin`.
 */
const FROM_THE_PAGE = {
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};

const STATUS = "/api/app/notifications";
const TEST = "/api/app/notifications/test";

function fakeNotifier(
  outcome: NotificationTestOutcome = { outcome: "shown" },
  lastRefusal: string | null = null,
) {
  return {
    test: vi.fn(async () => outcome),
    lastRefusal: vi.fn(() => lastRefusal),
  };
}

interface Asked {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}

/** A request as Node's server would hand it over: a stream of its body, with its method, path and headers. */
function request(path: string, asked: Asked = {}): IncomingMessage {
  const method = asked.method ?? (path === TEST ? "POST" : "GET");
  const headers: Record<string, string> = {};
  const given = {
    ...FROM_THE_PAGE,
    ...(method === "POST" ? { "x-agent-lookout-action": "notification-test" } : {}),
    ...asked.headers,
  };
  for (const [name, value] of Object.entries(given)) if (value !== undefined) headers[name] = value;
  const body = asked.body ?? (method === "POST" ? "{}" : "");
  return Object.assign(Readable.from(body === "" ? [] : [Buffer.from(body)]), {
    method,
    url: path,
    headers,
  }) as unknown as IncomingMessage;
}

async function ask(notifier: ReturnType<typeof fakeNotifier>, path: string, asked?: Asked) {
  const route = createNotificationRoute(notifier);
  const res = new AnswerCollector();
  route(request(path, asked), res as unknown as ServerResponse);
  await res.ended();
  const { status, headers, body } = res.written();
  return { status, headers, json: JSON.parse(body.toString("utf8")) as Record<string, unknown> };
}

describe("GET /api/app/notifications", () => {
  test.each([null, "Notifications are not allowed for this application"])(
    "says the last refusal, %s, and is never cached",
    async (lastRefusal) => {
      const notifier = fakeNotifier(undefined, lastRefusal);
      const answer = await ask(notifier, STATUS);
      expect(answer.status).toBe(200);
      expect(answer.json).toEqual({ lastRefusal });
      expect(answer.headers.get("cache-control")).toBe("no-store");
      expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect([...answer.headers.keys()].join()).not.toContain("access-control");
      // Reading it shows nothing.
      expect(notifier.test).not.toHaveBeenCalled();
    },
  );

  test("answers only GET", async () => {
    const notifier = fakeNotifier();
    const answer = await ask(notifier, STATUS, { method: "POST", body: "{}" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("GET");
    expect(notifier.test).not.toHaveBeenCalled();
  });

  test.each([
    ["another site's Host", { host: "evil.example" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["the opaque Origin the adapter gives any other page", { origin: "null" }],
    ["a request the browser calls cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", async (_what, headers) => {
    const notifier = fakeNotifier(undefined, "not allowed");
    expect((await ask(notifier, STATUS, { headers })).status).toBe(403);
    expect(notifier.lastRefusal).not.toHaveBeenCalled();
  });

  test("has nothing under it but its test", async () => {
    const answer = await ask(fakeNotifier(), "/api/app/notifications/other");
    expect(answer.status).toBe(404);
  });
});

describe("POST /api/app/notifications/test", () => {
  test.each<NotificationTestOutcome>([
    { outcome: "shown" },
    { outcome: "refused", reason: "Notifications are not allowed for this application" },
    { outcome: "unsupported" },
    { outcome: "no-answer" },
  ])("shows one test notification and answers with what macOS made of it: %o", async (outcome) => {
    const notifier = fakeNotifier(outcome);
    const answer = await ask(notifier, TEST);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(outcome);
    expect(notifier.test).toHaveBeenCalledOnce();
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });

  test("answers only POST", async () => {
    const notifier = fakeNotifier();
    const answer = await ask(notifier, TEST, { method: "GET" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(notifier.test).not.toHaveBeenCalled();
  });

  test.each([
    ["another site's Host", { host: "evil.example" }, 403],
    ["no Origin", { origin: undefined }, 403],
    ["another site's Origin", { origin: "https://evil.example" }, 403],
    ["the opaque Origin the adapter gives any other page", { origin: "null" }, 403],
    ["a request from another site", { "sec-fetch-site": "same-site" }, 403],
    ["no action", { "x-agent-lookout-action": undefined }, 403],
    ["another route's action", { "x-agent-lookout-action": "menu-bar-setting" }, 403],
    ["a form's content type", { "content-type": "application/x-www-form-urlencoded" }, 415],
    [
      "a length over the limit",
      { "content-length": String(MAX_NOTIFICATIONS_BODY_BYTES + 1) },
      413,
    ],
  ])("refuses a request with %s, and shows nothing", async (_what, headers, status) => {
    const notifier = fakeNotifier();
    const answer = await ask(notifier, TEST, { headers });
    expect(answer.status).toBe(status);
    expect(notifier.test).not.toHaveBeenCalled();
  });

  test("refuses a body larger than the limit that does not say its length", async () => {
    const notifier = fakeNotifier();
    const answer = await ask(notifier, TEST, {
      body: `{"padding": "${"x".repeat(MAX_NOTIFICATIONS_BODY_BYTES)}"}`,
    });
    expect(answer.status).toBe(413);
    expect(notifier.test).not.toHaveBeenCalled();
  });

  test.each(['{"title": "Agent Lookout"}', "[]", "null", ""])(
    "refuses the body %j: the notification takes nothing from a request",
    async (body) => {
      const notifier = fakeNotifier();
      const answer = await ask(notifier, TEST, {
        body,
        ...(body === "" && { headers: { "content-length": "0" } }),
      });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toBe("The body must be {}.");
      expect(notifier.test).not.toHaveBeenCalled();
    },
  );

  test("answers 500, and says nothing more, when the notifier fails all the same", async () => {
    const notifier = fakeNotifier();
    notifier.test.mockRejectedValueOnce(new Error("gone"));
    const answer = await ask(notifier, TEST);
    expect(answer.status).toBe(500);
    expect(answer.json).toEqual({ error: "The app ran into an unexpected problem." });
  });
});
