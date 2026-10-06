import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { ALLOW_OUTPUT, DENY_OUTPUT } from "@collector/answers/heldAsks";
import { createCollector } from "@collector/collector";
import type { EventsResponse } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { listen, request } from "@tests/support/node/http";
import { startStandIn, type StandIn } from "@tests/support/node/standIns";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

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

/**
 * The collector over a registry folder of the test's own, with one session in
 * it, waiting unless `status` says otherwise. `now` is the collector's clock,
 * which a test of the time rules moves ahead.
 */
async function serve(
  env: Record<string, string> = {},
  { status = "waiting", now }: { status?: string; now?: () => number } = {},
) {
  const standIn = await startStandIn();
  const file = `${standIn.pid}.json`;
  const claudeHome = await makeClaudeHome({ [file]: entryFor(standIn, status) });
  const socketPath = path.join(await tempDir(), "al", "answer.sock");
  const notifier = fakeSystemNotifier();
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: claudeHome,
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
      ...env,
    },
    notifier,
    now,
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
  return { socketPath, snapshot, session, answer, events, rewrite, port, collector, notifier };
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

describe("the time rules, for a wait answered from the page", () => {
  const MINUTE = 60_000;

  /** A settings file of the test's own, holding these rules. */
  async function settingsWith(rules: TimeRules): Promise<string> {
    const file = path.join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ timeRules: rules }));
    return file;
  }

  /** The collector's clock, which the test moves ahead. */
  function clock() {
    let ahead = 0;
    return {
      now: () => Date.now() + ahead,
      forward(ms: number) {
        ahead += ms;
      },
    };
  }

  /** "14:05": a moment on this computer's clock, as quiet hours are set. */
  function clockAt(at: number): string {
    const date = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** Answers the request the hook sent, as the page does, and lets Claude Code go on, as it does then. */
  async function answerAndGoOn(
    server: Awaited<ReturnType<typeof serve>>,
    decision: "allow" | "deny",
  ) {
    const answered = hook(server.socketPath);
    await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
      timeout: 5_000,
    });
    const requestId = (await server.session())?.ask?.requestId ?? "";
    expect((await server.answer(requestId, decision)).status).toBe(200);
    expect((await answered).code).toBe(0);
    await server.rewrite("busy");
    await server.collector.poller.pollOnce();
    expect((await server.session())?.status).toBe("working");
  }

  const REMIND_AFTER_A_MINUTE: TimeRules = {
    ...DEFAULT_TIME_RULES,
    longWait: { on: true, minutes: 1 },
  };

  test("a wait no one answers is reminded of once it has waited the minute", async () => {
    const time = clock();
    const server = await serve(
      {
        AGENT_LOOKOUT_NOTIFICATIONS: "on",
        AGENT_LOOKOUT_SETTINGS_FILE: await settingsWith(REMIND_AFTER_A_MINUTE),
      },
      { now: time.now },
    );
    time.forward(2 * MINUTE);
    await server.collector.poller.pollOnce();
    expect(server.notifier.shown).toEqual([
      { title: "checkout-flow", body: "Has waited 2 minutes for permission" },
    ]);
  });

  test.each(["allow", "deny"] as const)(
    "a wait answered with %s is never reminded of",
    async (decision) => {
      const time = clock();
      const server = await serve(
        {
          AGENT_LOOKOUT_NOTIFICATIONS: "on",
          AGENT_LOOKOUT_SETTINGS_FILE: await settingsWith(REMIND_AFTER_A_MINUTE),
        },
        { now: time.now },
      );
      await answerAndGoOn(server, decision);
      time.forward(2 * MINUTE);
      await server.collector.poller.pollOnce();
      time.forward(10 * MINUTE);
      await server.collector.poller.pollOnce();
      expect(server.notifier.shown).toEqual([]);
    },
  );

  test("a wait held through quiet hours and answered with Allow is summed up as answered, and not told of when they end", async () => {
    const time = clock();
    const start = Date.now();
    const quiet: TimeRules = {
      ...DEFAULT_TIME_RULES,
      quietHours: {
        ...DEFAULT_TIME_RULES.quietHours,
        on: true,
        from: clockAt(start - 60 * MINUTE),
        to: clockAt(start + 60 * MINUTE),
      },
    };
    const server = await serve(
      {
        AGENT_LOOKOUT_NOTIFICATIONS: "on",
        AGENT_LOOKOUT_SETTINGS_FILE: await settingsWith(quiet),
      },
      { status: "busy", now: time.now },
    );
    // The wait begins in the quiet hours, so it is held.
    await server.rewrite("waiting");
    await server.collector.poller.pollOnce();
    expect((await server.snapshot()).quiet).toBe(true);
    await answerAndGoOn(server, "allow");
    expect(server.notifier.shown).toEqual([]);

    // Three hours on, the quiet hours are over.
    time.forward(3 * 60 * MINUTE);
    await server.collector.poller.pollOnce();
    expect((await server.snapshot()).quiet).toBe(false);
    expect(server.notifier.shown).toEqual([
      { title: "While quiet", body: "checkout-flow waited under a minute" },
    ]);
  });
});
