import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { runStandalone } from "@collector/hosts/standalone";
import { request } from "@tests/support/http";
import { makeClaudeHome, tempDir, writeStub } from "@tests/support/tempFiles";

// The standalone host, run inside this process against a temporary folder, so
// what it does with a built dashboard, and without one, is checked on every run
// whether or not `npm run build` has been. The real `npm start` process is
// started in serve.test.ts.

type Signal = "SIGINT" | "SIGTERM";

/** A stand-in for the process the host runs in: it records the signals it is given and every exit. */
function standInProcess() {
  const listeners = new Map<Signal, () => void>();
  const exits: number[] = [];
  return {
    host: {
      once(signal: Signal, listener: () => void) {
        listeners.set(signal, listener);
      },
      exit(code: number) {
        exits.push(code);
      },
    },
    listeners,
    exits,
    /** Sends a signal, as Ctrl+C or `kill` would, if the host listens for it. */
    send(signal: Signal) {
      const listener = listeners.get(signal);
      listeners.delete(signal);
      listener?.();
    },
  };
}

/** Collects what the host prints, as `console` would show it. */
function printer() {
  const logged: string[] = [];
  const errors: string[] = [];
  return {
    print: { log: (line: string) => logged.push(line), error: (line: string) => errors.push(line) },
    logged,
    errors,
  };
}

/** A folder laid out like `dist/`, with a page in it or not. */
async function distFolder(withPage: boolean): Promise<string> {
  const dir = await tempDir();
  if (withPage) {
    await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Agent Lookout</title>");
  }
  return dir;
}

/**
 * Settings that name nothing on this machine: an empty Claude home, a
 * stand-in `claude` that lists no sessions and an empty Codex home, on a free
 * port. The poller runs in this process, so anything less would read the real
 * `~/.claude` and `~/.codex` and run the real `claude`.
 */
async function isolatedEnv(overrides: Record<string, string> = {}) {
  const claudeHome = await makeClaudeHome();
  const codexHome = await tempDir();
  const stub = await writeStub("echo '[]'");
  return {
    claudeHome,
    codexHome,
    env: {
      AGENT_LOOKOUT_CLAUDE_HOME: claudeHome,
      AGENT_LOOKOUT_CLAUDE_BIN: stub,
      AGENT_LOOKOUT_CODEX_HOME: codexHome,
      AGENT_LOOKOUT_PORT: "0",
      ...overrides,
    },
  };
}

/** Starts the host and makes sure it is stopped when the test finishes, however it ends. */
async function start(distDir: string, env: Record<string, string>) {
  const proc = standInProcess();
  const out = printer();
  const address = await runStandalone({ distDir, env, print: out.print, process: proc.host });
  onTestFinished(async () => {
    if (!proc.listeners.has("SIGTERM")) return;
    const before = proc.exits.length;
    proc.send("SIGTERM");
    await vi.waitFor(() => expect(proc.exits.length).toBeGreaterThan(before));
  });
  return { address, ...proc, ...out };
}

describe("the standalone host", () => {
  test("with no page in the folder it says how to build one, listens on nothing and fails", async () => {
    const { env } = await isolatedEnv();
    const host = await start(await distFolder(false), env);

    expect(host.address).toBeNull();
    expect(host.errors).toEqual([
      "The dashboard has not been built yet. Run `npm run build`, then `npm start` again.",
    ]);
    expect(host.logged).toEqual([]);
    expect(host.exits).toEqual([1]);
    // Nothing was started, so there is nothing for a signal to stop.
    expect([...host.listeners.keys()]).toEqual([]);
  });

  test("a refused address or port is said before a missing build", async () => {
    const noPage = await distFolder(false);

    const host = await start(noPage, (await isolatedEnv({ AGENT_LOOKOUT_HOST: "0.0.0.0" })).env);
    expect(host.address).toBeNull();
    expect(host.exits).toEqual([1]);
    expect(host.errors).toHaveLength(1);
    expect(host.errors[0]).toMatch(
      /^AGENT_LOOKOUT_HOST is set to 0\.0\.0\.0\. Agent Lookout only listens on this machine/,
    );

    const port = await start(noPage, (await isolatedEnv({ AGENT_LOOKOUT_PORT: "http" })).env);
    expect(port.address).toBeNull();
    expect(port.exits).toEqual([1]);
    expect(port.errors).toEqual([
      "AGENT_LOOKOUT_PORT is set to http. Use a port number from 0 to 65535, or leave it unset for 4777.",
    ]);
  });

  test("with a page it serves the page and the API on loopback, refuses a foreign Host and stops cleanly", async () => {
    const { env, claudeHome, codexHome } = await isolatedEnv();
    const host = await start(await distFolder(true), env);

    const address = host.address as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(host.logged).toEqual([
      `Agent Lookout is running at http://127.0.0.1:${address.port}`,
      "It listens on this machine only. Press Ctrl+C to stop.",
    ]);
    expect(host.errors).toEqual([]);
    expect(host.exits).toEqual([]);
    expect([...host.listeners.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);

    const page = await request(address.port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.body).toContain("<title>Agent Lookout</title>");

    const health = await request(address.port, "/api/health");
    expect(health.status).toBe(200);
    expect(health.json()).toMatchObject({ ok: true });

    // The settings it was given reached the adapters: Claude Code reads the
    // temporary registry folder, the stand-in claude lists nothing, and Codex
    // looks in the empty temporary folder.
    await expect
      .poll(
        async () =>
          (await request(address.port, "/api/sessions")).json<{
            sources: { id: string; state: string; watching?: { label: string; value: string }[] }[];
            sessions: unknown[];
          }>(),
        { timeout: 10_000 },
      )
      .toMatchObject({
        sources: [
          {
            id: "claude-code",
            state: "ok",
            watching: expect.arrayContaining([
              { label: "Registry folder", value: path.join(claudeHome, "sessions") },
            ]),
          },
          {
            id: "codex",
            state: "ok",
            watching: expect.arrayContaining([
              { label: "Sessions folder", value: path.join(codexHome, "sessions") },
            ]),
          },
        ],
        sessions: [],
      });

    for (const target of ["/", "/api/sessions"]) {
      const refused = await request(address.port, target, { headers: { Host: "evil.example" } });
      expect(refused.status, target).toBe(403);
    }

    host.send("SIGTERM");
    await vi.waitFor(() => expect(host.exits).toEqual([0]));
    // Closed: a new connection is refused, or reset if it caught the socket closing.
    await expect(request(address.port, "/api/health")).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);
  });

  test("Ctrl+C stops it the same way", async () => {
    const { env } = await isolatedEnv();
    const host = await start(await distFolder(true), env);
    const { port } = host.address as AddressInfo;

    host.send("SIGINT");

    await vi.waitFor(() => expect(host.exits).toEqual([0]));
    await expect(request(port, "/api/health")).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);
  });

  test("a port that is already taken is reported in plain words", async () => {
    const dist = await distFolder(true);
    const first = await start(dist, (await isolatedEnv()).env);
    const { port } = first.address as AddressInfo;

    const second = await start(dist, (await isolatedEnv({ AGENT_LOOKOUT_PORT: String(port) })).env);

    expect(second.address).toBeNull();
    expect(second.exits).toEqual([1]);
    expect(second.errors).toEqual([
      `Port ${port} is already in use. Stop the other program, or choose another port with AGENT_LOOKOUT_PORT.`,
    ]);
    expect(second.logged).toEqual([]);
    // The first is untouched by it.
    expect((await request(port, "/api/health")).status).toBe(200);
  });
});
