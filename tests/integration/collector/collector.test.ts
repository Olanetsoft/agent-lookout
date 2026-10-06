import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { createCollector } from "@collector/collector";
import { createSmtpSender } from "@collector/email/smtpSender";
import { HANDOVER_GRACE_MS } from "@collector/notifications/heldWait";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import type { WebhookPost } from "@collector/webhook/webhookMessage";
import { createHttpSender } from "@collector/webhook/webhookSender";
import {
  NOTIFICATIONS_HEADER,
  SENDS_PER_HOUR,
  type EmailStatusResponse,
  type WebhookStatusResponse,
} from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { readSnapshot } from "@dashboard/lib/api/readApi";
import { quietFor, quietPhrase } from "@dashboard/lib/sessions/quiet";
import {
  fixtureSessions,
  messageLine,
  metaLine,
  MINUTE,
  NOW,
  rollout,
  rolloutPath,
  turnLine,
} from "@tests/fixtures/codex";
import { makeSession } from "@tests/fixtures/session";
import { listen, request } from "@tests/support/node/http";
import {
  headerValues,
  startSmtpServer,
  textOf,
  type SmtpBehaviour,
} from "@tests/support/channels/smtp";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import {
  CODEX_FIXTURE_HOME,
  makeClaudeHome,
  makeCodexHome,
  tempDir,
} from "@tests/support/node/tempFiles";
import { startWebhookServer } from "@tests/support/channels/webhook";

/**
 * A collector built the way every host builds it, with its default adapters,
 * and settings that name nothing on this machine: an empty Claude Code folder,
 * which on its own keeps the claude command from being run, a Codex folder of
 * the test's choosing, a folder of status files that is not there unless the
 * test says otherwise, and tmux turned off. Served over real HTTP on a free
 * loopback port.
 */
async function serve(settings: Record<string, string>) {
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      ...settings,
    },
    now: () => NOW,
  });
  const port = await listen(createServer(collector.handler));
  await collector.poller.pollOnce();
  return (await request(port, "/api/sessions")).json<SessionsSnapshot>();
}

describe("createCollector", () => {
  test("watches Claude Code and Codex, and lists Codex sessions beside Claude Code's", async () => {
    const snapshot = await serve({ AGENT_LOOKOUT_CODEX_HOME: CODEX_FIXTURE_HOME });

    expect(snapshot.sources.map((source) => [source.id, source.label, source.state])).toEqual([
      ["claude-code", "Claude Code", "ok"],
      ["codex", "Codex", "ok"],
      ["status-files", "Status files", "not-set-up"],
    ]);
    // The folder is written from ~ when the repository sits in the home folder.
    expect(snapshot.sources[1]?.detail).toMatch(
      /^Sessions are read from the files Codex saves in \S+\/fixtures\/codex-home\/sessions\. /,
    );
    expect(snapshot.sources[1]?.detail).toContain(NEEDS_YOU_NOTE);
    expect(
      snapshot.sessions
        .map((session) => [session.id, session.source, session.name, session.status])
        .sort(),
    ).toEqual(
      fixtureSessions.map((session) => [session.id, "codex", session.name, session.status]).sort(),
    );
    expect(snapshot.sessions.some((session) => session.status === "needs-you")).toBe(false);
  });

  test("with no Codex there, Codex is not found and Claude Code is read as before", async () => {
    const missing = path.join(await tempDir(), "no-codex-here");
    const snapshot = await serve({ CODEX_HOME: missing });

    expect(snapshot.sources).toMatchObject([
      { id: "claude-code", state: "ok" },
      {
        id: "codex",
        label: "Codex",
        state: "unavailable",
        detail: `Codex was not found: CODEX_HOME is set to ${missing}, and there is no folder there. Agent Lookout looks again every minute.`,
      },
      { id: "status-files", state: "not-set-up" },
    ]);
    expect(snapshot.sources[1]).not.toHaveProperty("advice");
    expect(snapshot.sessions).toEqual([]);
  });

  test("lists a session from a status file beside the others, with its own agent's name", async () => {
    const folder = path.join(await tempDir(), "sessions");
    await mkdir(folder);
    await writeFile(
      path.join(folder, "night-shift.json"),
      JSON.stringify({
        agent: "Night Shift",
        name: "billing-webhooks",
        cwd: "/Users/example/code/billing-webhooks",
        status: "waiting",
        reason: "question",
      }),
    );
    const snapshot = await serve({
      AGENT_LOOKOUT_CODEX_HOME: CODEX_FIXTURE_HOME,
      AGENT_LOOKOUT_STATUS_DIR: folder,
    });

    expect(snapshot.sources[2]).toMatchObject({
      id: "status-files",
      label: "Status files",
      state: "ok",
      watching: [
        { label: "Folder", value: folder },
        { label: "Read", value: "every 2 seconds" },
        { label: "Files read", value: "1" },
        { label: "Files skipped", value: "0" },
      ],
    });
    // It needs the person, so it is listed first, ahead of every Codex session.
    expect(snapshot.sessions[0]).toMatchObject({
      id: "status-files:night-shift.json",
      source: "status-files",
      agent: "Night Shift",
      name: "billing-webhooks",
      project: "billing-webhooks",
      status: "needs-you",
      waitingReason: "question",
      links: {},
    });
    expect(snapshot.sessions[0]).not.toHaveProperty("jump");
    expect(snapshot.sessions.filter((session) => session.source === "codex")).toHaveLength(
      fixtureSessions.length,
    );
  });

  test("a session whose folder is in a git repository has its branch, whatever its source", async () => {
    const code = await tempDir();
    const folder = path.join(code, "sessions");
    await mkdir(folder);
    await mkdir(path.join(code, "storefront", ".git", "worktrees", "checkout-flow"), {
      recursive: true,
    });
    await writeFile(path.join(code, "storefront", ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      path.join(code, "storefront", ".git", "worktrees", "checkout-flow", "HEAD"),
      "ref: refs/heads/checkout-flow\n",
    );
    // What git writes in a worktree's git folder to name the repository's own.
    await writeFile(
      path.join(code, "storefront", ".git", "worktrees", "checkout-flow", "commondir"),
      "../..\n",
    );
    await mkdir(path.join(code, "storefront-checkout"));
    await writeFile(
      path.join(code, "storefront-checkout", ".git"),
      "gitdir: ../storefront/.git/worktrees/checkout-flow\n",
    );
    await mkdir(path.join(code, "mobile-app"));
    const session = (name: string, cwd: string) =>
      writeFile(
        path.join(folder, `${name}.json`),
        JSON.stringify({
          agent: "Night Shift",
          name,
          cwd: path.join(code, cwd),
          status: "working",
        }),
      );
    await session("billing-webhooks", "storefront");
    await session("checkout-flow", "storefront-checkout");
    await session("mobile-onboarding", "mobile-app");

    const snapshot = await serve({
      AGENT_LOOKOUT_CODEX_HOME: CODEX_FIXTURE_HOME,
      AGENT_LOOKOUT_STATUS_DIR: folder,
    });

    const git = (name: string) => snapshot.sessions.find((found) => found.name === name)?.git;
    expect(git("billing-webhooks")?.branch).toBe("main");
    expect(git("checkout-flow")?.branch).toBe("checkout-flow");
    // The worktree is in the repository it was made from, which the API names without its path.
    expect(git("checkout-flow")?.repository?.name).toBe("storefront");
    expect(git("checkout-flow")?.repository).toEqual(git("billing-webhooks")?.repository);
    expect(git("checkout-flow")?.repository?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(
      snapshot.sessions.find((found) => found.name === "mobile-onboarding"),
    ).not.toHaveProperty("git");
    // The Codex sessions' folders are in no repository on this machine.
    expect(snapshot.sessions.filter((found) => found.git !== undefined)).toHaveLength(2);
  });

  test("a session in a folder of status files made after it started is logged as appearing", async () => {
    const folder = path.join(await tempDir(), "sessions");
    const clock = { now: Date.now() };
    const collector = createCollector({
      version: "9.9.9-test",
      env: {
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
        AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
        AGENT_LOOKOUT_STATUS_DIR: folder,
        AGENT_LOOKOUT_TMUX: "off",
      },
      notifier: fakeSystemNotifier(),
      now: () => clock.now,
    });
    const port = await listen(createServer(collector.handler));
    await collector.poller.pollOnce();

    await mkdir(folder);
    await writeFile(path.join(folder, "my-agent.json"), '{"agent":"my-agent","status":"working"}');
    clock.now += 2_000;
    await collector.poller.pollOnce();

    const { events } = (await request(port, "/api/events?since=0")).json<{
      events: { sessionId: string; sessionName: string; kind: string }[];
    }>();
    expect(events.map((event) => [event.sessionId, event.sessionName, event.kind])).toEqual([
      ["status-files:my-agent.json", "my-agent", "appeared"],
    ]);
  });

  test("a working Codex session and a working status file whose files stop changing are said to be quiet, for as long as they stay so", async () => {
    const start = Date.now();
    const clock = { now: start };
    const thread = "00000000-0000-4000-8000-0000000000e1";
    // Codex names its day folder and the file by the local time the session began.
    const began = new Date(start - 30 * MINUTE);
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = `${began.getFullYear()}-${pad(began.getMonth() + 1)}-${pad(began.getDate())}`;
    const created = `${day}T${pad(began.getHours())}-${pad(began.getMinutes())}-${pad(began.getSeconds())}`;
    const codexHome = await makeCodexHome({
      [`thread-writer-locks/${thread}.lock`]: "",
    });
    const rolloutFile = rolloutPath(codexHome, created, thread);
    await mkdir(path.dirname(rolloutFile), { recursive: true });
    await writeFile(
      rolloutFile,
      rollout(
        metaLine(start - 30 * MINUTE, { id: thread, cwd: "/Users/example/code/billing-webhooks" }),
        turnLine(start - 20 * MINUTE, "task_started"),
      ),
    );
    const statusDir = path.join(await tempDir(), "sessions");
    await mkdir(statusDir);
    const statusFile = path.join(statusDir, "night-shift.json");
    const said = JSON.stringify({
      agent: "Night Shift",
      name: "search-indexing",
      status: "working",
    });
    await writeFile(statusFile, said);
    // Neither file has been written for six minutes. A whole second, which the
    // file system keeps exactly: a time given in seconds can come back a
    // millisecond short.
    const sixMinutesAgo = new Date(Math.floor((start - 6 * MINUTE) / 1000) * 1000);
    await utimes(rolloutFile, sixMinutesAgo, sixMinutesAgo);
    await utimes(statusFile, sixMinutesAgo, sixMinutesAgo);

    const collector = createCollector({
      version: "9.9.9-test",
      env: {
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
        AGENT_LOOKOUT_CODEX_HOME: codexHome,
        AGENT_LOOKOUT_STATUS_DIR: statusDir,
        AGENT_LOOKOUT_TMUX: "off",
      },
      notifier: fakeSystemNotifier(),
      now: () => clock.now,
    });
    const port = await listen(createServer(collector.handler));
    /**
     * Polls, and reads the answer as the page does: each session's status, its
     * last write and what its row says of it, or null when it says nothing.
     */
    const rows = async () => {
      await collector.poller.pollOnce();
      const snapshot = readSnapshot((await request(port, "/api/sessions")).json());
      return Object.fromEntries(
        (snapshot?.sessions ?? []).map((session) => {
          const quietMs = quietFor(session, clock.now);
          return [
            session.name,
            {
              status: session.status,
              lastWriteAt: session.lastWriteAt,
              says: quietMs === null ? null : quietPhrase(quietMs),
            },
          ];
        }),
      );
    };

    expect(await rows()).toEqual({
      "billing-webhooks": {
        status: "working",
        lastWriteAt: sixMinutesAgo.getTime(),
        says: "quiet for 6m",
      },
      "search-indexing": {
        status: "working",
        lastWriteAt: sixMinutesAgo.getTime(),
        says: "quiet for 6m",
      },
    });

    // Two minutes on, with nothing written, it has grown, and both are still working.
    clock.now += 2 * MINUTE;
    const later = await rows();
    expect(later["billing-webhooks"]).toMatchObject({ status: "working", says: "quiet for 8m" });
    expect(later["search-indexing"]).toMatchObject({ status: "working", says: "quiet for 8m" });

    // Codex writes a line, and the agent rewrites its status file with the same words.
    await appendFile(rolloutFile, `${messageLine(clock.now)}\n`);
    await writeFile(statusFile, said);
    const written = await rows();
    for (const name of ["billing-webhooks", "search-indexing"]) {
      expect(written[name]?.status, name).toBe("working");
      expect(written[name]?.lastWriteAt, name).toBeGreaterThan(sixMinutesAgo.getTime());
      expect(written[name]?.says, name).toBeNull();
    }
  });
});

const T0 = 1_700_000_000_000;

/** The sessions a stand-in for Claude Code reports, which a test changes between polls. */
function standInSource(initial: Session[] = []) {
  const state = { sessions: initial, now: T0 };
  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => ({
      health: { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: state.now },
      sessions: state.sessions,
    }),
  };
  return { state, adapter };
}

/**
 * A collector over that source, served over real HTTP, with a notifier that
 * writes down what it is asked to show and shows nothing. The environment is
 * the test's own, so a setting in the shell that runs the tests changes nothing.
 */
async function watch(source = standInSource(), env: Record<string, string> = {}) {
  const { state, adapter } = source;
  const notifier = fakeSystemNotifier();
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [adapter],
    env,
    notifier,
    now: () => state.now,
  });
  const port = await listen(createServer(collector.handler));

  return {
    notifier,
    source,
    /** Moves the clock, replaces the sessions and polls once. */
    async poll(atOffsetMs: number, sessions: Session[]) {
      state.now = T0 + atOffsetMs;
      state.sessions = sessions;
      await collector.poller.pollOnce();
    },
    /** A dashboard page's request, with what it says of its notifications. */
    async page(atOffsetMs: number, said: string, target = "/api/sessions") {
      state.now = T0 + atOffsetMs;
      const response = await request(port, target, { headers: { [NOTIFICATIONS_HEADER]: said } });
      expect(response.status).toBe(200);
      return response;
    },
  };
}

const id = "claude-code:00000000-0000-4000-8000-000000000001";
const working = (name: string) => makeSession({ id, name, status: "working" });
const waiting = (name: string) =>
  makeSession({ id, name, status: "needs-you", waitingReason: "permission" });

describe("the collector's own notifications", () => {
  test("with no page and nothing in the environment, a wait that begins shows nothing", async () => {
    const server = await watch();
    await server.poll(0, [working("checkout-flow")]);
    await server.poll(2_000, [waiting("checkout-flow")]);
    await server.poll(4_000, [waiting("checkout-flow")]);
    await server.poll(60_000, [waiting("checkout-flow")]);

    expect(server.notifier.shown).toEqual([]);
  });

  test("with AGENT_LOOKOUT_NOTIFICATIONS=on and no page, a wait that begins is shown at once, and once", async () => {
    const server = await watch(standInSource(), { AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    await server.poll(0, [working("api-rate-limits")]);
    expect(server.notifier.shown).toEqual([]);

    await server.poll(2_000, [waiting("api-rate-limits")]);
    expect(server.notifier.shown).toEqual([
      { title: "api-rate-limits", body: "Waiting for permission" },
    ]);

    await server.poll(4_000, [waiting("api-rate-limits")]);
    await server.poll(6_000, [waiting("api-rate-limits")]);
    expect(server.notifier.shown).toHaveLength(1);
  });

  test("a page that says on and stays open shows the wait itself, so the collector shows nothing", async () => {
    const server = await watch();
    await server.poll(0, [working("billing-webhooks")]);
    await server.page(1_000, "on");

    await server.poll(2_000, [waiting("billing-webhooks")]);
    // The page's next turn: the answer holds the wait, and the page shows it.
    const answer = await server.page(3_000, "on");
    expect(answer.json<SessionsSnapshot>().sessions[0]?.status).toBe("needs-you");
    await server.poll(4_000, [waiting("billing-webhooks")]);
    await server.page(5_000, "on");
    await server.poll(6_000, [waiting("billing-webhooks")]);
    await server.poll(60_000, [waiting("billing-webhooks")]);

    expect(server.notifier.shown).toEqual([]);
  });

  test("a page that said on and was closed leaves the collector to show the next wait", async () => {
    const server = await watch();
    await server.poll(0, [working("search-indexing")]);
    // Any request says it, not only the one for the sessions.
    await server.page(1_000, "on", "/api/health");

    await server.poll(60_000, [working("search-indexing")]);
    await server.poll(62_000, [waiting("search-indexing")]);

    expect(server.notifier.shown).toEqual([
      { title: "search-indexing", body: "Waiting for permission" },
    ]);
  });

  test("a page that is open but never fetches the sessions is waited for, for the grace period and no longer", async () => {
    const server = await watch();
    await server.poll(0, [working("docs-site")]);
    await server.page(1_900, "on", "/api/events");

    await server.poll(2_000, [waiting("docs-site")]);
    await server.page(3_900, "on", "/api/events");
    await server.poll(4_000, [waiting("docs-site")]);
    expect(server.notifier.shown).toEqual([]);

    await server.page(5_900, "on", "/api/history");
    await server.poll(6_000, [waiting("docs-site")]);
    expect(6_000 - 2_000).toBeGreaterThanOrEqual(HANDOVER_GRACE_MS);
    expect(server.notifier.shown).toEqual([{ title: "docs-site", body: "Waiting for permission" }]);
  });

  test("a page that says off turns the collector's notifications off, even with the environment on", async () => {
    const server = await watch(standInSource(), { AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    await server.poll(0, [working("mobile-onboarding")]);
    await server.page(1_000, "off");

    await server.poll(60_000, [waiting("mobile-onboarding")]);
    await server.poll(70_000, [waiting("mobile-onboarding")]);
    expect(server.notifier.shown).toEqual([]);

    // Turned on again in Settings: the next wait that begins is shown.
    await server.page(80_000, "on");
    await server.poll(90_000, [working("mobile-onboarding")]);
    await server.poll(92_000, [waiting("mobile-onboarding")]);
    expect(server.notifier.shown).toHaveLength(1);
  });

  test("a wait that ends inside the grace period is never shown", async () => {
    const server = await watch();
    await server.poll(0, [working("infra-terraform")]);
    await server.page(1_900, "on", "/api/events");

    await server.poll(2_000, [waiting("infra-terraform")]);
    await server.page(3_900, "on", "/api/events");
    await server.poll(4_000, [working("infra-terraform")]);
    await server.poll(6_000, [working("infra-terraform")]);
    await server.poll(60_000, [working("infra-terraform")]);

    expect(server.notifier.shown).toEqual([]);
  });

  test("a collector that is started again announces nothing that was already waiting, and has to be told again that they are on", async () => {
    const source = standInSource();
    const first = await watch(source);
    await first.poll(0, [working("email-templates")]);
    await first.page(1_000, "on");
    await first.poll(60_000, [waiting("email-templates")]);
    expect(first.notifier.shown).toHaveLength(1);

    // Stopped and started: a new collector over the same sessions, one still waiting.
    const second = await watch(source);
    await second.poll(70_000, [waiting("email-templates")]);
    await second.poll(72_000, [waiting("email-templates")]);
    // Answered, and waiting again. Nothing has told this collector they are on.
    await second.poll(74_000, [working("email-templates")]);
    await second.poll(76_000, [waiting("email-templates")]);
    expect(second.notifier.shown).toEqual([]);

    // A page says so, and the wait after that is shown.
    await second.page(80_000, "on", "/api/health");
    await second.poll(90_000, [working("email-templates")]);
    await second.poll(92_000, [waiting("email-templates")]);
    expect(second.notifier.shown).toEqual([
      { title: "email-templates", body: "Waiting for permission" },
    ]);
    expect(first.notifier.shown).toHaveLength(1);
  });

  test("with the environment on, a collector that is started again still announces nothing that was already waiting", async () => {
    const source = standInSource([waiting("checkout-flow")]);
    const server = await watch(source, { AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    await server.poll(0, [waiting("checkout-flow")]);
    await server.poll(2_000, [waiting("checkout-flow")]);
    expect(server.notifier.shown).toEqual([]);

    await server.poll(4_000, [working("checkout-flow")]);
    await server.poll(6_000, [waiting("checkout-flow")]);
    expect(server.notifier.shown).toHaveLength(1);
  });

  test("a page that names the events in the header has the collector show those, and only those, once it has gone", async () => {
    const server = await watch();
    const other = "claude-code:00000000-0000-4000-8000-000000000002";
    const failing = (status: "working" | "failed") =>
      makeSession({ id: other, name: "infra-terraform", status });
    await server.poll(0, [working("billing-webhooks"), failing("working")]);
    await server.page(1_000, "on; events=finished,failed", "/api/health");

    await server.poll(60_000, [
      makeSession({ id, name: "billing-webhooks", status: "finished" }),
      failing("failed"),
    ]);
    expect(server.notifier.shown).toEqual([
      { title: "billing-webhooks", body: "Finished" },
      { title: "infra-terraform", body: "Failed" },
    ]);

    // Ended was not chosen, and nor was a wait.
    await server.poll(62_000, [waiting("billing-webhooks")]);
    await server.poll(64_000, []);
    expect(server.notifier.shown).toHaveLength(2);
  });

  test("an open page that names an event shows it itself, so the collector shows nothing", async () => {
    const server = await watch();
    await server.poll(0, [working("search-indexing")]);
    await server.page(1_000, "on; events=needs-you,ended");

    await server.poll(2_000, []);
    await server.page(3_000, "on; events=needs-you,ended");
    await server.poll(4_000, []);
    await server.poll(60_000, []);

    expect(server.notifier.shown).toEqual([]);
  });

  test("a header that cannot be read changes nothing", async () => {
    const server = await watch();
    await server.poll(0, [working("docs-site")]);
    await server.page(1_000, "on; events=sometimes", "/api/health");

    await server.poll(60_000, [makeSession({ id, name: "docs-site", status: "finished" })]);
    expect(server.notifier.shown).toEqual([]);
  });
});

describe("email notifications", () => {
  const CREDENTIALS = { user: "name@example.test", pass: "app-password:/#?@%" };

  /**
   * A collector over a stand-in source, served over real HTTP, with the email
   * settings in `env`. A sender it makes waits at most 300 milliseconds for a
   * mail server, and every line it would print is written down.
   */
  async function mailing(env: Record<string, string>, source = standInSource()) {
    const { state, adapter } = source;
    const warnings: string[] = [];
    let sendersMade = 0;
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [adapter],
      env,
      notifier: fakeSystemNotifier(),
      now: () => state.now,
      warn: (line) => warnings.push(line),
      createEmailSender: (settings) => {
        sendersMade += 1;
        return createSmtpSender(settings, { timeoutMs: 300 });
      },
    });
    const port = await listen(createServer(collector.handler));

    return {
      collector,
      warnings,
      sendersMade: () => sendersMade,
      /** Moves the clock, replaces the sessions and polls once. */
      async poll(atOffsetMs: number, sessions: Session[]) {
        state.now = T0 + atOffsetMs;
        state.sessions = sessions;
        await collector.poller.pollOnce();
      },
      /** Waits until every email handed over so far has been tried. */
      settled: () => collector.email?.settled() ?? Promise.resolve(),
      async status() {
        const response = await request(port, "/api/email");
        expect(response.status).toBe(200);
        return response.json<EmailStatusResponse>();
      },
    };
  }

  const mailId = (n: number) =>
    `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const busy = (n: number, name: string) =>
    makeSession({ id: mailId(n), name, project: name, status: "working", statusSince: null });
  /** Waiting for permission since `atOffsetMs`, as the registry says. */
  const asking = (n: number, name: string, atOffsetMs: number) =>
    makeSession({
      id: mailId(n),
      name,
      project: name,
      surface: "vscode",
      cwd: `/Users/example/code/${name}`,
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      statusSince: T0 + atOffsetMs,
    });

  test("with nothing set, no email is sent, nothing that could send one is made, and no connection is opened", async () => {
    const server = await mailing({ AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    // Every connection this process opens, to any address, while the polls run.
    const connects = vi.spyOn(Socket.prototype, "connect");
    try {
      await server.poll(0, [busy(1, "checkout-flow")]);
      await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
      await server.poll(HOUR_MS, [asking(1, "checkout-flow", 2_000)]);
      await server.settled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connects).not.toHaveBeenCalled();
    } finally {
      connects.mockRestore();
    }

    expect(server.collector.email).toBeNull();
    expect(server.sendersMade()).toBe(0);
    expect(server.warnings).toEqual([]);
    expect(await server.status()).toEqual({
      on: false,
      to: null,
      events: null,
      afterMs: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
  });

  test("a wait shorter than the delay sends nothing, and one that lasts it sends one short email to the address set", async () => {
    const mail = await startSmtpServer({ auth: CREDENTIALS });
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(CREDENTIALS),
      AGENT_LOOKOUT_EMAIL_AFTER: "60",
    });
    expect(await server.status()).toMatchObject({
      on: true,
      to: "n…@example.test",
      events: ["needs-you"],
      afterMs: 60_000,
    });

    await server.poll(0, [busy(1, "checkout-flow")]);
    await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(50_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(52_000, [busy(1, "checkout-flow")]);
    await server.settled();
    expect(mail.connections).toBe(0);

    await server.poll(70_000, [asking(1, "checkout-flow", 70_000)]);
    await server.poll(128_000, [asking(1, "checkout-flow", 70_000)]);
    await server.settled();
    expect(mail.connections).toBe(0);

    await server.poll(130_000, [asking(1, "checkout-flow", 70_000)]);
    await server.settled();
    expect((await server.status()).last).toEqual({ at: T0 + 130_000, sent: true });
    await server.poll(132_000, [asking(1, "checkout-flow", 70_000)]);
    await server.poll(HOUR_MS, [asking(1, "checkout-flow", 70_000)]);
    await server.settled();

    expect(mail.received).toHaveLength(1);
    const [email] = mail.received;
    expect(email?.to).toEqual(["notify@example.test"]);
    expect(email?.auth).toEqual(CREDENTIALS);
    expect(headerValues(email?.data ?? "", "Subject")).toEqual([
      "checkout-flow is waiting for permission",
    ]);
    const text = textOf(email?.data ?? "");
    expect(text).toContain("checkout-flow is waiting for permission.\n");
    expect(text).toContain("It has waited 1 minute, since ");
    expect(text).toContain("Folder: checkout-flow\nApp: VS Code\nAgent: Claude Code\n");
    expect(text).not.toContain("/Users/example");
    expect(text).not.toContain("permission prompt");
  });

  test("with AGENT_LOOKOUT_EMAIL_EVENTS, a session that finishes is emailed on the poll that sees it, with its own subject", async () => {
    const mail = await startSmtpServer({ auth: CREDENTIALS });
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(CREDENTIALS),
      AGENT_LOOKOUT_EMAIL_EVENTS: "needs-you,finished,ended",
    });
    expect((await server.status()).events).toEqual(["needs-you", "finished", "ended"]);

    await server.poll(0, [busy(1, "billing-webhooks"), busy(2, "docs-site")]);
    await server.poll(2_000, [
      makeSession({
        id: mailId(1),
        name: "billing-webhooks",
        project: "billing-webhooks",
        status: "finished",
      }),
    ]);
    await server.settled();

    expect(mail.received.map((email) => headerValues(email.data, "Subject"))).toEqual([
      ["billing-webhooks finished"],
      ["docs-site ended"],
    ]);
    const text = textOf(mail.received[0]?.data ?? "");
    expect(text).toContain("billing-webhooks finished.\n");
    expect(text).toContain("Agent Lookout saw this at ");
    expect(text).toContain("Folder: billing-webhooks\n");
  });

  test("a list of events that cannot be read turns email off, and says so in one line", async () => {
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: "smtp://127.0.0.1:2525",
      AGENT_LOOKOUT_EMAIL_EVENTS: "finished,sometimes",
    });
    expect(server.collector.email).toBeNull();
    expect(server.sendersMade()).toBe(0);
    expect(server.warnings).toEqual([
      "Email notifications are off: AGENT_LOOKOUT_EMAIL_EVENTS must be one or more of needs-you, finished, failed, ended, separated by commas, such as needs-you,finished.",
    ]);
    expect((await server.status()).on).toBe(false);
  });

  test("a collector that is started again does not send again for a wait it finds open", async () => {
    const mail = await startSmtpServer();
    const env = {
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_AFTER: "0",
    };
    const source = standInSource();
    const first = await mailing(env, source);
    await first.poll(0, [busy(1, "api-rate-limits")]);
    await first.poll(2_000, [asking(1, "api-rate-limits", 2_000)]);
    await first.settled();
    expect(mail.received).toHaveLength(1);

    // Stopped and started, with the session still waiting.
    first.collector.stop();
    const second = await mailing(env, source);
    await second.poll(60_000, [asking(1, "api-rate-limits", 2_000)]);
    await second.poll(HOUR_MS, [asking(1, "api-rate-limits", 2_000)]);
    await second.settled();
    expect(mail.received).toHaveLength(1);

    // The next wait is new to it, and is emailed.
    await second.poll(HOUR_MS + 2_000, [busy(1, "api-rate-limits")]);
    await second.poll(HOUR_MS + 4_000, [asking(1, "api-rate-limits", HOUR_MS + 4_000)]);
    await second.settled();
    expect(mail.received).toHaveLength(2);
  });

  test(`no more than ${SENDS_PER_HOUR} go in an hour, and the status says when the next can`, async () => {
    const mail = await startSmtpServer();
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_AFTER: "0",
    });
    const sessions = (make: (n: number) => Session) =>
      Array.from({ length: SENDS_PER_HOUR + 3 }, (_, index) => make(index + 1));

    await server.poll(
      0,
      sessions((n) => busy(n, `docs-site-${n}`)),
    );
    await server.poll(
      2_000,
      sessions((n) => asking(n, `docs-site-${n}`, 2_000)),
    );
    await server.poll(
      60_000,
      sessions((n) => asking(n, `docs-site-${n}`, 2_000)),
    );
    await server.settled();

    expect(mail.received).toHaveLength(SENDS_PER_HOUR);
    expect((await server.status()).limitedUntil).toBe(T0 + 2_000 + HOUR_MS);
  });

  test.each<[SmtpBehaviour, string]>([
    ["refuse", "the mail server refused the connection"],
    ["silent", "the mail server did not answer in time"],
    ["trickle", "the mail server did not answer in time"],
  ])(
    "a mail server that does %s leaves the poll unharmed, and the status says what happened",
    async (behaviour, reason) => {
      const mail = await startSmtpServer({ behaviour });
      const server = await mailing({
        AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
        AGENT_LOOKOUT_SMTP_URL: mail.url(),
        AGENT_LOOKOUT_EMAIL_AFTER: "0",
      });
      await server.poll(0, [busy(1, "billing-webhooks")]);

      const started = Date.now();
      await server.poll(2_000, [asking(1, "billing-webhooks", 2_000)]);
      // The poll did not wait for the mail server.
      expect(Date.now() - started).toBeLessThan(250);
      expect(server.collector.poller.getSnapshot().sessions[0]?.status).toBe("needs-you");

      await server.settled();
      expect(mail.connections).toBe(1);
      expect((await server.status()).last).toEqual({ at: T0 + 2_000, sent: false, reason });

      // The polls go on, and that wait is not tried again.
      await server.poll(4_000, [asking(1, "billing-webhooks", 2_000)]);
      await server.poll(6_000, [busy(1, "billing-webhooks")]);
      await server.settled();
      expect(mail.connections).toBe(1);
      expect(server.collector.poller.getSnapshot().sessions[0]?.status).toBe("working");
    },
  );

  test("a setting that is wrong turns email off, with one line that names it and never the password", async () => {
    const mail = await startSmtpServer();
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: "https://name%40example.test:s3cret-app-password@smtp.example.test",
    });
    await server.poll(0, [busy(1, "email-templates")]);
    await server.poll(2_000, [asking(1, "email-templates", 2_000)]);
    await server.poll(HOUR_MS, [asking(1, "email-templates", 2_000)]);

    expect(server.warnings).toEqual([
      "Email notifications are off: AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://.",
    ]);
    const status = await server.status();
    expect(status).toMatchObject({
      on: false,
      problem: "AGENT_LOOKOUT_SMTP_URL must begin with smtps:// or smtp://.",
    });
    const said = `${server.warnings.join("\n")}${JSON.stringify(status)}`;
    for (const secret of ["s3cret", "name%40", "name@", "smtp.example.test"]) {
      expect(said).not.toContain(secret);
    }
    expect(server.sendersMade()).toBe(0);
    expect(mail.connections).toBe(0);
  });
});

describe("webhook notifications", () => {
  /**
   * A collector over a stand-in source, served over real HTTP, with the
   * webhook settings in `env`. A sender it makes waits at most 300
   * milliseconds for an answer, and every line it would print is written down.
   */
  async function posting(env: Record<string, string>, source = standInSource()) {
    const { state, adapter } = source;
    const warnings: string[] = [];
    let sendersMade = 0;
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [adapter],
      env,
      notifier: fakeSystemNotifier(),
      now: () => state.now,
      warn: (line) => warnings.push(line),
      createEmailSender: (settings) => createSmtpSender(settings, { timeoutMs: 300 }),
      createWebhookSender: (settings) => {
        sendersMade += 1;
        return createHttpSender(settings, { version: "9.9.9-test", timeoutMs: 300 });
      },
    });
    const port = await listen(createServer(collector.handler));

    return {
      collector,
      warnings,
      sendersMade: () => sendersMade,
      /** Moves the clock, replaces the sessions and polls once. */
      async poll(atOffsetMs: number, sessions: Session[]) {
        state.now = T0 + atOffsetMs;
        state.sessions = sessions;
        await collector.poller.pollOnce();
      },
      /** Waits until every post and email handed over so far has been tried. */
      async settled() {
        await collector.webhook?.settled();
        await collector.email?.settled();
      },
      async status() {
        const response = await request(port, "/api/webhook");
        expect(response.status).toBe(200);
        return response.json<WebhookStatusResponse>();
      },
    };
  }

  const hookId = (n: number) =>
    `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const busy = (n: number, name: string) =>
    makeSession({ id: hookId(n), name, project: name, status: "working", statusSince: null });
  /** Waiting for permission since `atOffsetMs`, as the registry says. */
  const asking = (n: number, name: string, atOffsetMs: number) =>
    makeSession({
      id: hookId(n),
      name,
      project: name,
      surface: "vscode",
      cwd: `/Users/example/code/${name}`,
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      statusSince: T0 + atOffsetMs,
    });
  const bodies = (hook: { received: { body: string }[] }) =>
    hook.received.map((post) => JSON.parse(post.body) as WebhookPost);

  test("with nothing set, nothing is posted, nothing that could post is made, and no connection is opened", async () => {
    const server = await posting({ AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    // Every connection this process opens, to any address, while the polls run.
    const connects = vi.spyOn(Socket.prototype, "connect");
    try {
      await server.poll(0, [busy(1, "checkout-flow")]);
      await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
      await server.poll(HOUR_MS, [asking(1, "checkout-flow", 2_000)]);
      await server.settled();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connects).not.toHaveBeenCalled();
    } finally {
      connects.mockRestore();
    }

    expect(server.collector.webhook).toBeNull();
    expect(server.sendersMade()).toBe(0);
    expect(server.warnings).toEqual([]);
    expect(await server.status()).toEqual({
      on: false,
      host: null,
      events: null,
      afterMs: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
  });

  test("a wait shorter than the delay posts nothing, and one that lasts it posts once, with the session's name, what happened and when", async () => {
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url("/services/T0000/B0000/s3cret-token"),
      AGENT_LOOKOUT_WEBHOOK_AFTER: "60",
    });
    expect(await server.status()).toEqual({
      on: true,
      host: "127.0.0.1",
      events: ["needs-you"],
      afterMs: 60_000,
      problem: null,
      last: null,
      limitedUntil: null,
    });

    await server.poll(0, [busy(1, "checkout-flow")]);
    await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(50_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(52_000, [busy(1, "checkout-flow")]);
    await server.settled();
    expect(hook.connections).toBe(0);

    await server.poll(70_000, [asking(1, "checkout-flow", 70_000)]);
    await server.poll(130_000, [asking(1, "checkout-flow", 70_000)]);
    await server.settled();
    await server.poll(132_000, [asking(1, "checkout-flow", 70_000)]);
    await server.poll(HOUR_MS, [asking(1, "checkout-flow", 70_000)]);
    await server.settled();

    expect(hook.received).toHaveLength(1);
    expect(hook.received[0]?.path).toBe("/services/T0000/B0000/s3cret-token");
    expect(hook.received[0]?.headers["content-type"]).toBe("application/json");
    expect(hook.received[0]?.headers["user-agent"]).toBe("Agent Lookout/9.9.9-test");
    expect(bodies(hook)).toEqual([
      {
        text: "checkout-flow is waiting for permission (1m 00s, checkout-flow, VS Code, Claude Code)",
        event: "needs-you",
        reason: "permission",
        session: {
          name: "checkout-flow",
          agent: "Claude Code",
          folder: "checkout-flow",
          app: "VS Code",
        },
        at: new Date(T0 + 70_000).toISOString(),
        waitedSeconds: 60,
      },
    ]);
    expect(hook.received[0]?.body).not.toContain("/Users/example");
    expect(hook.received[0]?.body).not.toContain("permission prompt");
    expect((await server.status()).last).toEqual({ at: T0 + 130_000, sent: true });
    // The page is told the host, and nothing of the path.
    expect(JSON.stringify(await server.status())).not.toContain("s3cret");
  });

  test("with AGENT_LOOKOUT_WEBHOOK_EVENTS, a session that finishes is posted on the poll that sees it", async () => {
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_EVENTS: "needs-you,finished",
    });
    await server.poll(0, [busy(1, "billing-webhooks")]);
    await server.poll(2_000, [
      makeSession({
        id: hookId(1),
        name: "billing-webhooks",
        project: "billing-webhooks",
        status: "finished",
      }),
    ]);
    await server.settled();

    expect(bodies(hook)).toEqual([
      {
        text: "billing-webhooks finished (billing-webhooks, Terminal, Claude Code)",
        event: "finished",
        session: {
          name: "billing-webhooks",
          agent: "Claude Code",
          folder: "billing-webhooks",
          app: "Terminal",
        },
        at: new Date(T0 + 2_000).toISOString(),
      },
    ]);
  });

  test("a redirect is not followed, and the status says so", async () => {
    const elsewhere = await startWebhookServer();
    const hook = await startWebhookServer({
      behaviour: "redirect",
      redirectTo: elsewhere.url("/stolen"),
    });
    const server = await posting({
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
    });
    await server.poll(0, [busy(1, "search-indexing")]);
    await server.poll(2_000, [asking(1, "search-indexing", 2_000)]);
    await server.settled();

    expect(hook.received).toHaveLength(1);
    expect(elsewhere.connections).toBe(0);
    expect((await server.status()).last).toEqual({
      at: T0 + 2_000,
      sent: false,
      reason: "the address answered with a redirect, which is not followed",
    });
  });

  test.each([
    ["silent", "the address did not answer in time"],
    ["fail", "the receiving service had a problem (status 500)"],
  ] as const)(
    "an address that is %s leaves the poll unharmed, and the status says what happened",
    async (behaviour, reason) => {
      const hook = await startWebhookServer({ behaviour });
      const server = await posting({
        AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
        AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
      });
      await server.poll(0, [busy(1, "mobile-onboarding")]);

      const started = Date.now();
      await server.poll(2_000, [asking(1, "mobile-onboarding", 2_000)]);
      // The poll did not wait for the address.
      expect(Date.now() - started).toBeLessThan(250);
      expect(server.collector.poller.getSnapshot().sessions[0]?.status).toBe("needs-you");

      await server.settled();
      expect(hook.connections).toBe(1);
      expect((await server.status()).last).toEqual({ at: T0 + 2_000, sent: false, reason });

      // The polls go on, and that wait is not tried again.
      await server.poll(4_000, [asking(1, "mobile-onboarding", 2_000)]);
      await server.poll(6_000, [busy(1, "mobile-onboarding")]);
      await server.settled();
      expect(hook.connections).toBe(1);
      expect(server.collector.poller.getSnapshot().sessions[0]?.status).toBe("working");
    },
  );

  test(`no more than ${SENDS_PER_HOUR} go in an hour, and the status says when the next can`, async () => {
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
    });
    const sessions = (make: (n: number) => Session) =>
      Array.from({ length: SENDS_PER_HOUR + 3 }, (_, index) => make(index + 1));

    await server.poll(
      0,
      sessions((n) => busy(n, `docs-site-${n}`)),
    );
    await server.poll(
      2_000,
      sessions((n) => asking(n, `docs-site-${n}`, 2_000)),
    );
    await server.poll(
      60_000,
      sessions((n) => asking(n, `docs-site-${n}`, 2_000)),
    );
    await server.settled();

    expect(hook.received).toHaveLength(SENDS_PER_HOUR);
    expect((await server.status()).limitedUntil).toBe(T0 + 2_000 + HOUR_MS);
  });

  test("with email and the webhook both set, one wait sends one email and one post, each counted on its own", async () => {
    const mail = await startSmtpServer();
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_AFTER: "0",
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
    });
    await server.poll(0, [busy(1, "api-rate-limits")]);
    await server.poll(2_000, [asking(1, "api-rate-limits", 2_000)]);
    await server.settled();
    expect((await server.status()).last).toEqual({ at: T0 + 2_000, sent: true });
    await server.poll(4_000, [asking(1, "api-rate-limits", 2_000)]);
    await server.settled();

    expect(mail.received).toHaveLength(1);
    expect(headerValues(mail.received[0]?.data ?? "", "Subject")).toEqual([
      "api-rate-limits is waiting for permission",
    ]);
    expect(bodies(hook).map((post) => post.text)).toEqual([
      "api-rate-limits is waiting for permission (0s, api-rate-limits, VS Code, Claude Code)",
    ]);
  });

  test("a setting that is wrong turns the webhook off, with one line that names it and never the address", async () => {
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_WEBHOOK_URL: hook
        .url("/services/T0000/s3cret-token")
        .replace("127.0.0.1", "example.test"),
    });
    await server.poll(0, [busy(1, "infra-terraform")]);
    await server.poll(2_000, [asking(1, "infra-terraform", 2_000)]);
    await server.poll(HOUR_MS, [asking(1, "infra-terraform", 2_000)]);

    expect(server.warnings).toEqual([
      "Webhook notifications are off: AGENT_LOOKOUT_WEBHOOK_URL must begin with https://, or with http:// for an address on this computer, 127.0.0.1 or localhost.",
    ]);
    const status = await server.status();
    expect(status).toMatchObject({ on: false, host: null });
    const said = `${server.warnings.join("\n")}${JSON.stringify(status)}`;
    for (const secret of ["s3cret", "T0000", "example.test", "/services"]) {
      expect(said).not.toContain(secret);
    }
    expect(server.collector.webhook).toBeNull();
    expect(server.sendersMade()).toBe(0);
    expect(hook.connections).toBe(0);
  });
});
