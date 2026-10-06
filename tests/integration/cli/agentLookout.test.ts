import { spawn } from "node:child_process";
import { copyFile, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { createCollector } from "@collector/collector";
import { createAppServer } from "@collector/hosts/server";
import type { SessionsSnapshot } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";
import { statusFile } from "@tests/fixtures/statusFiles";
import { closedPort, listen, request } from "@tests/support/node/http";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";

// The command as people run it: `bin/agent-lookout.mjs`, as a process of its
// own, asking a real collector that reads stand-in folders on a free port.
// Every run names its address, so no test ever asks an Agent Lookout that is
// running on this machine for real.

const bin = fileURLToPath(new URL("../../../bin/agent-lookout.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunHow {
  /** Another copy of the command's file to run. */
  program?: string;
  /** An output closed before the command can write to it, as `| head -0` closes stdout. */
  close?: "stdout" | "stderr";
}

/** Runs the command with an environment that holds nothing from the shell but PATH. */
function run(
  args: string[],
  env: Record<string, string> = {},
  { program = bin, close }: RunHow = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [program, ...args], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (close === "stdout") child.stdout.destroy();
    else child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    if (close === "stderr") child.stderr.destroy();
    else child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * A real collector and server on a free loopback port, reading an empty Claude
 * home, an empty Codex home and a folder of status files holding `files`, with
 * tmux off, the `claude` command never run and notifications shown nowhere.
 * Resolves once a poll has read the files.
 */
async function startLookout(files: Record<string, string>): Promise<string> {
  const statusDir = await tempDir();
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(statusDir, name), content);
  }
  const collector = createCollector({
    version: "0.0.0-test",
    env: {
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_CLAUDE_FEED: "off",
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: statusDir,
      AGENT_LOOKOUT_TMUX: "off",
    },
    notifier: fakeSystemNotifier(),
  });
  const port = await listen(createAppServer({ distDir: await tempDir(), api: collector.handler }));
  collector.start();
  onTestFinished(() => collector.stop());
  await vi.waitFor(
    async () => {
      const snapshot = (await request(port, "/api/sessions")).json<SessionsSnapshot>();
      expect(snapshot.sessions).toHaveLength(Object.keys(files).length);
    },
    { timeout: 10_000 },
  );
  return `http://127.0.0.1:${port}`;
}

/** A server of the test's own that answers every request as it is told, and writes each one down. */
async function standIn(status: number, body: string) {
  const requests: { method?: string; url?: string; headers: IncomingHttpHeaders }[] = [];
  const port = await listen(
    createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    }),
  );
  return { address: `http://127.0.0.1:${port}`, requests };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Two sessions waiting, from now: called in each test, so a slow run does not age the waits. */
function someWaiting(): Record<string, string> {
  return {
    "checkout-flow.json": statusFile({
      name: "checkout-flow",
      status: "waiting",
      reason: "permission",
      since: ago(4 * MINUTE + 12 * SECOND),
    }),
    "search-indexing.json": statusFile({
      name: "search-indexing",
      status: "waiting",
      reason: "question",
      since: ago(31 * SECOND),
    }),
    "billing-webhooks.json": statusFile({ name: "billing-webhooks", status: "working" }),
    "docs-site.json": statusFile({ name: "docs-site", status: "working" }),
    "api-rate-limits.json": statusFile({ name: "api-rate-limits", status: "idle" }),
  };
}

const NONE_WAITING = {
  "billing-webhooks.json": statusFile({ name: "billing-webhooks", status: "working" }),
  "email-templates.json": statusFile({ name: "email-templates", status: "idle" }),
};

describe("with sessions waiting", () => {
  test("prints the counts and a line for each, longest wait first, and exits with 1", async () => {
    const address = await startLookout(someWaiting());
    const ran = await run(["status", "--url", address]);

    expect(ran.stderr).toBe("");
    expect(ran.code).toBe(1);
    const lines = ran.stdout.split("\n");
    expect(lines[0]).toBe("2 need you · 2 working · 1 idle");
    // The waits have grown by however long the collector took to read them.
    expect(lines[1]).toMatch(/^checkout-flow {4}Waiting for permission {2}4m \d\ds$/);
    expect(lines[2]).toMatch(/^search-indexing {2}Asked you a question {4}\d\ds$/);
    expect(lines.slice(3)).toEqual([""]);
  }, 20_000);

  test("--json gives the same as JSON, and exits with 1", async () => {
    const address = await startLookout(someWaiting());
    const ran = await run(["status", "--json", "--url", address]);

    expect(ran.code).toBe(1);
    const json = JSON.parse(ran.stdout);
    expect(json).toMatchObject({ counted: true, needsYou: 2, working: 2, idle: 1, stale: 0 });
    expect(json.waiting).toEqual([
      {
        id: "status-files:checkout-flow.json",
        name: "checkout-flow",
        agent: "Night Shift",
        reason: "permission",
        waitingSince: expect.any(Number),
        waitedMs: expect.any(Number),
      },
      expect.objectContaining({ name: "search-indexing", reason: "question" }),
    ]);
    expect(json.waiting[0].waitedMs).toBeGreaterThanOrEqual(4 * MINUTE + 12 * SECOND);
  }, 20_000);

  test("--count prints only the number, and exits with 1", async () => {
    const address = await startLookout(someWaiting());
    expect(await run(["status", "--count", "--url", address])).toEqual({
      code: 1,
      stdout: "2\n",
      stderr: "",
    });
  }, 20_000);

  test("AGENT_LOOKOUT_URL names the address when --url does not", async () => {
    const address = await startLookout(someWaiting());
    expect(await run(["status", "--count"], { AGENT_LOOKOUT_URL: address })).toEqual({
      code: 1,
      stdout: "2\n",
      stderr: "",
    });
  }, 20_000);
});

describe("with nothing waiting", () => {
  test("each way of printing says so, and exits with 0", async () => {
    const address = await startLookout(NONE_WAITING);

    expect(await run(["status", "--url", address])).toEqual({
      code: 0,
      stdout: "Nothing needs you · 1 working · 1 idle\n",
      stderr: "",
    });
    expect(await run(["status", "--count", "--url", address])).toEqual({
      code: 0,
      stdout: "0\n",
      stderr: "",
    });
    const json = await run(["status", "--json", "--url", address]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      counted: true,
      needsYou: 0,
      working: 1,
      idle: 1,
      stale: 0,
      waiting: [],
    });
  }, 20_000);
});

describe("when it cannot find out", () => {
  test("with nothing listening, it says so in one line, with how to start it, and exits with 2", async () => {
    const address = `http://127.0.0.1:${await closedPort()}`;
    for (const mode of [[], ["--json"], ["--count"]]) {
      const ran = await run(["status", ...mode, "--url", address]);
      expect(ran).toEqual({
        code: 2,
        stdout: "",
        stderr: `Agent Lookout is not running at ${address}. Start it with agent-lookout, or with npm start or npm run dev in its folder.\n`,
      });
    }
  }, 20_000);

  test("an answer that is not Agent Lookout's is said in one line, and exits with 2", async () => {
    const page = await standIn(200, "<!doctype html><title>Something else</title>");
    expect(await run(["status", "--url", page.address])).toEqual({
      code: 2,
      stdout: "",
      stderr: `Agent Lookout could not be read at ${page.address}: its answer is not JSON.\n`,
    });

    const refused = await standIn(403, '{"error":"No."}');
    expect((await run(["status", "--count", "--url", refused.address])).stderr).toBe(
      `Agent Lookout could not be read at ${refused.address}: it answered with status 403.\n`,
    );
  }, 20_000);

  test("a server that takes the connection and never answers is given half a second, then exits with 2", async () => {
    let connectedAt = 0;
    const silent = createServer(() => {});
    silent.on("connection", () => (connectedAt = Date.now()));
    const address = `http://127.0.0.1:${await listen(silent)}`;

    const ran = await run(["status", "--count", "--url", address]);
    const waited = Date.now() - connectedAt;
    expect(ran).toEqual({
      code: 2,
      stdout: "",
      stderr: `Agent Lookout could not be read at ${address}: it did not answer in time.\n`,
    });
    // Measured from the connection, so the time it takes Node to start is left out.
    expect(waited).toBeLessThan(1_500);
  }, 20_000);

  test("when the command itself cannot load, it says so in one line, and exits with 2", async () => {
    // A copy of the file where nothing it loads can be found, as while npm ci
    // has removed node_modules in the clone.
    const copy = path.join(await tempDir(), "agent-lookout.mjs");
    await copyFile(bin, copy);

    const ran = await run(["status", "--count"], {}, { program: copy });
    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/^agent-lookout could not run: .+\n$/);
  }, 20_000);

  test("an address that is not on this machine is refused before anything is asked", async () => {
    const ran = await run(["status", "--url", "http://example.com:4777"]);
    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(ran.stderr).toMatch(/^--url must be an http address on this machine/);
  }, 20_000);

  test("a mistyped command says what went wrong in one line, and exits with 2", async () => {
    const ran = await run(["status", "--json", "--count"]);
    expect(ran).toEqual({
      code: 2,
      stdout: "",
      stderr: "Choose one of --json and --count. Run agent-lookout --help to see what it takes.\n",
    });
  }, 20_000);
});

describe("what it sends and what it prints", () => {
  test("a plain GET of /api/sessions, with no Origin and nothing said about notifications", async () => {
    const snapshot: SessionsSnapshot = {
      generatedAt: Date.now(),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
      sessions: [],
    };
    const server = await standIn(200, JSON.stringify(snapshot));
    expect((await run(["status", "--url", server.address])).code).toBe(0);

    expect(server.requests).toHaveLength(1);
    const [asked] = server.requests;
    expect(asked?.method).toBe("GET");
    expect(asked?.url).toBe("/api/sessions");
    expect(asked?.headers.host).toBe(server.address.slice("http://".length));
    expect(asked?.headers.origin).toBeUndefined();
    expect(asked?.headers["x-agent-lookout-notifications"]).toBeUndefined();
  }, 20_000);

  test("localhost reaches Agent Lookout listening on [::1] only, as npm run dev may", async () => {
    const snapshot = {
      generatedAt: Date.now(),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
      sessions: [makeSession({ name: "docs-site", status: "needs-you", statusSince: null })],
    };
    const port = await listen(
      createServer((_req, res) => res.end(JSON.stringify(snapshot))),
      "::1",
    );
    expect(await run(["status", "--count", "--url", `http://localhost:${port}`])).toEqual({
      code: 1,
      stdout: "1\n",
      stderr: "",
    });
  }, 20_000);

  test("a reader that stops early changes nothing: the exit code still says what was found", async () => {
    const quiet: SessionsSnapshot = {
      generatedAt: Date.now(),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
      sessions: [],
    };
    const server = await standIn(200, JSON.stringify(quiet));
    for (const mode of [[], ["--json"], ["--count"]]) {
      const ran = await run(["status", ...mode, "--url", server.address], {}, { close: "stdout" });
      expect(ran, JSON.stringify(mode)).toEqual({ code: 0, stdout: "", stderr: "" });
    }

    const address = `http://127.0.0.1:${await closedPort()}`;
    const unheard = await run(["status", "--count", "--url", address], {}, { close: "stderr" });
    expect(unheard.code).toBe(2);
  }, 20_000);

  test("a hostile name reaches the terminal with nothing in it a terminal would act on", async () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const name = `${esc}]0;owned${bel}${esc}[2J${esc}[31mcheckout-flow${esc}[0m\nsecond line`;
    const snapshot = {
      generatedAt: Date.now(),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
      sessions: [
        makeSession({ name, status: "needs-you", waitingReason: "permission", statusSince: null }),
      ],
    };
    const server = await standIn(200, JSON.stringify(snapshot));

    const text = await run(["status", "--url", server.address]);
    expect(text.code).toBe(1);
    expect(text.stdout).toBe(
      "1 needs you · 0 working · 0 idle\ncheckout-flow second line  Waiting for permission  –\n",
    );

    const json = await run(["status", "--json", "--url", server.address]);
    expect(json.stdout).not.toContain(esc);
    expect(JSON.parse(json.stdout).waiting[0].name).toBe(name);
  }, 20_000);

  test("run as tmux runs a status line, a # in a name is doubled, and only then", async () => {
    const snapshot = {
      generatedAt: Date.now(),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
      sessions: [makeSession({ name: "#[fg=red]#{host}", status: "needs-you", statusSince: null })],
    };
    const server = await standIn(200, JSON.stringify(snapshot));

    // Neither stdin nor stdout of the child is a terminal, as with a job tmux runs.
    const asTmux = await run(["status", "--url", server.address], { TMUX: "/tmp/tmux-0/x,1,0" });
    expect(asTmux.stdout.split("\n")[1]).toBe("##[fg=red]##{host}  Waiting for you  –");
    const elsewhere = await run(["status", "--url", server.address]);
    expect(elsewhere.stdout.split("\n")[1]).toBe("#[fg=red]#{host}  Waiting for you  –");
  }, 20_000);

  test("--help prints the usage and the exit codes, and exits with 0", async () => {
    const ran = await run(["--help"]);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toMatch(/^Usage: agent-lookout \[start\] \[--port <number>\] \[--open\]\n/);
    expect(ran.stdout).toContain("agent-lookout status [--json | --count]");
    expect(ran.stdout).toContain("1  One or more sessions need you");
  }, 20_000);
});

/**
 * A folder laid out as the package is, with a copy of the command's file in
 * `bin/` and whatever else the test writes. `link` names folders of this
 * clone to put in it as links, such as `src` and `node_modules`, so the copy
 * runs this clone's own code.
 */
async function packageFolder(
  files: Record<string, string>,
  link: string[] = [],
): Promise<{ dir: string; program: string }> {
  // By its real path, which is how Node names the file it runs.
  const dir = await realpath(await tempDir());
  await mkdir(path.join(dir, "bin"));
  const program = path.join(dir, "bin", "agent-lookout.mjs");
  await copyFile(bin, program);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  for (const name of link) await symlink(path.join(repoRoot, name), path.join(dir, name));
  return { dir, program };
}

/** A stand-in for a module the command loads, which says which one ran and with what. */
const standInCommand = (which: string) => `
export async function runCommand({ argv, stdout, distDir }) {
  stdout.write(${JSON.stringify(which)} + " ran " + JSON.stringify(argv) + " for " + distDir + "\\n");
  return 0;
}
`;

describe("which code it runs", () => {
  test("installed, with no src/ beside it, it runs the bundle in dist/cli/ and serves dist/", async () => {
    const pkg = await packageFolder({
      "dist/cli/agent-lookout.js": standInCommand("the bundle"),
    });

    const ran = await run(["status", "--count"], {}, { program: pkg.program });

    expect(ran).toEqual({
      code: 0,
      stdout: `the bundle ran ["status","--count"] for ${path.join(pkg.dir, "dist")}${path.sep}\n`,
      stderr: "",
    });
  }, 20_000);

  test("in a clone, with src/ beside it, it runs the source through tsx, not a bundle left in dist/", async () => {
    const clone = await packageFolder(
      {
        "package.json": JSON.stringify({ type: "module" }),
        "src/cli/agentLookout.ts": standInCommand("the source"),
        "dist/cli/agent-lookout.js": standInCommand("the bundle"),
      },
      ["node_modules"],
    );

    const ran = await run(["mcp"], {}, { program: clone.program });

    expect(ran.stderr).toBe("");
    expect(ran.stdout).toBe(
      `the source ran ["mcp"] for ${path.join(clone.dir, "dist")}${path.sep}\n`,
    );
    expect(ran.code).toBe(0);
  }, 20_000);

  test("with neither, it says so in one line, and exits with 2", async () => {
    const empty = await packageFolder({});

    const ran = await run(["--help"], {}, { program: empty.program });

    expect(ran.code).toBe(2);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toMatch(/^agent-lookout could not run: .+\n$/);
  }, 20_000);
});

describe("agent-lookout start, as a process", () => {
  test("serves the dist/ beside bin/ on the port it is given, prints the address, and stops on Ctrl+C with 0", async () => {
    // This clone's own code, serving a stand-in for dist/, so no build is needed or read.
    const clone = await packageFolder(
      { "dist/index.html": "<!doctype html><title>Agent Lookout</title>" },
      ["src", "node_modules"],
    );
    const child = spawn(process.execPath, [clone.program, "--port", "0"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
        AGENT_LOOKOUT_CLAUDE_FEED: "off",
        AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
        AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    onTestFinished(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    });
    let printed = "";
    child.stdout.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (printed += chunk.toString("utf8")));

    // The two lines can arrive in separate chunks, so wait for the second as well.
    await vi.waitFor(
      () => expect(printed).toMatch(/is running at http:\/\/127\.0\.0\.1:\d+\n.*\n/),
      {
        timeout: 15_000,
      },
    );
    const port = Number(/127\.0\.0\.1:(\d+)/.exec(printed)?.[1]);
    expect(printed).toBe(
      `Agent Lookout is running at http://127.0.0.1:${port}\nIt listens on this machine only. Press Ctrl+C to stop.\n`,
    );
    expect((await request(port, "/")).body).toContain("<title>Agent Lookout</title>");
    expect((await request(port, "/api/health")).status).toBe(200);

    child.kill("SIGINT");
    expect(await exited).toBe(0);
  }, 30_000);
});
