import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  createMenuBarRoute,
  MAX_MENU_BAR_BODY_BYTES,
  showIn,
} from "@desktop/menu-bar/menuBarRoute";
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

const SETTING = "/api/app/menu-bar/setting";

function fakeMenuBar(show = true) {
  let shown = show;
  return {
    status: vi.fn(() => ({ show: shown })),
    setShown: vi.fn((next: boolean) => {
      shown = next;
      return { show: shown };
    }),
  };
}

interface Asked {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}

/** A request as Node's server would hand it over: a stream of its body, with its method, path and headers. */
function request(path: string, asked: Asked = {}): IncomingMessage {
  const method = asked.method ?? (path === SETTING ? "POST" : "GET");
  const headers: Record<string, string> = {};
  const given = {
    ...FROM_THE_PAGE,
    ...(method === "POST" ? { "x-agent-lookout-action": "menu-bar-setting" } : {}),
    ...asked.headers,
  };
  for (const [name, value] of Object.entries(given)) if (value !== undefined) headers[name] = value;
  const body = asked.body ?? (method === "POST" ? '{"show": false}' : "");
  return Object.assign(Readable.from(body === "" ? [] : [Buffer.from(body)]), {
    method,
    url: path,
    headers,
  }) as unknown as IncomingMessage;
}

async function ask(menuBar: ReturnType<typeof fakeMenuBar>, path: string, asked?: Asked) {
  const route = createMenuBarRoute(menuBar);
  const res = new AnswerCollector();
  route(request(path, asked), res as unknown as ServerResponse);
  await res.ended();
  const { status, headers, body } = res.written();
  return { status, headers, json: JSON.parse(body.toString("utf8")) as Record<string, unknown> };
}

describe("GET /api/app/menu-bar", () => {
  test("says whether the item is shown, and is never cached", async () => {
    const answer = await ask(fakeMenuBar(false), "/api/app/menu-bar");
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ show: false });
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect([...answer.headers.keys()].join()).not.toContain("access-control");
  });

  test("answers only GET", async () => {
    const answer = await ask(fakeMenuBar(), "/api/app/menu-bar", {
      method: "POST",
      body: "{}",
    });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("GET");
  });

  test.each([
    ["another site's Host", { host: "evil.example" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["the opaque Origin the adapter gives any other page", { origin: "null" }],
    ["a request the browser calls cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", async (_what, headers) => {
    const menuBar = fakeMenuBar();
    expect((await ask(menuBar, "/api/app/menu-bar", { headers })).status).toBe(403);
    expect(menuBar.status).not.toHaveBeenCalled();
  });

  test("has nothing under it but its setting", async () => {
    const answer = await ask(fakeMenuBar(), "/api/app/menu-bar/other");
    expect(answer.status).toBe(404);
  });
});

describe("POST /api/app/menu-bar/setting", () => {
  test.each([
    ['{"show": false}', false],
    ['{"show":true}', true],
  ])("turns the item on or off with %s, and answers with where it stands", async (body, show) => {
    const menuBar = fakeMenuBar(!show);
    const answer = await ask(menuBar, SETTING, { body });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ show });
    expect(menuBar.setShown).toHaveBeenCalledExactlyOnceWith(show);
  });

  test("answers only POST", async () => {
    const answer = await ask(fakeMenuBar(), SETTING, { method: "GET" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
  });

  test.each([
    ["no Origin", { origin: undefined }, 403],
    ["another site's Origin", { origin: "https://evil.example" }, 403],
    ["a request from another site", { "sec-fetch-site": "same-site" }, 403],
    ["no action", { "x-agent-lookout-action": undefined }, 403],
    ["another route's action", { "x-agent-lookout-action": "update-setting" }, 403],
    ["a form's content type", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["a length over the limit", { "content-length": String(MAX_MENU_BAR_BODY_BYTES + 1) }, 413],
  ])("refuses a request with %s, and changes nothing", async (_what, headers, status) => {
    const menuBar = fakeMenuBar();
    const answer = await ask(menuBar, SETTING, { headers });
    expect(answer.status).toBe(status);
    expect(menuBar.setShown).not.toHaveBeenCalled();
  });

  test("refuses a body larger than the limit that does not say its length", async () => {
    const menuBar = fakeMenuBar();
    const answer = await ask(menuBar, SETTING, {
      body: `{"show": false, "padding": "${"x".repeat(MAX_MENU_BAR_BODY_BYTES)}"}`,
    });
    expect(answer.status).toBe(413);
    expect(menuBar.setShown).not.toHaveBeenCalled();
  });

  test.each(["{}", '{"show": "off"}', '{"show": false, "more": 1}', '{"automatic": false}', "[]"])(
    "refuses the body %s",
    async (body) => {
      const menuBar = fakeMenuBar();
      const answer = await ask(menuBar, SETTING, { body });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toBe('The body must be {"show": true} or {"show": false}.');
      expect(menuBar.setShown).not.toHaveBeenCalled();
    },
  );
});

test("a body is read as the switch only when it is exactly that", () => {
  expect(showIn('{"show": true}')).toBe(true);
  expect(showIn('{"show": false}')).toBe(false);
  expect(showIn("")).toBeNull();
  expect(showIn("null")).toBeNull();
  expect(showIn('{"show": null}')).toBeNull();
  expect(showIn('{"Show": true}')).toBeNull();
});
