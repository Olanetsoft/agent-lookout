import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import type { PluginInstallStatus } from "@core/answers/pluginInstall";
import {
  createPluginInstallRoute,
  MAX_PLUGIN_INSTALL_BODY_BYTES,
} from "@desktop/claude-plugin/pluginInstallRoute";
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

const STATUS = "/api/app/claude-plugin";
const TOLD = "/api/app/claude-plugin/told";

/** A stand-in installer with the two things the route may reach, and nothing that runs a command. */
function fakeInstaller(status: PluginInstallStatus = { state: "installed" }) {
  let current = status;
  return {
    status: vi.fn(() => current),
    markTold: vi.fn((): PluginInstallStatus => {
      current = { state: "idle" };
      return current;
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
  const method = asked.method ?? (path === TOLD ? "POST" : "GET");
  const headers: Record<string, string> = {};
  const given = {
    ...FROM_THE_PAGE,
    ...(method === "POST" ? { "x-agent-lookout-action": "plugin-install-told" } : {}),
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

async function ask(installer: ReturnType<typeof fakeInstaller>, path: string, asked?: Asked) {
  const route = createPluginInstallRoute(installer);
  const res = new AnswerCollector();
  route(request(path, asked), res as unknown as ServerResponse);
  await res.ended();
  const { status, headers, body } = res.written();
  return { status, headers, json: JSON.parse(body.toString("utf8")) as Record<string, unknown> };
}

describe("GET /api/app/claude-plugin", () => {
  test.each<PluginInstallStatus>([
    { state: "idle" },
    { state: "running" },
    { state: "installed" },
    { state: "failed", step: "marketplace" },
  ])("says what came of the install, $state, and is never cached", async (status) => {
    const installer = fakeInstaller(status);
    const answer = await ask(installer, STATUS);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual(status);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
    expect(answer.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect([...answer.headers.keys()].join()).not.toContain("access-control");
    expect(installer.markTold).not.toHaveBeenCalled();
  });

  test("answers only GET", async () => {
    const installer = fakeInstaller();
    const answer = await ask(installer, STATUS, { method: "POST" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("GET");
    expect(installer.markTold).not.toHaveBeenCalled();
  });

  test.each([
    ["another site's Host", { host: "evil.example" }],
    ["another site's Origin", { origin: "https://evil.example" }],
    ["the opaque Origin the adapter gives any other page", { origin: "null" }],
    ["a request the browser calls cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", async (_what, headers) => {
    const installer = fakeInstaller();
    expect((await ask(installer, STATUS, { headers })).status).toBe(403);
    expect(installer.status).not.toHaveBeenCalled();
  });

  test("has nothing under it but the POST", async () => {
    const installer = fakeInstaller();
    for (const path of ["/api/app/claude-plugin/install", "/api/app/claude-plugin/retry"]) {
      expect((await ask(installer, path)).status).toBe(404);
      expect((await ask(installer, path, { method: "POST" })).status).toBe(404);
    }
    expect(installer.markTold).not.toHaveBeenCalled();
  });
});

describe("POST /api/app/claude-plugin/told", () => {
  test("remembers the Overview said it, once, and answers with what is left to say", async () => {
    const installer = fakeInstaller({ state: "failed", step: "install" });
    const answer = await ask(installer, TOLD);
    expect(answer.status).toBe(200);
    expect(answer.json).toEqual({ state: "idle" });
    expect(installer.markTold).toHaveBeenCalledOnce();
  });

  test("answers only POST", async () => {
    const installer = fakeInstaller();
    const answer = await ask(installer, TOLD, { method: "GET" });
    expect(answer.status).toBe(405);
    expect(answer.headers.get("allow")).toBe("POST");
    expect(installer.markTold).not.toHaveBeenCalled();
  });

  test.each([
    ["no Origin", { origin: undefined }, 403],
    ["another site's Origin", { origin: "https://evil.example" }, 403],
    ["a non-loopback Host", { host: "evil.example" }, 403],
    ["a request from another site", { "sec-fetch-site": "same-site" }, 403],
    ["no action", { "x-agent-lookout-action": undefined }, 403],
    ["another route's action", { "x-agent-lookout-action": "notification-test" }, 403],
    ["a form's content type", { "content-type": "application/x-www-form-urlencoded" }, 415],
    [
      "a length over the limit",
      { "content-length": String(MAX_PLUGIN_INSTALL_BODY_BYTES + 1) },
      413,
    ],
  ])("refuses a request with %s, and changes nothing", async (_what, headers, status) => {
    const installer = fakeInstaller();
    const answer = await ask(installer, TOLD, { headers });
    expect(answer.status).toBe(status);
    expect(installer.markTold).not.toHaveBeenCalled();
  });

  test("refuses a body larger than the limit that does not say its length", async () => {
    const installer = fakeInstaller();
    const answer = await ask(installer, TOLD, {
      body: `{"padding": "${"x".repeat(MAX_PLUGIN_INSTALL_BODY_BYTES)}"}`,
    });
    expect(answer.status).toBe(413);
    expect(answer.headers.get("connection")).toBe("close");
    expect(installer.markTold).not.toHaveBeenCalled();
  });

  test.each(['{"retry": true}', "[]", "null", "", '"{}"', '{"step": "install"}'])(
    "refuses the body %j",
    async (body) => {
      const installer = fakeInstaller();
      const answer = await ask(installer, TOLD, { body, headers: { "content-length": undefined } });
      expect(answer.status).toBe(400);
      expect(installer.markTold).not.toHaveBeenCalled();
    },
  );
});

test("no request starts, repeats or retries the install", async () => {
  const installer = { ...fakeInstaller({ state: "failed", step: "marketplace" }), start: vi.fn() };
  const route = createPluginInstallRoute(installer);
  for (const [path, method] of [
    [STATUS, "GET"],
    [TOLD, "POST"],
    ["/api/app/claude-plugin/start", "POST"],
    ["/api/app/claude-plugin/retry", "POST"],
    ["/api/app/claude-plugin/install", "POST"],
  ] as const) {
    const res = new AnswerCollector();
    route(request(path, { method }), res as unknown as ServerResponse);
    await res.ended();
  }
  expect(installer.start).not.toHaveBeenCalled();
});
