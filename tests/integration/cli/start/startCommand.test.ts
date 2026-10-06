import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { startCommand } from "@cli/start/startCommand";
import { request } from "@tests/support/node/http";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

// `agent-lookout start` inside this process, against a temporary folder that
// stands in for `dist/`, with the browser's opener replaced, so no browser is
// opened. It reads stand-in folders only, runs no `claude` command, and leaves
// tmux and Terminal alone.

type Signal = "SIGINT" | "SIGTERM";

/** Settings that name nothing on this machine, with whatever a test adds. */
async function isolatedEnv(overrides: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  return {
    AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
    AGENT_LOOKOUT_CLAUDE_FEED: "off",
    AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
    AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
    AGENT_LOOKOUT_TMUX: "off",
    AGENT_LOOKOUT_TERMINAL_JUMP: "off",
    ...overrides,
  };
}

/** A folder laid out like `dist/`, with a page in it. */
async function distFolder(): Promise<string> {
  const dir = await tempDir();
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Agent Lookout</title>");
  return dir;
}

interface Run {
  port?: number | null;
  open?: boolean;
  env?: NodeJS.ProcessEnv;
  /** What the stand-in opener answers. */
  opens?: boolean;
}

/** Starts the command, and stops it when the test finishes, however it ends. */
async function start({ port = 0, open = false, env, opens = true }: Run = {}) {
  const listeners = new Map<Signal, () => void>();
  const exits: number[] = [];
  /** Everything printed and opened, in order. */
  const said: string[] = [];
  const url = await startCommand({
    port,
    open,
    distDir: await distFolder(),
    env: env ?? (await isolatedEnv()),
    print: {
      log: (line) => said.push(`log: ${line}`),
      error: (line) => said.push(`error: ${line}`),
    },
    process: {
      once: (signal, listener) => listeners.set(signal, listener),
      exit: (code) => exits.push(code),
    },
    opener: async (address) => {
      said.push(`opened: ${address}`);
      return opens;
    },
  });
  /** Sends a signal, as Ctrl+C or `kill` would. The host listens for each once, and stops on either. */
  const stop = async (signal: Signal) => {
    const listener = listeners.get(signal);
    listeners.clear();
    listener?.();
    await vi.waitFor(() => expect(exits).toContain(0));
  };
  onTestFinished(async () => {
    if (listeners.has("SIGTERM")) await stop("SIGTERM");
  });
  return { url, said, exits, stop };
}

const portOf = (url: string | null) => Number(new URL(url ?? "").port);

describe("agent-lookout start", () => {
  test("serves the dashboard and its API on 127.0.0.1, prints the address and opens nothing", async () => {
    const run = await start();

    expect(run.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(run.said).toEqual([
      `log: Agent Lookout is running at ${run.url}`,
      "log: It listens on this machine only. Press Ctrl+C to stop.",
    ]);
    const port = portOf(run.url);
    expect((await request(port, "/")).status).toBe(200);
    expect((await request(port, "/api/health")).status).toBe(200);
  });

  test("--open opens the address once it is listening and printed", async () => {
    const run = await start({ open: true });

    expect(run.said).toEqual([
      `log: Agent Lookout is running at ${run.url}`,
      "log: It listens on this machine only. Press Ctrl+C to stop.",
      `opened: ${run.url}`,
    ]);
  });

  test("a browser that cannot be opened is one line, and the server keeps running", async () => {
    const run = await start({ open: true, opens: false });

    expect(run.said.at(-1)).toBe(`error: The browser could not be opened. Open ${run.url} in it.`);
    expect(run.exits).toEqual([]);
    expect((await request(portOf(run.url), "/api/health")).status).toBe(200);
  });

  test("--port takes the place of AGENT_LOOKOUT_PORT", async () => {
    // A setting it would refuse, so the run shows that --port was used in its place.
    const run = await start({ port: 0, env: await isolatedEnv({ AGENT_LOOKOUT_PORT: "http" }) });
    expect(run.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("with no --port, AGENT_LOOKOUT_PORT and AGENT_LOOKOUT_HOST are used", async () => {
    const run = await start({ port: null, env: await isolatedEnv({ AGENT_LOOKOUT_PORT: "0" }) });
    expect(run.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const refused = await start({
      port: null,
      env: await isolatedEnv({ AGENT_LOOKOUT_PORT: "0", AGENT_LOOKOUT_HOST: "0.0.0.0" }),
    });
    expect(refused.url).toBeNull();
    expect(refused.exits).toEqual([1]);
    expect(refused.said).toHaveLength(1);
    expect(refused.said[0]).toMatch(/^error: AGENT_LOOKOUT_HOST is set to 0\.0\.0\.0\./);
  });

  test("a port that is taken is one line that names --port, and nothing is opened", async () => {
    const first = await start();
    const port = portOf(first.url);

    const second = await start({ port, open: true });

    expect(second.url).toBeNull();
    expect(second.exits).toEqual([1]);
    expect(second.said).toEqual([
      `error: Port ${port} is already in use. Stop the other program, or choose another port with --port.`,
    ]);
  });

  test("stops on Ctrl+C and ends with 0", async () => {
    const run = await start();
    const port = portOf(run.url);

    await run.stop("SIGINT");

    expect(run.exits).toEqual([0]);
    await expect(request(port, "/api/health")).rejects.toThrow(/ECONNREFUSED|ECONNRESET/);
  });
});
