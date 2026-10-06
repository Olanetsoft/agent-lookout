import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createEventStore } from "@collector/eventStore";
import { createApiHandler, type ApiHandler } from "@collector/handler";
import { createHistoryStore } from "@collector/historyStore";
import { contentSecurityPolicy } from "@collector/hosts/staticFiles";
import { APP_ORIGIN, APP_START_URL } from "@core/appAddress";
import { createAppProtocolHandler } from "@desktop/protocol/appProtocol";
import type { AppRequest } from "@desktop/protocol/requestAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

const SECRET = "secret-outside-dist";
const THEME_SCRIPT = "document.documentElement.dataset.theme = 'dark';";
const PAGE = `<!doctype html><title>Agent Lookout</title><script>${THEME_SCRIPT}</script>`;

/** The app's folder as the build lays it out: the built dashboard, and beside it files never served. */
async function makeApp() {
  const root = await tempDir();
  const dist = path.join(root, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), PAGE);
  await writeFile(path.join(dist, "assets", "index-abc123.js"), "console.log('dashboard');");
  await writeFile(path.join(dist, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(path.join(root, "main.cjs"), SECRET);
  await mkdir(path.join(root, "dist-private"));
  await writeFile(path.join(root, "dist-private", "notes.txt"), SECRET);
  await symlink(path.join(root, "main.cjs"), path.join(dist, "linked.js"));
  return { root, dist };
}

/** Answers every API request with what it was given, so a test sees what reached it. */
const echo: ApiHandler = (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ url: req.url, host: req.headers.host, origin: req.headers.origin }));
};

/** The collector's real handler, over empty stores. */
function collectorApi(): ApiHandler {
  return createApiHandler({
    version: "9.9.9-test",
    poller: {
      getSnapshot: () => ({ generatedAt: 0, sources: [], sessions: [] }),
      startedAt: 0,
    },
    events: createEventStore(),
    history: createHistoryStore(),
  });
}

async function handler() {
  const { dist } = await makeApp();
  return createAppProtocolHandler({ api: echo, distDir: dist });
}

function from(url: string, initiator?: string, init: RequestInit = {}): AppRequest {
  const request = new Request(url, init) as AppRequest;
  if (initiator !== undefined) request.initiatorOrigin = initiator;
  return request;
}

describe("the app's own scheme", () => {
  test("the window's first page is the dashboard, with the server's own policy", async () => {
    const answer = await (await handler())(from(APP_START_URL));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await answer.text()).toBe(PAGE);
    const policy = answer.headers.get("content-security-policy");
    expect(policy).toBe(contentSecurityPolicy(PAGE));
    // The page's one inline script is allowed by its hash, and nothing else is.
    const hash = createHash("sha256").update(THEME_SCRIPT, "utf8").digest("base64");
    expect(policy).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(policy).toContain("connect-src 'self'");
    expect(answer.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("a view's address is the same page, and a built file is served as itself", async () => {
    const serve = await handler();
    expect(await (await serve(from(`${APP_ORIGIN}/settings`, APP_ORIGIN))).text()).toBe(PAGE);
    const script = await serve(from(`${APP_ORIGIN}/assets/index-abc123.js`, APP_ORIGIN));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test.each([
    "/../main.cjs",
    "/%2e%2e/main.cjs",
    "/..%2fmain.cjs",
    "/../dist-private/notes.txt",
    "/linked.js",
    "/missing.js",
  ])("%s outside the built dashboard, or not in it, is never served", async (where) => {
    const answer = await (await handler())(from(`${APP_ORIGIN}${where}`, APP_ORIGIN));
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await answer.text()).not.toContain(SECRET);
  });

  test("/api/* goes to the collector's handler, as a request made on this machine by the app's own page", async () => {
    const answer = await (await handler())(from(`${APP_ORIGIN}/api/events?since=1`, APP_ORIGIN));
    expect(await answer.json()).toEqual({
      url: "/api/events?since=1",
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
    });
  });

  test("a POST for a page is refused by the static handler's own method check", async () => {
    const answer = await (
      await handler()
    )(from(`${APP_ORIGIN}/`, APP_ORIGIN, { method: "POST", body: "x" }));
    expect(answer.status).toBe(405);
  });

  test.each(["PUT", "DELETE", "OPTIONS"])(
    "a %s from the app's own page reaches the API, which refuses it by its own method check",
    async (method) => {
      const { dist } = await makeApp();
      const serve = createAppProtocolHandler({ api: collectorApi(), distDir: dist });
      const answer = await serve(from(`${APP_ORIGIN}/api/sessions`, APP_ORIGIN, { method }));
      expect(answer.status).toBe(405);
      expect(answer.headers.get("allow")).toBe("GET");
      expect(await answer.json()).toEqual({ error: "This address only answers GET requests." });
    },
  );

  test.each(["https://evil.example", "http://127.0.0.1:4777", "null"])(
    "a request %s made is refused before any handler sees it",
    async (other) => {
      const serve = await handler();
      for (const where of ["/", "/api/sessions"]) {
        const answer = await serve(from(`${APP_ORIGIN}${where}`, other));
        expect(answer.status, where).toBe(403);
        expect(await answer.text(), where).toBe("This address only answers the app's own window.");
      }
    },
  );

  test.each(["agent-lookout://other/", "agent-lookout://other/api/sessions"])(
    "another host under the scheme, %s, has nothing",
    async (url) => {
      const answer = await (await handler())(from(url, APP_ORIGIN));
      expect(answer.status).toBe(404);
    },
  );
});
