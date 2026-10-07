import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { createServer, preview, type InlineConfig } from "vite";
import { describe, expect, onTestFinished, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createCollector, type Collector } from "@collector/collector";
import { collectorPlugin } from "@collector/hosts/collectorPlugin";
import { makeSession } from "@tests/fixtures/session";
import { listen, request } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

/**
 * A plugin whose collectors read nothing from this machine: each one polls a
 * stand-in source every 20 ms. It records every collector it builds and which
 * of them are running, so a test can say exactly how many pollers there are.
 */
function trackedPlugin() {
  const running = new Set<number>();
  let built = 0;
  let polls = 0;

  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    poll: async () => {
      polls += 1;
      return {
        health: { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() },
        sessions: [makeSession()],
      };
    },
  };

  const plugin = collectorPlugin({
    createCollector: (): Collector => {
      built += 1;
      const number = built;
      const real = createCollector({
        version: "0.0.0-test",
        adapters: [adapter],
        intervalMs: 20,
        env: { ...process.env, AGENT_LOOKOUT_HISTORY: "off" },
      });
      return {
        ...real,
        start: () => {
          running.add(number);
          real.start();
        },
        stop: () => {
          running.delete(number);
          real.stop();
        },
      };
    },
  });

  return {
    plugin,
    /** The collectors now running, by the order they were built in. */
    running: () => [...running],
    built: () => built,
    /** How many polls happen in the next stretch of time. */
    pollsDuring: async (ms: number) => {
      const before = polls;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return polls - before;
    },
  };
}

async function projectRoot(): Promise<string> {
  // By its real, long name. Windows can give the temporary folder by its short
  // 8.3 name, such as RUNNER~1, and Vite serves a file only from under the root
  // as it finds the file by its real path.
  const root = realpathSync.native(await tempDir());
  await writeFile(path.join(root, "index.html"), "<!doctype html><title>Agent Lookout</title>");
  return root;
}

function viteConfig(root: string, tracked: ReturnType<typeof trackedPlugin>): InlineConfig {
  return {
    configFile: false,
    root,
    cacheDir: path.join(root, ".vite"),
    logLevel: "silent",
    plugins: [tracked.plugin],
    server: { host: "127.0.0.1", port: 0, watch: null },
    preview: { host: "127.0.0.1", port: 0 },
    optimizeDeps: { noDiscovery: true, include: [] },
  };
}

async function startDevServer() {
  const tracked = trackedPlugin();
  const server = await createServer(viteConfig(await projectRoot(), tracked));
  await server.listen();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  onTestFinished(close);
  const port = () => (server.httpServer?.address() as AddressInfo).port;
  return { server, tracked, port, close };
}

describe("the collector plugin in the dev server", () => {
  test("answers /api/* from the dev server and leaves every other path to Vite", async () => {
    const { port } = await startDevServer();

    const health = await request(port(), "/api/health");
    expect(health.status).toBe(200);
    expect(health.json()).toEqual({ ok: true, version: "0.0.0-test" });

    // The first poll finishes within a moment of starting.
    await expect
      .poll(async () => (await request(port(), "/api/sessions")).json<{ sessions: unknown[] }>())
      .toMatchObject({ sessions: [{ name: "demo-project" }] });

    const page = await request(port(), "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>Agent Lookout</title>");
  });

  test("the handler's own refusals still apply behind Vite", async () => {
    const { port } = await startDevServer();
    const crossSite = await request(port(), "/api/sessions", {
      headers: { Origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body).not.toContain("demo-project");

    const rebound = await request(port(), "/api/sessions", { headers: { Host: "evil.example" } });
    expect(rebound.status).toBe(403);
    expect(rebound.body).not.toContain("demo-project");
  });

  test("sends no CORS headers, not even to a preflight from another local port", async () => {
    const { server, port } = await startDevServer();
    expect(server.config.server.cors).toBe(false);

    const preflight = await request(port(), "/api/sessions", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    const read = await request(port(), "/api/sessions", {
      headers: { Origin: "http://localhost:3000" },
    });
    for (const response of [preflight, read]) {
      const corsHeaders = Object.keys(response.headers).filter((name) =>
        name.startsWith("access-control-"),
      );
      expect(corsHeaders).toEqual([]);
    }
    // The preflight reaches the handler, which answers GET only.
    expect(preflight.status).toBe(405);
  });

  test("one poller runs, and stops when the server closes", async () => {
    const { tracked, close } = await startDevServer();
    expect(tracked.running()).toEqual([1]);
    expect(await tracked.pollsDuring(200)).toBeGreaterThan(2);

    await close();
    expect(tracked.running()).toEqual([]);
    expect(await tracked.pollsDuring(200)).toBe(0);
  });

  test("after restarts exactly one poller runs, the new server's, and it keeps polling", async () => {
    const { server, tracked, port, close } = await startDevServer();

    await server.restart();
    expect(tracked.running()).toEqual([2]);
    // The old server's shutdown must not have stopped the new server's poller.
    expect(await tracked.pollsDuring(200)).toBeGreaterThan(2);
    expect((await request(port(), "/api/health")).status).toBe(200);

    await server.restart();
    await server.restart();
    expect(tracked.built()).toBe(4);
    expect(tracked.running()).toEqual([4]);
    // One poller's worth of polls, not four: 200 ms at 20 ms apart is about ten.
    const polls = await tracked.pollsDuring(200);
    expect(polls).toBeGreaterThan(2);
    expect(polls).toBeLessThan(20);

    await close();
    expect(tracked.running()).toEqual([]);
    expect(await tracked.pollsDuring(200)).toBe(0);
  });
});

describe("the collector plugin in middleware mode", () => {
  test("mounts on the host's server and stops its poller when Vite closes", async () => {
    const tracked = trackedPlugin();
    const config = viteConfig(await projectRoot(), tracked);
    const vite = await createServer({
      ...config,
      appType: "custom",
      server: { middlewareMode: true, watch: null },
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await vite.close();
    };
    onTestFinished(close);
    const port = await listen(createHttpServer(vite.middlewares));

    expect((await request(port, "/api/health")).json()).toEqual({
      ok: true,
      version: "0.0.0-test",
    });
    expect(tracked.running()).toEqual([1]);

    await close();
    expect(tracked.running()).toEqual([]);
    expect(await tracked.pollsDuring(150)).toBe(0);
  });
});

describe("the collector plugin in the preview server", () => {
  test("answers /api/* with no CORS headers and stops its poller on close", async () => {
    const tracked = trackedPlugin();
    const server = await preview(viteConfig(await projectRoot(), tracked));
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await server.close();
    };
    onTestFinished(close);
    const port = (server.httpServer.address() as AddressInfo).port;

    expect((await request(port, "/api/health")).json()).toEqual({
      ok: true,
      version: "0.0.0-test",
    });
    const preflight = await request(port, "/api/sessions", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "GET" },
    });
    expect(
      Object.keys(preflight.headers).filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
    expect(tracked.running()).toEqual([1]);

    await close();
    expect(tracked.running()).toEqual([]);
  });
});
