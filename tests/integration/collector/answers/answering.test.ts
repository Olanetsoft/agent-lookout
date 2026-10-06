import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test, vi } from "vitest";

import { ALLOW_OUTPUT, DENY_OUTPUT } from "@collector/answers/heldAsks";
import { createCollector } from "@collector/collector";
import type { EventsResponse } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request } from "@tests/support/node/http";
import { startStandIn, type StandIn } from "@tests/support/node/standIns";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

// Answering from end to end: the collector as every host builds it, with its
// real Claude Code adapter reading a registry folder of the test's own, its
// real socket in a folder of the test's own, the plugin's own hook script
// sending a request to it, and the page's own request answering it. The
// session is a stand-in process; no Claude Code is run.

const SCRIPT = fileURLToPath(
  new URL("../../../../plugins/agent-lookout/hooks/ask-agent-lookout.sh", import.meta.url),
);
const SESSION_ID = `claude-code:${ids.busy}`;
const COMMAND = "npm test\nnpm run build";

function entryFor(standIn: Pick<StandIn, "pid" | "procStart">, status: string) {
  const now = Date.now();
  return registryFile({
    pid: standIn.pid,
    sessionId: ids.busy,
    name: "checkout-flow",
    kind: "interactive",
    entrypoint: "cli",
    procStart: standIn.procStart,
    status,
    ...(status === "waiting" && { waitingFor: "permission prompt" }),
    startedAt: now - 60_000,
    statusUpdatedAt: now - 1_000,
  });
}

async function serve(env: Record<string, string> = {}) {
  const standIn = await startStandIn();
  const file = `${standIn.pid}.json`;
  const claudeHome = await makeClaudeHome({ [file]: entryFor(standIn, "waiting") });
  const socketPath = path.join(await tempDir(), "al", "answer.sock");
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_CLAUDE_HOME: claudeHome,
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
      ...env,
    },
    notifier: fakeSystemNotifier(),
  });
  collector.start();
  await collector.answering.start();
  onTestFinished(() => collector.stop());
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();

  const snapshot = async () => (await request(port, "/api/sessions")).json<SessionsSnapshot>();
  const session = async (): Promise<Session | undefined> =>
    (await snapshot()).sessions.find((listed) => listed.id === SESSION_ID);
  const answer = (requestId: string, decision: "allow" | "deny") =>
    request(port, "/api/permission/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: SESSION_ID, requestId, decision }),
      headers: {
        Origin: `http://localhost:${port}`,
        "Content-Type": "application/json",
        "X-Agent-Lookout-Action": "answer",
      },
    });
  const events = async () => (await request(port, "/api/events")).json<EventsResponse>().events;
  const rewrite = (status: string) =>
    writeFile(path.join(claudeHome, "sessions", file), entryFor(standIn, status));
  return { socketPath, snapshot, session, answer, events, rewrite, port };
}

/** The plugin's hook, run as Claude Code runs it, with the request on stdin. */
function hook(socketPath: string, toolName = "Bash", toolInput: unknown = { command: COMMAND }) {
  const child = spawn("/bin/sh", [SCRIPT], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent-home",
      AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) =>
    child.once("exit", (code) => resolve({ code, stdout })),
  );
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  child.stdin.end(
    JSON.stringify({
      session_id: ids.busy,
      transcript_path: "/Users/example/.claude/projects/demo/x.jsonl",
      cwd: "/Users/example/code/demo",
      hook_event_name: "PermissionRequest",
      tool_name: toolName,
      tool_input: toolInput,
    }),
  );
  return done;
}

test("Allow from the page reaches the hook, which prints the allow decision for Claude Code", async () => {
  const server = await serve();
  const answered = hook(server.socketPath);

  await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
    timeout: 5_000,
  });
  const ask = (await server.session())?.ask;
  expect(ask).toMatchObject({ tool: "Bash", command: COMMAND, allow: true });
  expect((await server.snapshot()).answering).toMatchObject({ state: "on", plugin: "seen" });

  const response = await server.answer(ask?.requestId ?? "", "allow");
  expect(response.status).toBe(200);
  expect(response.json()).toEqual({ ok: true, decision: "allow" });
  expect(await answered).toEqual({ code: 0, stdout: `${ALLOW_OUTPUT}\n` });

  // The event says what was answered, and nothing of what was asked.
  const events = await server.events();
  const event = events.find((candidate) => candidate.kind === "answered");
  expect(event).toMatchObject({ decision: "allow", by: "agent-lookout" });
  expect(JSON.stringify(events)).not.toContain("npm");
  // Answered once: the same request cannot be answered again.
  expect((await server.answer(ask?.requestId ?? "", "deny")).status).toBe(404);
});

test("Deny reaches the hook too", async () => {
  const server = await serve();
  const answered = hook(server.socketPath);
  await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
    timeout: 5_000,
  });
  const requestId = (await server.session())?.ask?.requestId ?? "";
  expect((await server.answer(requestId, "deny")).status).toBe(200);
  expect(await answered).toEqual({ code: 0, stdout: `${DENY_OUTPUT}\n` });
});

test("answered in the session: the request is let go, the hook prints nothing, and the page is told it is gone", async () => {
  const server = await serve();
  const answered = hook(server.socketPath);
  await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
    timeout: 5_000,
  });
  const requestId = (await server.session())?.ask?.requestId ?? "";

  // As a Yes in the terminal does: the registry no longer says waiting, and the hook runs on.
  await server.rewrite("busy");
  expect(await answered).toEqual({ code: 0, stdout: "" });
  expect((await server.answer(requestId, "allow")).status).toBe(404);
  expect((await server.events()).some((event) => event.kind === "answered")).toBe(false);
});

test("an edit offers Deny only, and Allow for it is refused", async () => {
  const server = await serve();
  const answered = hook(server.socketPath, "Write", {
    file_path: "/Users/example/code/demo/a.ts",
    content: "export {};",
  });
  await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
    timeout: 5_000,
  });
  const ask = (await server.session())?.ask;
  expect(ask).toMatchObject({ tool: "Write", allow: false, denyOnly: "edit" });
  expect(JSON.stringify(ask)).not.toContain("export {}");
  const refused = await server.answer(ask?.requestId ?? "", "allow");
  expect(refused.status).toBe(409);
  expect(refused.json()).toMatchObject({ reason: "not-allowable" });
  expect((await server.answer(ask?.requestId ?? "", "deny")).status).toBe(200);
  expect((await answered).stdout).toBe(`${DENY_OUTPUT}\n`);
});

test("with AGENT_LOOKOUT_ANSWER off there is no socket and no route, and the hook prints nothing", async () => {
  const server = await serve({ AGENT_LOOKOUT_ANSWER: "off" });
  expect(await hook(server.socketPath)).toEqual({ code: 0, stdout: "" });
  expect((await server.snapshot()).answering).toMatchObject({ state: "off" });
  const response = await server.answer("0".repeat(32), "allow");
  expect(response.status).toBe(405);
});
