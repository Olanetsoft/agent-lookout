import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import { makeClaudeHome, tempDir, writeStub } from "@tests/support/node/tempFiles";

// These tests run the real entry point, `src/collector/hosts/serve.ts`, the way
// `npm start` does: as a process of its own, started by tsx. Each one is refused
// before the built dashboard is looked for, so none depends on `dist/`. What the
// host does with a build, and without one, is in standalone.test.ts.

const serveFile = fileURLToPath(
  new URL("../../../../src/collector/hosts/serve.ts", import.meta.url),
);
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
 * Codex home, an empty folder of status files, and tmux turned off.
 */
async function start(env: Record<string, string>): Promise<Started> {
  const home = await makeClaudeHome();
  const codexHome = await tempDir();
  const statusDir = await tempDir();
  const stub = await writeStub("echo '[]'");
  const child = spawn(process.execPath, [tsxCli, serveFile], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      AGENT_LOOKOUT_CLAUDE_HOME: home,
      AGENT_LOOKOUT_CLAUDE_BIN: stub,
      AGENT_LOOKOUT_CODEX_HOME: codexHome,
      AGENT_LOOKOUT_STATUS_DIR: statusDir,
      AGENT_LOOKOUT_TMUX: "off",
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
