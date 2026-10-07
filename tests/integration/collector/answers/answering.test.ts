import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, onTestFinished, test as anyTest, vi } from "vitest";

import { ALLOW_OUTPUT, DENY_OUTPUT, type StatusReader } from "@collector/answers/heldAsks";
import { createRegistryStatus } from "@collector/answers/registryStatus";
import { createCollector, type CollectorOptions } from "@collector/collector";
import { createSmtpSender } from "@collector/email/smtpSender";
import { createNtfySender } from "@collector/ntfy/ntfySender";
import { createPushoverSender } from "@collector/pushover/pushoverSender";
import type { WebhookPost } from "@collector/webhook/webhookMessage";
import { createHttpSender } from "@collector/webhook/webhookSender";
import type { EventsResponse, WaitsResponse } from "@core/api";
import type { RuleWords } from "@core/permission-rules/permissionRules";
import { isStatusEvent, type Session, type SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { ANSWER_HOLDS_MS } from "@core/waits/answeredWaits";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import { decodedHeader, headerValues, startSmtpServer } from "@tests/support/channels/smtp";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { startWebhookServer } from "@tests/support/channels/webhook";
import { listen, request } from "@tests/support/node/http";
import { runPermissionHook } from "@tests/support/plugins/permissionHook";
import { startStandIn, type StandIn } from "@tests/support/node/standIns";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// Answering is for macOS and Linux: the plugin's hook is a POSIX sh script, and
// it reaches Agent Lookout through a Unix socket. Windows has neither.
const test = anyTest.skipIf(process.platform === "win32");

// Answering from end to end: the collector as every host builds it, with its
// real Claude Code adapter reading a registry folder of the test's own, its
// real socket in a folder of the test's own, the plugin's own hook script
// sending a request to it, and the page's own request answering it. The
// session is a stand-in process; no Claude Code is run.

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

/** How the collector is built beyond its settings, for the tests that need more. */
type Built = Pick<
  CollectorOptions,
  | "now"
  | "intervalMs"
  | "createEmailSender"
  | "createWebhookSender"
  | "createNtfySender"
  | "createPushoverSender"
  | "warn"
> & {
  /** Takes the beat that checks the held requests, which then runs only when the test runs it. */
  beat?: (run: () => void) => void;
};

/**
 * The collector over a registry folder of the test's own, with one session in
 * it, waiting unless `status` says otherwise. `now` is the collector's clock,
 * which a test of the time rules moves ahead.
 */
async function serve(
  env: Record<string, string> = {},
  { status = "waiting", beat, ...built }: { status?: string } & Built = {},
) {
  const standIn = await startStandIn();
  const file = `${standIn.pid}.json`;
  const claudeHome = await makeClaudeHome({ [file]: entryFor(standIn, status) });
  const socketPath = path.join(await tempDir(), "al", "answer.sock");
  const notifier = fakeSystemNotifier();
  /** The registry files the held requests' checks have read so far, as the collector reads them. */
  let reads = 0;
  let registry: StatusReader | null = null;
  const counted: StatusReader = {
    async statusOf(sessionId) {
      const reading = await (registry as StatusReader).statusOf(sessionId);
      reads += 1;
      return reading;
    },
  };
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
    ...built,
    ...(beat && {
      answering: {
        status: counted,
        every: (run) => {
          beat(run);
          return () => {};
        },
      },
    }),
  });
  registry = createRegistryStatus({
    snapshot: () => collector.poller.getSnapshot(),
    env: { AGENT_LOOKOUT_CLAUDE_HOME: claudeHome },
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
  // Written whole and then renamed into place, as a poll on the collector's
  // own beat can read the folder at any moment: a file it caught half written
  // would be skipped, and the session missing from that poll.
  const rewrite = async (status: string) => {
    const target = path.join(claudeHome, "sessions", file);
    await writeFile(`${target}.tmp`, entryFor(standIn, status));
    await rename(`${target}.tmp`, target);
  };
  const waits = async () => (await request(port, "/api/waits")).json<WaitsResponse>();
  return {
    socketPath,
    snapshot,
    session,
    answer,
    events,
    waits,
    rewrite,
    port,
    collector,
    notifier,
    reads: () => reads,
  };
}

/** The plugin's hook, run as Claude Code runs it, with the request on stdin. */
function hook(socketPath: string, toolName = "Bash", toolInput: unknown = { command: COMMAND }) {
  return runPermissionHook(socketPath, { sessionId: ids.busy, toolName, toolInput });
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

test("with a socket that could not be opened there is nothing to answer, and a POST that passes the checks gets 405", async () => {
  // A folder Agent Lookout did not make, that other users can open.
  const shared = path.join(await tempDir(), "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  const warned: string[] = [];
  const server = await serve(
    { AGENT_LOOKOUT_ANSWER_SOCKET: path.join(shared, "answer.sock") },
    { warn: (line) => warned.push(line) },
  );
  expect(warned).toEqual([expect.stringContaining("Other users can open")]);
  expect((await server.snapshot()).answering).toMatchObject({ state: "unavailable" });
  const response = await server.answer("0".repeat(32), "allow");
  expect(response.status).toBe(405);
  expect(response.headers.allow).toBe("GET");
});

const MINUTE = 60_000;

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

const REMIND_AFTER_A_MINUTE: TimeRules = {
  ...DEFAULT_TIME_RULES,
  longWait: { on: true, minutes: 1 },
};

describe("the time rules, for a wait answered from the page", () => {
  /** A settings file of the test's own, holding these rules. */
  async function settingsWith(rules: TimeRules): Promise<string> {
    const file = path.join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ timeRules: rules }));
    return file;
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
    // A poll already under way read the folder before the rewrite, and
    // pollOnce hands that poll back, so wait for one that read it after.
    await vi.waitFor(
      async () => {
        await server.collector.poller.pollOnce();
        expect((await server.session())?.status).toBe("working");
      },
      { timeout: 5_000, interval: 50 },
    );
  }

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

describe("a wait whose request was answered is over at once, on every channel", () => {
  const ALLOW_TESTS: RuleWords = { decision: "allow", tool: "Bash", command: "npm test:*" };

  /**
   * The collector over the one session, with every channel on and set to go
   * at once: its own notifications, email to a mail server of the test's own,
   * posts to a webhook of its own and pushes to an ntfy server and a Pushover
   * API of its own, all on 127.0.0.1, and the long wait
   * reminder after a minute. Its settings file holds these permission rules.
   * Its clock is the test's own, it polls only when asked, and it checks the
   * requests it holds only as one arrives or when the test runs `beat`.
   */
  async function everyChannel(status: string, rules: RuleWords[] = []) {
    const time = clock();
    const mail = await startSmtpServer();
    const webhook = await startWebhookServer();
    const ntfy = await startWebhookServer();
    const pushover = await startWebhookServer();
    const settingsFile = path.join(await tempDir(), "settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        timeRules: REMIND_AFTER_A_MINUTE,
        permissionRules: rules.map((rule, index) => ({ id: `rule${index}`, ...rule })),
      }),
    );
    let beat = () => {};
    const server = await serve(
      {
        AGENT_LOOKOUT_NOTIFICATIONS: "on",
        AGENT_LOOKOUT_SETTINGS_FILE: settingsFile,
        AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
        AGENT_LOOKOUT_SMTP_URL: mail.url(),
        AGENT_LOOKOUT_EMAIL_AFTER: "0",
        AGENT_LOOKOUT_WEBHOOK_URL: webhook.url(),
        AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
        AGENT_LOOKOUT_NTFY_URL: ntfy.url("/agent-lookout-topic"),
        AGENT_LOOKOUT_NTFY_AFTER: "0",
        AGENT_LOOKOUT_PUSHOVER_TOKEN: "atest0000000000000000000000000",
        AGENT_LOOKOUT_PUSHOVER_USER: "utest0000000000000000000000000",
        AGENT_LOOKOUT_PUSHOVER_AFTER: "0",
      },
      {
        status,
        now: time.now,
        intervalMs: 60 * MINUTE,
        beat: (run) => {
          beat = run;
        },
        createEmailSender: (settings) => createSmtpSender(settings, { timeoutMs: 2_000 }),
        createWebhookSender: (settings) =>
          createHttpSender(settings, { version: "9.9.9-test", timeoutMs: 2_000 }),
        createNtfySender: (settings) =>
          createNtfySender(settings, { version: "9.9.9-test", timeoutMs: 2_000 }),
        createPushoverSender: (settings) =>
          createPushoverSender(settings, {
            version: "9.9.9-test",
            timeoutMs: 2_000,
            endpoint: new URL(pushover.url("/1/messages.json")),
          }),
      },
    );
    const { collector } = server;
    /** Polls until a poll begun after this call is done, and what it sent has gone. */
    const pollAgain = async () => {
      // A poll under way may have read the folder before now, and pollOnce
      // hands that one back, so a second is asked for once it is done.
      await collector.poller.pollOnce();
      await collector.poller.pollOnce();
      await collector.email?.settled();
      await collector.webhook?.settled();
      await collector.ntfy?.settled();
      await collector.pushover?.settled();
    };
    return {
      ...server,
      time,
      pollAgain,
      beat: () => beat(),
      /** Claude Code rewrites its file once it has the answer, and a poll reads it. */
      async movesOn() {
        await server.rewrite("busy");
        await vi.waitFor(
          async () => {
            await pollAgain();
            expect((await server.session())?.status).toBe("working");
          },
          { timeout: 5_000, interval: 50 },
        );
      },
      /** Moves the clock on until the session's wait has lasted `ms`. */
      async waitedFor(ms: number) {
        const since = (await server.session())?.statusSince ?? null;
        expect(since).not.toBeNull();
        const ahead = (since as number) + ms - time.now();
        expect(ahead).toBeGreaterThan(0);
        time.forward(ahead);
      },
      subjects: () =>
        mail.received.map((email) => decodedHeader(headerValues(email.data, "Subject")[0] ?? "")),
      posts: () => webhook.received.map((post) => JSON.parse(post.body) as WebhookPost),
      /** The titles of the pushes to ntfy, then to Pushover. */
      pushes: () =>
        [ntfy, pushover].map((server) =>
          server.received.map((push) => (JSON.parse(push.body) as { title: string }).title),
        ),
    };
  }

  type EveryChannel = Awaited<ReturnType<typeof everyChannel>>;

  /** That nothing told of a wait anywhere, and nothing counted one, while the answer is in the log. */
  async function toldOfNowhere(server: EveryChannel) {
    expect(server.notifier.shown).toEqual([]);
    expect(server.subjects()).toEqual([]);
    expect(server.posts()).toEqual([]);
    expect(server.pushes()).toEqual([[], []]);
    const events = await server.events();
    expect(events.filter((event) => event.kind === "answered")).toHaveLength(1);
    // No move into or out of needs-you: the session was working all along, as far as the log goes.
    expect(events.filter(isStatusEvent)).toEqual([]);
    const { today, sevenDays } = await server.waits();
    expect([today.waits, sevenDays.waits]).toEqual([0, 0]);
  }

  test("a prompt a rule answers at once is told of on no channel and counted as no wait, and the answer is in the Events log", async () => {
    const server = await everyChannel("busy", [ALLOW_TESTS]);
    // Claude Code asks: its file says it waits for permission, and it runs the hook.
    await server.rewrite("waiting");
    expect(await hook(server.socketPath, "Bash", { command: "npm test" })).toEqual({
      code: 0,
      stdout: `${ALLOW_OUTPUT}\n`,
    });

    // Until Claude Code rewrites its file, a poll still reads the session as waiting.
    await server.pollAgain();
    expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
    // Past the hand-over to a page, and still well inside the time an answer stands for.
    server.time.forward(4_000);
    await server.pollAgain();
    expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
    await server.movesOn();
    server.time.forward(10 * MINUTE);
    await server.pollAgain();

    await toldOfNowhere(server);
    expect((await server.events()).find((event) => event.kind === "answered")).toMatchObject({
      decision: "allow",
      by: "agent-lookout",
      rule: { tool: "Bash", command: "npm test:*" },
    });
  });

  test("a prompt a poll reads as waiting in the moment before a rule answers it is told of on no channel either", async () => {
    const server = await everyChannel("busy", [ALLOW_TESTS]);
    // The hook runs a moment before Claude Code's file says the session waits.
    const asked = hook(server.socketPath, "Bash", { command: "npm test" });
    await vi.waitFor(() => expect(server.reads()).toBeGreaterThan(0), { timeout: 5_000 });
    await server.rewrite("waiting");
    await server.pollAgain();
    // Read as waiting, with the rule still to answer at the next check.
    expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
    server.beat();
    expect(await asked).toEqual({ code: 0, stdout: `${ALLOW_OUTPUT}\n` });

    await server.pollAgain();
    server.time.forward(4_000);
    await server.pollAgain();
    expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
    await server.movesOn();
    await toldOfNowhere(server);
  });

  test.each(["allow", "deny"] as const)(
    "a prompt answered with %s is reminded of on no channel, though the reminder falls due before Claude Code says it moved on",
    async (decision) => {
      // Waiting already as Agent Lookout starts, so its reminder is due once it has waited a minute.
      const server = await everyChannel("waiting");
      const asked = hook(server.socketPath);
      await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
        timeout: 5_000,
      });
      const requestId = (await server.session())?.ask?.requestId ?? "";
      // Pressed two seconds before the wait has lasted the reminder's minute.
      await server.waitedFor(MINUTE - 2_000);
      await server.pollAgain();
      expect((await server.answer(requestId, decision)).status).toBe(200);
      expect((await asked).code).toBe(0);

      // Claude Code has not rewritten its file yet, and the reminder's minute is up.
      server.time.forward(4_000);
      await server.pollAgain();
      expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
      await server.movesOn();
      server.time.forward(10 * MINUTE);
      await server.pollAgain();

      expect(server.notifier.shown).toEqual([]);
      expect(server.subjects()).toEqual([]);
      expect(server.posts()).toEqual([]);
      expect(server.pushes()).toEqual([[], []]);
    },
  );

  test.each(["allow", "deny"] as const)(
    "the page's read straight after a press of %s finds the wait over, though Claude Code's file still says it waits",
    async (decision) => {
      const server = await everyChannel("waiting");
      const asked = hook(server.socketPath);
      await vi.waitFor(async () => expect((await server.session())?.ask).toBeDefined(), {
        timeout: 5_000,
      });
      const before = await server.session();
      expect(before?.status).toBe("needs-you");
      expect(before?.answered).toBeUndefined();

      expect((await server.answer(before?.ask?.requestId ?? "", decision)).status).toBe(200);
      // The test asks for no poll: the answer's reply waited for one.
      expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
      expect((await asked).code).toBe(0);
    },
  );

  test("a session that still reads as in the wait it was answered in, ten seconds on, needs you again, and is told of then", async () => {
    const server = await everyChannel("busy", [ALLOW_TESTS]);
    await server.rewrite("waiting");
    expect(await hook(server.socketPath, "Bash", { command: "npm test" })).toEqual({
      code: 0,
      stdout: `${ALLOW_OUTPUT}\n`,
    });
    await server.pollAgain();
    expect(await server.session()).toMatchObject({ status: "needs-you", answered: true });
    expect(server.notifier.shown).toEqual([]);

    // The answer was not for what the session shows now, or never reached it.
    server.time.forward(ANSWER_HOLDS_MS);
    await server.pollAgain();
    const session = await server.session();
    expect(session?.status).toBe("needs-you");
    expect(session?.answered).toBeUndefined();
    expect(server.notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission" },
    ]);
    expect(server.subjects()).toEqual(["checkout-flow is waiting for permission"]);
    expect(server.posts().map((post) => post.event)).toEqual(["needs-you"]);
    expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
    expect((await server.events()).some((event) => event.to === "needs-you")).toBe(true);
    expect((await server.waits()).today.waits).toBe(1);
  });

  test("a prompt nobody answers is still told of on every channel, counted as a wait, and reminded of", async () => {
    const server = await everyChannel("busy", [ALLOW_TESTS]);
    await server.rewrite("waiting");
    // No rule matches, so the request waits for the person.
    hook(server.socketPath, "Bash", { command: "npm run build" });
    await vi.waitFor(
      async () => {
        await server.pollAgain();
        expect((await server.session())?.ask).toBeDefined();
      },
      { timeout: 5_000, interval: 50 },
    );
    const session = await server.session();
    expect(session?.status).toBe("needs-you");
    expect(session?.answered).toBeUndefined();
    expect(server.notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission" },
    ]);
    expect(server.subjects()).toEqual(["checkout-flow is waiting for permission"]);
    expect(server.posts().map((post) => [post.event, "reminder" in post])).toEqual([
      ["needs-you", false],
    ]);
    const events = await server.events();
    expect(events.some((event) => event.to === "needs-you")).toBe(true);
    expect((await server.waits()).today.waits).toBe(1);

    server.time.forward(2 * MINUTE);
    await server.pollAgain();
    expect(server.notifier.shown[1]).toEqual({
      title: "checkout-flow",
      body: "Has waited 2 minutes for permission",
    });
    expect(server.subjects()[1]).toBe("checkout-flow has waited 2 minutes for permission");
    expect(server.posts()[1]).toMatchObject({ event: "needs-you", reminder: true });
    expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
  });
});
