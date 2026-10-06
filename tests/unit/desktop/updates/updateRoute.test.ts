import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import type { AppUpdateStatus } from "@core/appUpdate";
import { AnswerCollector } from "@desktop/protocol/requestAdapter";
import { createUpdateRoute, MAX_UPDATE_BODY_BYTES } from "@desktop/updates/updateRoute";

const STATUS: AppUpdateStatus = {
  version: "0.2.0",
  automatic: true,
  lastCheckedAt: null,
  releasesUrl: "https://github.com/Olanetsoft/agent-lookout/releases",
  update: { phase: "idle" },
};

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

const ACTIONS: Record<string, string> = {
  "/api/app/update/check": "check-for-updates",
  "/api/app/update/install": "install-update",
  "/api/app/update/setting": "update-setting",
};

function fakeUpdater() {
  return {
    status: vi.fn(() => STATUS),
    check: vi.fn(async () => ({ ...STATUS, update: { phase: "up-to-date" as const } })),
    install: vi.fn(async () => ({ ok: true as const, status: STATUS })),
    setAutomatic: vi.fn((on: boolean) => ({ ...STATUS, automatic: on })),
  };
}

interface Asked {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
}

/** A request as Node's server would hand it over: a stream of its body, with its method, path and headers. */
function request(path: string, asked: Asked = {}): IncomingMessage {
  const method = asked.method ?? (path === "/api/app/update" ? "GET" : "POST");
  const headers: Record<string, string> = {};
  const given = {
    ...FROM_THE_PAGE,
    ...(method === "POST" && ACTIONS[path] ? { "x-agent-lookout-action": ACTIONS[path] } : {}),
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

async function ask(updater: ReturnType<typeof fakeUpdater>, path: string, asked?: Asked) {
  const route = createUpdateRoute(updater);
  const res = new AnswerCollector();
  route(request(path, asked), res as unknown as ServerResponse);
  await res.ended();
  const { status, headers, body } = res.written();
  return { status, headers, json: JSON.parse(body.toString("utf8")) as Record<string, unknown> };
}

describe("GET /api/app/update", () => {
  test("says where updates stand, and is never cached", async () => {
    const updater = fakeUpdater();
    const answer = await ask(updater, "/api/app/update");
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(STATUS);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect([...answer.headers.keys()].join()).not.toContain("access-control");
  });

  test("answers only GET", async () => {
    const answer = await ask(fakeUpdater(), "/api/app/update", { method: "POST" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("GET");
  });

  test.each([
    ["another site's Host", { host: "evil.example" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["the opaque Origin the adapter gives any other page", { origin: "null" }],
    ["a request the browser calls cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", async (_what, headers) => {
    const updater = fakeUpdater();
    expect((await ask(updater, "/api/app/update", { headers })).status).toBe(403);
    expect(updater.status).not.toHaveBeenCalled();
  });
});

describe.each(Object.keys(ACTIONS))("POST %s", (path) => {
  test("answers the app's own page", async () => {
    const answer = await ask(fakeUpdater(), path, {
      body: path.endsWith("setting") ? '{"automatic": false}' : "{}",
    });
    expect(answer.status).toBe(200);
    expect(answer.json).toHaveProperty("version", "0.2.0");
  });

  test("answers only POST", async () => {
    const answer = await ask(fakeUpdater(), path, { method: "GET" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
  });

  test.each([
    ["no Origin", { origin: undefined }, 403],
    ["another site's Origin", { origin: "https://evil.example" }, 403],
    ["the opaque Origin", { origin: "null" }, 403],
    ["a same-site request from another page", { "sec-fetch-site": "same-site" }, 403],
    ["no action", { "x-agent-lookout-action": undefined }, 403],
    ["the jump's action", { "x-agent-lookout-action": "jump" }, 403],
    ["a form's content type", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["a body said to be too long", { "content-length": String(MAX_UPDATE_BODY_BYTES + 1) }, 413],
  ])("refuses a request with %s, before it does anything", async (_what, headers, code) => {
    const updater = fakeUpdater();
    const answer = await ask(updater, path, { headers });
    expect(answer.status).toBe(code);
    expect(updater.check).not.toHaveBeenCalled();
    expect(updater.install).not.toHaveBeenCalled();
    expect(updater.setAutomatic).not.toHaveBeenCalled();
  });

  test("refuses a body longer than the limit, however it is sent", async () => {
    const updater = fakeUpdater();
    const answer = await ask(updater, path, {
      body: `{"x": "${"a".repeat(MAX_UPDATE_BODY_BYTES)}"}`,
    });
    expect(answer.status).toBe(413);
    expect(updater.check).not.toHaveBeenCalled();
    expect(updater.install).not.toHaveBeenCalled();
    expect(updater.setAutomatic).not.toHaveBeenCalled();
  });
});

describe("what each POST does with its body", () => {
  test("a check and an install take {} and nothing else", async () => {
    for (const path of ["/api/app/update/check", "/api/app/update/install"]) {
      const updater = fakeUpdater();
      for (const body of ['{"version": "9.9.9"}', "[]", "null", "", "not json"]) {
        expect((await ask(updater, path, { body })).status, `${path} ${body}`).toBe(400);
      }
      expect(updater.check).not.toHaveBeenCalled();
      expect(updater.install).not.toHaveBeenCalled();
    }
  });

  test("a check asks the updater to look now, and answers with what it found", async () => {
    const updater = fakeUpdater();
    const answer = await ask(updater, "/api/app/update/check");
    expect(updater.check).toHaveBeenCalledOnce();
    expect(answer.json.update).toEqual({ phase: "up-to-date" });
  });

  test('the switch takes {"automatic": true} or false, and nothing else', async () => {
    const updater = fakeUpdater();
    expect(
      (await ask(updater, "/api/app/update/setting", { body: '{"automatic":false}' })).json,
    ).toHaveProperty("automatic", false);
    expect(updater.setAutomatic).toHaveBeenLastCalledWith(false);
    for (const body of [
      "{}",
      '{"automatic": "off"}',
      '{"automatic": 0}',
      '{"automatic": true, "url": "https://example.com"}',
      '{"Automatic": true}',
    ]) {
      expect((await ask(updater, "/api/app/update/setting", { body })).status, body).toBe(400);
    }
    expect(updater.setAutomatic).toHaveBeenCalledOnce();
  });

  test("an install with nothing ready is refused with 409, and says where updates stand", async () => {
    const updater = fakeUpdater();
    updater.install.mockResolvedValueOnce({ ok: false, status: STATUS } as never);
    const answer = await ask(updater, "/api/app/update/install");
    expect(answer.status).toBe(409);
    expect(answer.json).toEqual({ error: "No version is ready to install here.", status: STATUS });
  });
});

describe("other addresses under /api/app", () => {
  test.each([
    "/api/app",
    "/api/app/",
    "/api/app/update/other",
    "/api/app/__proto__",
    "/api/app/update/constructor",
  ])("%s has nothing", async (path) => {
    expect((await ask(fakeUpdater(), path, { method: "POST" })).status).toBe(404);
  });
});
