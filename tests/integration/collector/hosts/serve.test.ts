import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { EmailStatusResponse, WebhookStatusResponse } from "@core/api";
import type { SessionsSnapshot } from "@core/sessions/session";
import { request } from "@tests/support/node/http";
import { makeClaudeHome, tempDir, writeStub } from "@tests/support/node/tempFiles";

// These tests run the real entry point, `src/collector/hosts/serve.ts`, the way
// `npm start` does: as a process of its own, started by tsx. Each one is refused
// before the built dashboard is looked for, so none depends on `dist/`. What the
// host does with a build, and without one, is in standalone.test.ts. The one
// that has to get past that check runs the same host from a copy of the entry
// point that serves a stand-in for `dist/`.

const serveFile = fileURLToPath(
  new URL("../../../../src/collector/hosts/serve.ts", import.meta.url),
);
const standaloneUrl = new URL("../../../../src/collector/hosts/standalone.ts", import.meta.url)
  .href;
const moduleLogUrl = new URL("../../../support/node/moduleLog.mjs", import.meta.url).href;
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const ownGroup = process.platform !== "win32";

interface Started {
  child: ChildProcess;
  /** Everything printed so far, stdout and stderr together. */
  output: () => string;
  /** Resolves with the exit code, or null if a signal ended the process. */
  exited: Promise<number | null>;
}

/**
 * Starts the server with an environment that names nothing on this machine: an
 * empty Claude home, a stand-in `claude` that lists no sessions, an empty
 * Codex home, an empty folder of status files, and tmux turned off. Nothing else
 * is taken from the shell that runs the tests. `entry` is the file tsx runs,
 * `serve.ts` unless one is given.
 */
async function start(env: Record<string, string>, entry = serveFile): Promise<Started> {
  const home = await makeClaudeHome();
  const codexHome = await tempDir();
  const statusDir = await tempDir();
  const stub = await writeStub("echo '[]'");
  const child = spawn(process.execPath, [tsxCli, entry], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      AGENT_LOOKOUT_CLAUDE_HOME: home,
      AGENT_LOOKOUT_CLAUDE_BIN: stub,
      AGENT_LOOKOUT_CODEX_HOME: codexHome,
      AGENT_LOOKOUT_STATUS_DIR: statusDir,
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_HISTORY: "off",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // tsx runs the server as a child of its own. A group of their own lets the
    // clean-up below stop both, so a failed test never leaves a server behind.
    detached: ownGroup,
  });
  let printed = "";
  child.stdout?.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  onTestFinished(async () => {
    try {
      if (ownGroup && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // Everything in the group has already gone.
    }
    await exited;
  });
  return { child, output: () => printed, exited };
}

describe("npm start, as a real process", () => {
  test.each([
    [
      "0.0.0.0",
      /AGENT_LOOKOUT_HOST is set to 0\.0\.0\.0\. Agent Lookout only listens on this machine/,
    ],
    ["192.168.1.20", /only listens on this machine/],
    ["example.com", /only listens on this machine/],
  ])(
    "refuses to listen on %s, says why and exits with an error",
    async (host, message) => {
      const server = await start({ AGENT_LOOKOUT_HOST: host, AGENT_LOOKOUT_PORT: "0" });
      expect(await server.exited).toBe(1);
      expect(server.output()).toMatch(message);
      expect(server.output()).not.toContain("is running at");
      // A sentence for a person, not a stack trace.
      expect(server.output()).not.toMatch(/\n\s+at /);
    },
    20_000,
  );

  test("with no email or webhook settings, it never loads the mail library or the HTTPS client, and says both are off", async () => {
    // `serve.ts` with a stand-in for `dist/`, so the host gets as far as polling.
    const dir = await tempDir();
    const dist = path.join(dir, "dist");
    await mkdir(dist);
    await writeFile(path.join(dist, "index.html"), "<!doctype html><title>Agent Lookout</title>");
    const entry = path.join(dir, "start.mts");
    await writeFile(
      entry,
      `import { runStandalone } from ${JSON.stringify(standaloneUrl)};\n` +
        `await runStandalone({ distDir: ${JSON.stringify(dist)}, env: process.env, print: console, process });\n`,
    );
    const log = path.join(dir, "modules.txt");

    const server = await start(
      {
        AGENT_LOOKOUT_PORT: "0",
        MODULE_LOG_FILE: log,
        NODE_OPTIONS: `--import=${moduleLogUrl}`,
      },
      entry,
    );
    const running = /is running at http:\/\/127\.0\.0\.1:(\d+)/;
    await vi.waitFor(() => expect(server.output()).toMatch(running), { timeout: 15_000 });
    const port = Number(running.exec(server.output())?.[1]);
    // Once a poll has been answered, everything a poll loads has been loaded.
    await vi.waitFor(
      async () => {
        const snapshot = (await request(port, "/api/sessions")).json<SessionsSnapshot>();
        expect(snapshot.sources.length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );

    expect((await request(port, "/api/email")).json<EmailStatusResponse>()).toEqual({
      on: false,
      to: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    expect((await request(port, "/api/webhook")).json<WebhookStatusResponse>()).toEqual({
      on: false,
      host: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    const loaded = await readFile(log, "utf8");
    // The log is known to work: it holds the collector itself.
    expect(loaded).toContain("/src/collector/collector.ts");
    expect(loaded).not.toContain("/node_modules/nodemailer/");
    expect(loaded).not.toMatch(/^node:https$/m);
    expect(server.output()).not.toContain("Email notifications are off");
    expect(server.output()).not.toContain("Webhook notifications are off");
  }, 30_000);

  test.each(["http", "-1", "70000", "50.5"])(
    "refuses the port %s, says why and exits with an error",
    async (port) => {
      const server = await start({ AGENT_LOOKOUT_PORT: port });
      expect(await server.exited).toBe(1);
      expect(server.output()).toContain(`AGENT_LOOKOUT_PORT is set to ${port}.`);
      expect(server.output()).toContain("Use a port number from 0 to 65535");
      expect(server.output()).not.toMatch(/\n\s+at /);
    },
    20_000,
  );
});
