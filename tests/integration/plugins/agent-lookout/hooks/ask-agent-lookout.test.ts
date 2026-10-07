import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test as anyTest } from "vitest";

import { ALLOW_OUTPUT, DENY_OUTPUT } from "@collector/answers/heldAsks";
import { tempDir } from "@tests/support/node/tempFiles";

// The hook is a POSIX sh script that speaks over a Unix socket, so it is run on
// macOS and Linux only. What Claude Code is told to run is read on every system.
const test = anyTest.skipIf(process.platform === "win32");

// The plugin's hook, run as Claude Code runs it: the request on stdin, with
// the socket named by AGENT_LOOKOUT_ANSWER_SOCKET, against a stand-in for
// Agent Lookout that the test answers for.

const SCRIPT = fileURLToPath(
  new URL("../../../../../plugins/agent-lookout/hooks/ask-agent-lookout.sh", import.meta.url),
);

const INPUT = JSON.stringify({
  session_id: "00000000-0000-4000-8000-000000000001",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm test" },
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runHook(env: Record<string, string>): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [SCRIPT], {
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("exit", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    // With no socket the script leaves before it reads its input, as it should,
    // so writing that input can find the pipe already closed.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") throw error;
    });
    child.stdin.end(INPUT);
  });
}

/** A stand-in for Agent Lookout's socket, answering each request as the test says. */
async function standIn(answer: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const socketPath = path.join(await tempDir(), "answer.sock");
  const seen: { headers: IncomingMessage["headers"]; url?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      seen.push({ headers: req.headers, url: req.url, body });
      answer(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { socketPath, seen };
}

test("with no socket, it prints nothing and exits 0 at once, so the session asks as usual", async () => {
  const run = await runHook({
    AGENT_LOOKOUT_ANSWER_SOCKET: path.join(await tempDir(), "answer.sock"),
  });
  expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
  expect(run.ms).toBeLessThan(1_500);
});

test("with no socket named, it looks in ~/.agent-lookout, and finding none prints nothing", async () => {
  const run = await runHook({});
  expect(run).toMatchObject({ code: 0, stdout: "", stderr: "" });
});

test("it hands the request over whole, as the one kind of request the socket takes", async () => {
  const { socketPath, seen } = await standIn((_req, res) => res.end());
  await runHook({ AGENT_LOOKOUT_ANSWER_SOCKET: socketPath });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.url).toBe("/hooks/permission-request");
  expect(seen[0]?.headers["x-agent-lookout-hook"]).toBe("permission-request");
  expect(seen[0]?.headers["content-type"]).toBe("application/json");
  expect(seen[0]?.headers.expect).toBeUndefined();
  expect(seen[0]?.body).toBe(INPUT);
});

test.each([
  ["allow", ALLOW_OUTPUT],
  ["deny", DENY_OUTPUT],
])("an answer to %s is printed for Claude Code, as it was given", async (_what, output) => {
  const { socketPath } = await standIn((_req, res) => res.end(output));
  const run = await runHook({ AGENT_LOOKOUT_ANSWER_SOCKET: socketPath });
  expect(run).toMatchObject({ code: 0, stdout: `${output}\n`, stderr: "" });
  expect(JSON.parse(run.stdout)).toEqual(JSON.parse(output));
});

test("an empty answer, the request let go, prints nothing", async () => {
  const { socketPath } = await standIn((_req, res) => res.end());
  expect(await runHook({ AGENT_LOOKOUT_ANSWER_SOCKET: socketPath })).toMatchObject({
    code: 0,
    stdout: "",
  });
});

test.each([
  ["a failure", (res: ServerResponse) => res.writeHead(500).end(ALLOW_OUTPUT)],
  ["anything but an answer", (res: ServerResponse) => res.end('{"decision":"allow"}')],
  [
    "a deny that would also save a rule",
    (res: ServerResponse) =>
      res.end(
        DENY_OUTPUT.replace(
          '"message":"',
          '"message":"x","updatedPermissions":[{"type":"addRules"}],"z":"',
        ),
      ),
  ],
  [
    "a deny that would also interrupt",
    (res: ServerResponse) =>
      res.end(DENY_OUTPUT.replace('"behavior":"deny"', '"behavior":"deny","interrupt":true')),
  ],
  [
    "an answer that would rewrite the input",
    (res: ServerResponse) =>
      res.end(
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"command":"rm -rf /"}}}}',
      ),
  ],
])("%s prints nothing and exits 0", async (_what, answer) => {
  const { socketPath } = await standIn((_req, res) => answer(res));
  expect(await runHook({ AGENT_LOOKOUT_ANSWER_SOCKET: socketPath })).toMatchObject({
    code: 0,
    stdout: "",
  });
});

test("a listener that never answers is given up on in time, with nothing printed", async () => {
  const { socketPath } = await standIn(() => {
    // Holds the request and never answers.
  });
  const run = await runHook({
    AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
    AGENT_LOOKOUT_HOOK_MAX_TIME: "1",
  });
  expect(run).toMatchObject({ code: 0, stdout: "" });
  expect(run.ms).toBeLessThan(5_000);
});

anyTest(
  "the hook Claude Code is given runs this script, under the time Claude Code gives it",
  async () => {
    const { readFile } = await import("node:fs/promises");
    const hooks = JSON.parse(
      await readFile(path.join(path.dirname(SCRIPT), "hooks.json"), "utf8"),
    ) as { hooks: Record<string, { matcher: string; hooks: Record<string, unknown>[] }[]> };
    expect(Object.keys(hooks.hooks)).toEqual(["PermissionRequest"]);
    const [hook] = hooks.hooks.PermissionRequest?.[0]?.hooks ?? [];
    expect(hook).toMatchObject({
      type: "command",
      command: '"${CLAUDE_PLUGIN_ROOT}"/hooks/ask-agent-lookout.sh',
      timeout: 600,
    });
    const script = await readFile(SCRIPT, "utf8");
    // curl gives up before Claude Code would end the hook.
    expect(script).toContain("AGENT_LOOKOUT_HOOK_MAX_TIME:-580");
    // The two answers it prints are Agent Lookout's own, letter for letter.
    expect(script).toContain(`'${ALLOW_OUTPUT}'`);
    expect(script).toContain(`'${DENY_OUTPUT}'`);
    // No ~/.curlrc is read.
    expect(script).toMatch(/"\$curl" -q /);
  },
);
