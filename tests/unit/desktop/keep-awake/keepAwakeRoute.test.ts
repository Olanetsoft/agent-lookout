import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import {
  createKeepAwakeRoute,
  MAX_KEEP_AWAKE_BODY_BYTES,
  onIn,
} from "@desktop/keep-awake/keepAwakeRoute";
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

const SETTING = "/api/app/keep-awake/setting";

function fakeKeepAwake(on = false) {
  let current = on;
  return {
    status: vi.fn(() => ({ on: current })),
    setOn: vi.fn((next: boolean) => {
      current = next;
      return { on: current };
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
    ...(method === "POST" ? { "x-agent-lookout-action": "keep-awake-setting" } : {}),
    ...asked.headers,
  };
  for (const [name, value] of Object.entries(given)) if (value !== undefined) headers[name] = value;
  const body = asked.body ?? (method === "POST" ? '{"on": true}' : "");
  return Object.assign(Readable.from(body === "" ? [] : [Buffer.from(body)]), {
    method,
    url: path,
    headers,
  }) as unknown as IncomingMessage;
}

async function ask(keepAwake: ReturnType<typeof fakeKeepAwake>, path: string, asked?: Asked) {
  const route = createKeepAwakeRoute(keepAwake);
  const res = new AnswerCollector();
  route(request(path, asked), res as unknown as ServerResponse);
  await res.ended();
  const { status, headers, body } = res.written();
  return { status, headers, json: JSON.parse(body.toString("utf8")) as Record<string, unknown> };
}

describe("GET /api/app/keep-awake", () => {
  test("says whether the switch is on, and is never cached", async () => {
    const answer = await ask(fakeKeepAwake(true), "/api/app/keep-awake");
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ on: true });
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect([...answer.headers.keys()].join()).not.toContain("access-control");
  });

  test("answers only GET", async () => {
    const answer = await ask(fakeKeepAwake(), "/api/app/keep-awake", {
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
    const keepAwake = fakeKeepAwake();
    expect((await ask(keepAwake, "/api/app/keep-awake", { headers })).status).toBe(403);
    expect(keepAwake.status).not.toHaveBeenCalled();
  });

  test("has nothing under it but its setting", async () => {
    const answer = await ask(fakeKeepAwake(), "/api/app/keep-awake/other");
    expect(answer.status).toBe(404);
  });
});

describe("POST /api/app/keep-awake/setting", () => {
  test.each([
    ['{"on": true}', true],
    ['{"on":false}', false],
  ])("turns the switch on or off with %s, and answers with where it stands", async (body, on) => {
    const keepAwake = fakeKeepAwake(!on);
    const answer = await ask(keepAwake, SETTING, { body });
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ on });
    expect(keepAwake.setOn).toHaveBeenCalledExactlyOnceWith(on);
  });

  test("answers only POST", async () => {
    const answer = await ask(fakeKeepAwake(), SETTING, { method: "GET" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
  });

  test.each([
    ["no Origin", { origin: undefined }, 403],
    ["another site's Origin", { origin: "https://evil.example" }, 403],
    ["another site's Host", { host: "evil.example" }, 403],
    ["a request from another site", { "sec-fetch-site": "same-site" }, 403],
    ["no action", { "x-agent-lookout-action": undefined }, 403],
    ["the menu bar's action", { "x-agent-lookout-action": "menu-bar-setting" }, 403],
    ["a form's content type", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["a length over the limit", { "content-length": String(MAX_KEEP_AWAKE_BODY_BYTES + 1) }, 413],
  ])("refuses a request with %s, and changes nothing", async (_what, headers, status) => {
    const keepAwake = fakeKeepAwake();
    const answer = await ask(keepAwake, SETTING, { headers });
    expect(answer.status).toBe(status);
    expect(keepAwake.setOn).not.toHaveBeenCalled();
  });

  test("refuses a body larger than the limit that does not say its length", async () => {
    const keepAwake = fakeKeepAwake();
    const answer = await ask(keepAwake, SETTING, {
      body: `{"on": true, "padding": "${"x".repeat(MAX_KEEP_AWAKE_BODY_BYTES)}"}`,
    });
    expect(answer.status).toBe(413);
    expect(keepAwake.setOn).not.toHaveBeenCalled();
  });

  test.each(["{}", '{"on": "true"}', '{"on": true, "more": 1}', '{"show": true}', "[]", "true"])(
    "refuses the body %s",
    async (body) => {
      const keepAwake = fakeKeepAwake();
      const answer = await ask(keepAwake, SETTING, { body });
      expect(answer.status).toBe(400);
      expect(answer.json.error).toBe('The body must be {"on": true} or {"on": false}.');
      expect(keepAwake.setOn).not.toHaveBeenCalled();
    },
  );
});

test("a body is read as the switch only when it is exactly that", () => {
  expect(MAX_KEEP_AWAKE_BODY_BYTES).toBe(64);
  expect(onIn('{"on": true}')).toBe(true);
  expect(onIn('{"on": false}')).toBe(false);
  expect(onIn("")).toBeNull();
  expect(onIn("null")).toBeNull();
  expect(onIn('{"on": null}')).toBeNull();
  expect(onIn('{"On": true}')).toBeNull();
  expect(onIn('{"on": 1}')).toBeNull();
});
