import { appendFile, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import path from "node:path";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { createCollector } from "@collector/collector";
import type { AskGh } from "@collector/github/gh";
import type { PullRequestTarget } from "@collector/git/pullRequestTarget";
import { createSmtpSender } from "@collector/email/smtpSender";
import { createCollectorSettings } from "@collector/settings/collectorSettings";
import { readSettingsSetup } from "@collector/settings/settingsFile";
import { HANDOVER_GRACE_MS } from "@collector/notifications/heldWait";
import { NOTIFICATIONS_NOT_SHOWN_LINE } from "@collector/notifications/serverNotifications";
import { createNtfySender } from "@collector/ntfy/ntfySender";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import { createPushoverSender } from "@collector/pushover/pushoverSender";
import type { WebhookPost } from "@collector/webhook/webhookMessage";
import { createHttpSender } from "@collector/webhook/webhookSender";
import {
  NOTIFICATIONS_HEADER,
  SENDS_PER_HOUR,
  type EmailStatusResponse,
  type EventsResponse,
  type HistoryResponse,
  type NtfyStatusResponse,
  type PullRequestsStatusResponse,
  type PushoverStatusResponse,
  type WebhookStatusResponse,
} from "@core/api";
import { applyRulesChange } from "@core/permission-rules/rulesChange";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { readEvents, readHistory, readSnapshot } from "@dashboard/lib/api/readApi";
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
  NO_SETTINGS_FILE,
  tempDir,
} from "@tests/support/node/tempFiles";
import { startWebhookServer } from "@tests/support/channels/webhook";
import { snapshotThere, waitingThere, workingThere } from "@tests/fixtures/remote";
import { isRunning, makeStandInSsh, startStandInLookout } from "@tests/support/remotes/standIns";

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
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
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
      /^Sessions are read from the files Codex saves in \S+[\\/]fixtures[\\/]codex-home[\\/]sessions\. /,
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
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
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
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
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
    env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
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

  test("with AGENT_LOOKOUT_NOTIFICATIONS=on away from macOS, it says once at start that it shows none itself", () => {
    const said = (options: { platform: NodeJS.Platform; on?: boolean; notifier?: boolean }) => {
      const warnings: string[] = [];
      createCollector({
        version: "9.9.9-test",
        adapters: [],
        env: {
          AGENT_LOOKOUT_HISTORY: "off",
          AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
          ...(options.on === false ? {} : { AGENT_LOOKOUT_NOTIFICATIONS: "on" }),
        },
        platform: options.platform,
        // Left out, the system's own notifier for that platform is made.
        ...(options.notifier ? { notifier: fakeSystemNotifier() } : {}),
        warn: (line) => warnings.push(line),
      });
      return warnings;
    };

    expect(said({ platform: "linux" })).toEqual([NOTIFICATIONS_NOT_SHOWN_LINE]);
    expect(said({ platform: "win32" })).toEqual([NOTIFICATIONS_NOT_SHOWN_LINE]);
    expect(said({ platform: "linux", on: false })).toEqual([]);
    // A host that brings a notifier of its own, as a desktop app would, shows them.
    expect(said({ platform: "linux", notifier: true })).toEqual([]);
    expect(said({ platform: "darwin", notifier: true })).toEqual([]);
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
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
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
      asking: null,
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

  test("with AGENT_LOOKOUT_EMAIL_ASKING=on, the email for a wait says what the session is asking, and without it the email leaves it out", async () => {
    const asked = (n: number, name: string, atOffsetMs: number): Session => ({
      ...asking(n, name, atOffsetMs),
      // As the Claude Code adapter reads it from the end of the transcript.
      waitingText: "Run: npm test -- --runInBand",
    });
    const results: Record<string, { status: EmailStatusResponse; text: string }> = {};
    for (const setting of ["on", "off", undefined]) {
      const mail = await startSmtpServer();
      const server = await mailing({
        AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
        AGENT_LOOKOUT_SMTP_URL: mail.url(),
        AGENT_LOOKOUT_EMAIL_AFTER: "0",
        AGENT_LOOKOUT_EMAIL_EVENTS: "needs-you,ended",
        ...(setting === undefined ? {} : { AGENT_LOOKOUT_EMAIL_ASKING: setting }),
      });
      await server.poll(0, [busy(1, "checkout-flow")]);
      await server.poll(2_000, [asked(1, "checkout-flow", 2_000)]);
      await server.poll(4_000, []);
      await server.settled();

      expect(mail.received.map((email) => headerValues(email.data, "Subject"))).toEqual([
        ["checkout-flow is waiting for permission"],
        ["checkout-flow ended"],
      ]);
      // Only the wait could say it: the email for the end of the same session never does.
      expect(textOf(mail.received[1]?.data ?? "")).not.toContain("npm test");
      results[String(setting)] = {
        status: await server.status(),
        text: textOf(mail.received[0]?.data ?? ""),
      };
    }

    expect(results.on?.status.asking).toBe(true);
    expect(results.on?.text).toContain(
      "\n\nAsking: Run: npm test -- --runInBand\nFolder: checkout-flow\nApp: VS Code\nAgent: Claude Code\n",
    );
    for (const off of [results.off, results.undefined]) {
      expect(off?.status.asking).toBe(false);
      expect(off?.text).toContain("\n\nFolder: checkout-flow\nApp: VS Code\nAgent: Claude Code\n");
      expect(off?.text).not.toMatch(/Asking|npm test/);
    }
    // The page is told whether it is on, and never what was asked.
    expect(JSON.stringify(results.on?.status)).not.toContain("npm test");
  });

  test("an AGENT_LOOKOUT_EMAIL_ASKING that is not on or off turns email off, and says so in one line", async () => {
    const mail = await startSmtpServer();
    const server = await mailing({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_ASKING: "yes",
    });
    expect(server.collector.email).toBeNull();
    expect(server.warnings).toEqual([
      "Email notifications are off: AGENT_LOOKOUT_EMAIL_ASKING must be on or off.",
    ]);
    expect(await server.status()).toMatchObject({
      on: false,
      asking: null,
      problem: "AGENT_LOOKOUT_EMAIL_ASKING must be on or off.",
    });
    expect(mail.connections).toBe(0);
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
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
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
      asking: null,
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
      asking: false,
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

  test("with AGENT_LOOKOUT_WEBHOOK_ASKING=on, the post for a wait says what the session is asking, and without it the post leaves it out", async () => {
    const asked = (n: number, name: string, atOffsetMs: number): Session => ({
      ...asking(n, name, atOffsetMs),
      waitingText: "Fetch: https://example.com/docs?page=2&lang=en",
    });
    const posted: Record<string, { status: WebhookStatusResponse; posts: WebhookPost[] }> = {};
    for (const setting of ["on", "off", undefined]) {
      const hook = await startWebhookServer();
      const server = await posting({
        AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
        AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
        AGENT_LOOKOUT_WEBHOOK_EVENTS: "needs-you,ended",
        ...(setting === undefined ? {} : { AGENT_LOOKOUT_WEBHOOK_ASKING: setting }),
      });
      await server.poll(0, [busy(1, "checkout-flow")]);
      await server.poll(2_000, [asked(1, "checkout-flow", 2_000)]);
      await server.poll(4_000, []);
      await server.settled();
      posted[String(setting)] = { status: await server.status(), posts: bodies(hook) };
    }

    const on = posted.on;
    expect(on?.status.asking).toBe(true);
    expect(on?.posts).toEqual([
      {
        text: "checkout-flow is waiting for permission: Fetch: https://example.com/docs?page=2&amp;lang=en (0s, checkout-flow, VS Code, Claude Code)",
        event: "needs-you",
        reason: "permission",
        asking: "Fetch: https://example.com/docs?page=2&lang=en",
        session: {
          name: "checkout-flow",
          agent: "Claude Code",
          folder: "checkout-flow",
          app: "VS Code",
        },
        at: new Date(T0 + 2_000).toISOString(),
        waitedSeconds: 0,
      },
      {
        text: "checkout-flow ended (checkout-flow, VS Code, Claude Code)",
        event: "ended",
        session: {
          name: "checkout-flow",
          agent: "Claude Code",
          folder: "checkout-flow",
          app: "VS Code",
        },
        at: new Date(T0 + 4_000).toISOString(),
      },
    ]);
    for (const off of [posted.off, posted.undefined]) {
      expect(off?.status.asking).toBe(false);
      expect(off?.posts.map((post) => post.text)).toEqual([
        "checkout-flow is waiting for permission (0s, checkout-flow, VS Code, Claude Code)",
        "checkout-flow ended (checkout-flow, VS Code, Claude Code)",
      ]);
      expect(JSON.stringify(off?.posts)).not.toMatch(/asking|example\.com|Fetch/);
    }
    expect(JSON.stringify(on?.status)).not.toContain("example.com");
  });

  test("email and the webhook each follow their own setting", async () => {
    const mail = await startSmtpServer();
    const hook = await startWebhookServer();
    const server = await posting({
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_AFTER: "0",
      AGENT_LOOKOUT_EMAIL_ASKING: "on",
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
    });
    await server.poll(0, [busy(1, "docs-site")]);
    await server.poll(2_000, [{ ...asking(1, "docs-site", 2_000), waitingText: "Run: make docs" }]);
    await server.settled();

    expect(textOf(mail.received[0]?.data ?? "")).toContain("\nAsking: Run: make docs\n");
    expect(bodies(hook)).toHaveLength(1);
    expect(hook.received[0]?.body).not.toContain("make docs");
    expect((await server.status()).asking).toBe(false);
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

describe("pushes to a phone", () => {
  const TOPIC = "s3cret-topic-3f9c2a7e";
  const NTFY_TOKEN = "tk_s3cretaccesstoken00000000000";
  const APP_TOKEN = "atest0000000000000000000000000";
  const USER_KEY = "utest0000000000000000000000000";

  /**
   * A collector over a stand-in source, served over real HTTP, with the push
   * settings in `env`. Pushover is reached at `pushover`, a server of the
   * test's own, never at Pushover itself. Every line it would print is
   * written down, and so is each sender it makes.
   */
  async function pushing(env: Record<string, string>, pushover?: { url(path?: string): string }) {
    const { state, adapter } = standInSource();
    const warnings: string[] = [];
    const made = { ntfy: 0, pushover: 0 };
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [adapter],
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
      notifier: fakeSystemNotifier(),
      now: () => state.now,
      warn: (line) => warnings.push(line),
      createNtfySender: (settings) => {
        made.ntfy += 1;
        return createNtfySender(settings, { version: "9.9.9-test", timeoutMs: 300 });
      },
      createPushoverSender: (settings) => {
        made.pushover += 1;
        return createPushoverSender(settings, {
          version: "9.9.9-test",
          timeoutMs: 300,
          endpoint: new URL(pushover?.url("/1/messages.json") ?? "http://127.0.0.1:1/"),
        });
      },
    });
    const port = await listen(createServer(collector.handler));
    return {
      collector,
      warnings,
      made,
      port,
      async poll(atOffsetMs: number, sessions: Session[]) {
        state.now = T0 + atOffsetMs;
        state.sessions = sessions;
        await collector.poller.pollOnce();
        await collector.ntfy?.settled();
        await collector.pushover?.settled();
      },
      async status() {
        const ntfy = await request(port, "/api/ntfy");
        const pushed = await request(port, "/api/pushover");
        expect([ntfy.status, pushed.status]).toEqual([200, 200]);
        return {
          ntfy: ntfy.json<NtfyStatusResponse>(),
          pushover: pushed.json<PushoverStatusResponse>(),
          said: `${ntfy.body}${pushed.body}`,
        };
      },
    };
  }

  const pushId = (n: number) =>
    `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const busy = (n: number, name: string) =>
    makeSession({ id: pushId(n), name, project: name, status: "working", statusSince: null });
  const asking = (n: number, name: string, atOffsetMs: number) =>
    makeSession({
      id: pushId(n),
      name,
      project: name,
      surface: "vscode",
      cwd: `/Users/example/code/${name}`,
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      waitingText: "Run: npm test",
      statusSince: T0 + atOffsetMs,
    });

  test("with nothing set, nothing is pushed, nothing that could push is made, and no connection is opened", async () => {
    const server = await pushing({ AGENT_LOOKOUT_NOTIFICATIONS: "on" });
    const connects = vi.spyOn(Socket.prototype, "connect");
    try {
      await server.poll(0, [busy(1, "checkout-flow")]);
      await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
      await server.poll(HOUR_MS, [asking(1, "checkout-flow", 2_000)]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(connects).not.toHaveBeenCalled();
    } finally {
      connects.mockRestore();
    }
    expect([server.collector.ntfy, server.collector.pushover]).toEqual([null, null]);
    expect(server.made).toEqual({ ntfy: 0, pushover: 0 });
    expect(server.warnings).toEqual([]);
    const { ntfy, pushover } = await server.status();
    expect(ntfy).toMatchObject({ on: false, host: null, tokenSet: null, problem: null });
    expect(pushover).toMatchObject({ on: false, problem: null });
  });

  test("a wait that lasts the delay is pushed once each way, saying what it asks only where that is on, and the page is told no secret", async () => {
    const ntfy = await startWebhookServer();
    const pushover = await startWebhookServer();
    const server = await pushing(
      {
        AGENT_LOOKOUT_NTFY_URL: ntfy.url(`/${TOPIC}`),
        AGENT_LOOKOUT_NTFY_TOKEN: NTFY_TOKEN,
        AGENT_LOOKOUT_NTFY_ASKING: "on",
        AGENT_LOOKOUT_PUSHOVER_TOKEN: APP_TOKEN,
        AGENT_LOOKOUT_PUSHOVER_USER: USER_KEY,
        AGENT_LOOKOUT_PUSHOVER_AFTER: "30",
      },
      pushover,
    );
    await server.poll(0, [busy(1, "checkout-flow")]);
    await server.poll(2_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(20_000, [asking(1, "checkout-flow", 2_000)]);
    expect([ntfy.received, pushover.received]).toEqual([[], []]);
    await server.poll(62_000, [asking(1, "checkout-flow", 2_000)]);
    await server.poll(HOUR_MS, [asking(1, "checkout-flow", 2_000)]);

    expect(ntfy.received.map((push) => JSON.parse(push.body))).toEqual([
      {
        topic: TOPIC,
        title: "checkout-flow is waiting for permission",
        message: "Asking: Run: npm test\n1m 00s · checkout-flow · VS Code · Claude Code",
        priority: 4,
        tags: ["hourglass"],
      },
    ]);
    expect(ntfy.received[0]?.headers.authorization).toBe(`Bearer ${NTFY_TOKEN}`);
    // Pushover's delay is its own, and it leaves out what is asked.
    expect(pushover.received.map((push) => JSON.parse(push.body))).toEqual([
      {
        token: APP_TOKEN,
        user: USER_KEY,
        title: "checkout-flow is waiting for permission",
        message: "1m 00s · checkout-flow · VS Code · Claude Code",
        priority: 0,
      },
    ]);

    const { ntfy: ntfyStatus, pushover: pushoverStatus, said } = await server.status();
    expect(ntfyStatus).toEqual({
      on: true,
      host: "127.0.0.1",
      tokenSet: true,
      events: ["needs-you"],
      afterMs: 60_000,
      asking: true,
      problem: null,
      last: { at: T0 + 62_000, sent: true },
      limitedUntil: null,
    });
    expect(pushoverStatus).toMatchObject({ on: true, afterMs: 30_000, asking: false });
    for (const secret of [TOPIC, "s3cret", NTFY_TOKEN, APP_TOKEN, USER_KEY, "npm test"]) {
      expect(said).not.toContain(secret);
    }
  });

  test("a setting that is wrong turns that channel off, with one line that names it and never its value", async () => {
    const ntfy = await startWebhookServer();
    const pushover = await startWebhookServer();
    const server = await pushing(
      {
        AGENT_LOOKOUT_NTFY_URL: `${ntfy.url(`/${TOPIC}`)}?auth=${NTFY_TOKEN}`,
        AGENT_LOOKOUT_PUSHOVER_TOKEN: APP_TOKEN,
      },
      pushover,
    );
    await server.poll(0, [busy(1, "infra-terraform")]);
    await server.poll(2_000, [asking(1, "infra-terraform", 2_000)]);
    await server.poll(HOUR_MS, [asking(1, "infra-terraform", 2_000)]);

    expect(server.warnings).toEqual([
      "ntfy pushes are off: AGENT_LOOKOUT_NTFY_URL must end with the topic, with no ? or # after it. Put an access token in AGENT_LOOKOUT_NTFY_TOKEN.",
      "Pushover pushes are off: AGENT_LOOKOUT_PUSHOVER_USER is not set.",
    ]);
    const { ntfy: ntfyStatus, pushover: pushoverStatus, said } = await server.status();
    expect(ntfyStatus).toMatchObject({ on: false, host: null });
    expect(pushoverStatus).toMatchObject({
      on: false,
      problem: "AGENT_LOOKOUT_PUSHOVER_USER is not set.",
    });
    for (const secret of [TOPIC, NTFY_TOKEN, APP_TOKEN, "127.0.0.1"]) {
      expect(`${server.warnings.join("\n")}${said}`).not.toContain(secret);
    }
    expect(server.made).toEqual({ ntfy: 0, pushover: 0 });
    expect([ntfy.connections, pushover.connections]).toEqual([0, 0]);
  });
});

describe("what a host is told", () => {
  test("a host that listens is told each poll's sessions", async () => {
    const source = standInSource([waiting("mobile-onboarding")]);
    const told: string[][] = [];
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [source.adapter],
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE },
      notifier: fakeSystemNotifier(),
      now: () => source.state.now,
      onSnapshot: (snapshot) => told.push(snapshot.sessions.map((session) => session.status)),
    });

    await collector.poller.pollOnce();
    source.state.now += 2_000;
    source.state.sessions = [working("mobile-onboarding")];
    await collector.poller.pollOnce();

    expect(told).toEqual([["needs-you"], ["working"]]);
  });

  test("a listener that throws leaves the poll's answer standing", async () => {
    const source = standInSource([waiting("mobile-onboarding")]);
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [source.adapter],
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE },
      notifier: fakeSystemNotifier(),
      now: () => source.state.now,
      onSnapshot: () => {
        throw new Error("the listener's own fault");
      },
    });

    const snapshot = await collector.poller.pollOnce();
    expect(snapshot.sessions.map((session) => session.status)).toEqual(["needs-you"]);
    expect(collector.poller.getSnapshot()).toBe(snapshot);
  });
});

describe("a settings file shared with another copy of Agent Lookout", () => {
  test("the rules the other copy saves are in force here from the next poll", async () => {
    const file = path.join(await tempDir(), "settings.json");
    const source = standInSource([working("docs-site")]);
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [source.adapter],
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: file },
      notifier: fakeSystemNotifier(),
      now: () => source.state.now,
    });
    expect((await collector.poller.pollOnce()).timeRules).toEqual(DEFAULT_TIME_RULES);

    // The other copy, as the Mac app beside `npx agent-lookout`, on the same file.
    const other = createCollectorSettings({
      setup: readSettingsSetup({ AGENT_LOOKOUT_SETTINGS_FILE: file }),
    });
    const rules: TimeRules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 2 } };
    expect(other.changeTimeRules(rules)).toEqual({ ok: true });
    const rule = { decision: "deny", tool: "Write" } as const;
    other.changePermissionRules((held) =>
      applyRulesChange(held, { kind: "add", words: rule }, () => "dddddddddddd"),
    );

    source.state.now += 2_000;
    expect((await collector.poller.pollOnce()).timeRules).toEqual(rules);
    expect(collector.settings.permissionRules()).toEqual([{ id: "dddddddddddd", ...rule }]);
  });
});

describe("history kept on disk", () => {
  /**
   * A collector over a stand-in source, keeping its history in `dir`, served
   * over real HTTP and started as a host starts it: once the history has been
   * read back, it polls. It is stopped when the test finishes.
   */
  async function keeping(
    dir: string,
    source: ReturnType<typeof standInSource>,
    env = {},
    more: Pick<Parameters<typeof createCollector>[0], "createPushoverSender"> = {},
  ) {
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [source.adapter],
      env: {
        AGENT_LOOKOUT_HISTORY_DIR: dir,
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
        ...env,
      },
      notifier: fakeSystemNotifier(),
      now: () => source.state.now,
      intervalMs: 1_000_000_000,
      ...more,
    });
    const port = await listen(createServer(collector.handler));
    collector.start();
    onTestFinished(() => collector.stop());
    await collector.whenStarted();
    await collector.poller.pollOnce();
    return {
      collector,
      port,
      async poll(atOffsetMs: number, sessions: Session[]) {
        source.state.now = T0 + atOffsetMs;
        source.state.sessions = sessions;
        await collector.poller.pollOnce();
      },
    };
  }

  /** Every history file in the folder, as one text. */
  async function files(dir: string): Promise<string> {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
    return (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join(
      "",
    );
  }

  test("the Events log and the history come back after a restart, with the time it was stopped not measured", async () => {
    const dir = await tempDir();
    const source = standInSource([working("checkout-flow")]);
    const first = await keeping(dir, source);
    await first.poll(2_000, [waiting("checkout-flow")]);
    await first.poll(4_000, [working("checkout-flow")]);
    first.collector.stop();

    // A minute later it starts again, and the session is still working.
    source.state.now = T0 + 64_000;
    const second = await keeping(dir, source);
    const { events } = (await request(second.port, "/api/events")).json<EventsResponse>();
    expect(events.map((event) => [event.at - T0, event.from, event.to])).toEqual([
      [4_000, "needs-you", "working"],
      [2_000, "working", "needs-you"],
    ]);

    const history = (
      await request(second.port, `/api/history?windowMs=${60 * 60_000}`)
    ).json<HistoryResponse>();
    expect(history.points.map((point) => [point.at - T0, point.needsYou, point.working])).toEqual([
      [0, 0, 1],
      [2_000, 1, 0],
      [4_000, 0, 1],
      [64_000, 0, 1],
    ]);
    // This run began now, and the history it holds began with the first.
    expect(history.startedAt).toBe(T0 + 64_000);
    expect(history.since).toEqual({ at: T0, by: "started" });
    expect(history.kept).toMatchObject({
      where: "disk",
      folder: dir,
      canClear: true,
      problem: null,
    });
    // No point stands for the minute it was stopped, so the dashboard draws
    // that minute as time not measured, as it draws a computer asleep.
    const times = history.points.map((point) => point.at);
    expect((times[3] as number) - (times[2] as number)).toBe(60_000);
  });

  test("what changed while it was stopped is recorded at the first poll after, and the restart is listed", async () => {
    const dir = await tempDir();
    const other = "claude-code:00000000-0000-4000-8000-000000000002";
    const deploy = (status: Session["status"]) =>
      makeSession({ id: other, name: "deploy-bot", status });
    const idle = makeSession({ id, name: "checkout-flow", status: "idle" });
    const source = standInSource([idle, deploy("working")]);
    const first = await keeping(dir, source);
    // checkout-flow starts working, and deploy-bot starts waiting, five minutes in.
    for (let at = 2_000; at <= 30 * 60_000; at += 2_000) {
      const later = at >= 5 * 60_000;
      await first.poll(at, [
        later ? working("checkout-flow") : idle,
        deploy(later ? "needs-you" : "working"),
      ]);
    }
    first.collector.stop();

    // Five minutes later it starts again. Meanwhile checkout-flow began to
    // wait, and deploy-bot, which was waiting, ended.
    source.state.now = T0 + 35 * 60_000;
    source.state.sessions = [waiting("checkout-flow")];
    const second = await keeping(dir, source);
    for (let at = 35 * 60_000 + 2_000; at <= 36 * 60_000; at += 2_000) {
      await second.poll(at, [waiting("checkout-flow")]);
    }

    const events = readEvents((await request(second.port, "/api/events")).json()) ?? [];
    expect(
      events
        .slice(0, 2)
        .map((event) => [event.at - T0, event.sessionName, event.kind, event.from, event.to]),
    ).toEqual([
      [35 * 60_000, "deploy-bot", "ended", "needs-you", undefined],
      [35 * 60_000, "checkout-flow", "status-changed", "working", "needs-you"],
    ]);
    const history = readHistory(
      (await request(second.port, `/api/history?windowMs=${60 * 60_000}`)).json(),
    );
    expect(history?.restarts).toEqual([{ at: T0 + 35 * 60_000, lastBefore: T0 + 30 * 60_000 }]);
    // No point stands for the five minutes it was stopped.
    const times = history?.points.map((point) => point.at - T0) ?? [];
    expect(times.filter((at) => at > 30 * 60_000 && at < 35 * 60_000)).toEqual([]);
    expect(times.at(-1)).toBe(36 * 60_000);
    // The dashboard counts the wait from the restart: tests/unit/dashboard/lib/sessions/waits.test.ts.
    const snapshot = readSnapshot((await request(second.port, "/api/sessions")).json());
    expect(snapshot?.sessions.map((session) => [session.name, session.status])).toEqual([
      ["checkout-flow", "needs-you"],
    ]);
  });

  test("a restart of a few seconds is a break all the same", async () => {
    const dir = await tempDir();
    const source = standInSource([working("checkout-flow")]);
    const first = await keeping(dir, source);
    await first.poll(2_000, [working("checkout-flow")]);
    first.collector.stop();

    source.state.now = T0 + 5_000;
    const second = await keeping(dir, source);
    await second.poll(7_000, [working("checkout-flow")]);
    const history = (await request(second.port, "/api/history")).json<HistoryResponse>();
    expect(history.restarts).toEqual([{ at: T0 + 5_000, lastBefore: T0 + 2_000 }]);
  });

  test("what a waiting session is asking is never written, though the snapshot holds it", async () => {
    const dir = await tempDir();
    const source = standInSource([working("checkout-flow")]);
    const server = await keeping(dir, source);
    const asking = { ...waiting("checkout-flow"), waitingText: "Run: ./scripts/release.sh" };
    await server.poll(2_000, [asking]);
    const snapshot = (await request(server.port, "/api/sessions")).json<SessionsSnapshot>();
    expect(snapshot.sessions[0]?.waitingText).toBe("Run: ./scripts/release.sh");
    await server.poll(4_000, [asking]);
    await server.poll(6_000, [working("checkout-flow")]);
    server.collector.stop();

    const text = await files(dir);
    expect(text).toContain('"to":"needs-you"');
    expect(text).not.toContain("waitingText");
    expect(text).not.toContain("release.sh");
    expect(text).not.toContain("Run:");
  });

  test("what a waiting session is asking, sent by email, to the webhook and as a push, is kept nowhere", async () => {
    const mail = await startSmtpServer();
    const hook = await startWebhookServer();
    const ntfy = await startWebhookServer();
    const pushover = await startWebhookServer();
    const dir = await tempDir();
    const source = standInSource([working("checkout-flow")]);
    const server = await keeping(
      dir,
      source,
      {
        AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
        AGENT_LOOKOUT_SMTP_URL: mail.url(),
        AGENT_LOOKOUT_EMAIL_AFTER: "0",
        AGENT_LOOKOUT_EMAIL_EVENTS: "needs-you,finished,ended",
        AGENT_LOOKOUT_EMAIL_ASKING: "on",
        AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
        AGENT_LOOKOUT_WEBHOOK_AFTER: "0",
        AGENT_LOOKOUT_WEBHOOK_EVENTS: "needs-you,finished,ended",
        AGENT_LOOKOUT_WEBHOOK_ASKING: "on",
        // The collector's own sender for ntfy, aimed at the stand-in by the setting alone.
        AGENT_LOOKOUT_NTFY_URL: ntfy.url("/agent-lookout-topic"),
        AGENT_LOOKOUT_NTFY_AFTER: "0",
        AGENT_LOOKOUT_NTFY_EVENTS: "needs-you,finished,ended",
        AGENT_LOOKOUT_NTFY_ASKING: "on",
        AGENT_LOOKOUT_PUSHOVER_TOKEN: "atest0000000000000000000000000",
        AGENT_LOOKOUT_PUSHOVER_USER: "utest0000000000000000000000000",
        AGENT_LOOKOUT_PUSHOVER_AFTER: "0",
        AGENT_LOOKOUT_PUSHOVER_EVENTS: "needs-you,finished,ended",
        AGENT_LOOKOUT_PUSHOVER_ASKING: "on",
      },
      {
        createPushoverSender: (settings) =>
          createPushoverSender(settings, {
            version: "9.9.9-test",
            endpoint: new URL(pushover.url("/1/messages.json")),
          }),
      },
    );
    const asked = { ...waiting("checkout-flow"), waitingText: "Run: ./scripts/release.sh" };
    await server.poll(2_000, [asked]);
    await server.poll(4_000, [asked]);
    await server.poll(6_000, [working("checkout-flow")]);
    await server.poll(8_000, []);
    await server.collector.email?.settled();
    await server.collector.webhook?.settled();
    await server.collector.ntfy?.settled();
    await server.collector.pushover?.settled();

    // It went: once by email, once to the webhook and once in each push, for the wait alone.
    expect(mail.received.map((email) => textOf(email.data).includes("release.sh"))).toEqual([
      true,
      false,
    ]);
    expect(hook.received.map((post) => post.body.includes("release.sh"))).toEqual([true, false]);
    expect(ntfy.received.map((push) => push.body.includes("release.sh"))).toEqual([true, false]);
    expect(pushover.received.map((push) => push.body.includes("release.sh"))).toEqual([
      true,
      false,
    ]);

    // And nothing that is kept, or that the page is told, holds it.
    const answers = await Promise.all(
      [
        "/api/sessions",
        "/api/events?since=0",
        "/api/history",
        "/api/email",
        "/api/webhook",
        "/api/ntfy",
        "/api/pushover",
      ].map(async (target) => (await request(server.port, target)).body),
    );
    server.collector.stop();
    const text = await files(dir);
    expect(text).toContain('"to":"needs-you"');
    for (const kept of [text, ...answers]) {
      expect(kept).not.toContain("release.sh");
      expect(kept).not.toContain("waitingText");
    }
    for (const answer of answers.slice(3)) {
      expect(JSON.parse(answer)).toMatchObject({ on: true, asking: true });
    }
  });

  test("with AGENT_LOOKOUT_HISTORY=off nothing is written, and the history starts empty each time", async () => {
    const dir = path.join(await tempDir(), "history");
    const source = standInSource([working("checkout-flow")]);
    const first = await keeping(dir, source, { AGENT_LOOKOUT_HISTORY: "off" });
    await first.poll(2_000, [waiting("checkout-flow")]);
    first.collector.stop();
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });

    source.state.now = T0 + 64_000;
    const second = await keeping(dir, source, { AGENT_LOOKOUT_HISTORY: "off" });
    expect((await request(second.port, "/api/events")).json<EventsResponse>().events).toEqual([]);
    const history = (await request(second.port, "/api/history")).json<HistoryResponse>();
    expect(history.since).toEqual({ at: T0 + 64_000, by: "started" });
    expect(history.kept).toMatchObject({ where: "memory", folder: null, canClear: false });
  });

  test("while another copy writes the history, this one reads what was kept, writes nothing, and says so", async () => {
    const dir = await tempDir();
    const source = standInSource([working("checkout-flow")]);
    const first = await keeping(dir, source);
    await first.poll(2_000, [waiting("checkout-flow")]);
    first.collector.stop();
    // Another copy, a process that is running, has just taken the folder.
    await writeFile(path.join(dir, "writer.lock"), `${JSON.stringify({ pid: process.ppid })}\n`);

    const second = await keeping(dir, standInSource([waiting("checkout-flow")]));
    await second.collector.history?.flush();
    const history = (await request(second.port, "/api/history")).json<HistoryResponse>();
    expect(history.kept).toMatchObject({ where: "disk", canClear: false });
    expect(history.kept?.problem).toMatch(/^Another copy of Agent Lookout/);
    expect((await request(second.port, "/api/events")).json<EventsResponse>().events).toHaveLength(
      1,
    );

    const before = await files(dir);
    await second.poll(4_000, [working("checkout-flow")]);
    await second.collector.history?.flush();
    second.collector.stop();
    expect(await files(dir)).toBe(before);
    expect(await readFile(path.join(dir, "writer.lock"), "utf8")).toContain(String(process.ppid));
  });
});

describe("pull requests", () => {
  /**
   * A repository of plain files in a temporary folder, with a remote on
   * github.com and `main` its default, and a worktree folder on `branch`. No
   * git is run to make it, and none is run to read it.
   */
  async function repositoryOn(branch: string): Promise<string> {
    const folder = path.join(await tempDir(), "storefront");
    await mkdir(path.join(folder, ".git", "refs", "remotes", "origin"), { recursive: true });
    await writeFile(path.join(folder, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
    await writeFile(
      path.join(folder, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:example-org/storefront.git\n`,
    );
    await writeFile(
      path.join(folder, ".git", "refs", "remotes", "origin", "HEAD"),
      "ref: refs/remotes/origin/main\n",
    );
    return folder;
  }

  /** A gh that writes down each question and answers with pull request 51, failing. */
  function standInGh() {
    const asked: PullRequestTarget[] = [];
    const ask: AskGh = async (target) => {
      asked.push(target);
      return {
        kind: "found",
        pullRequest: {
          number: 51,
          title: "Show the pull request and its checks",
          state: "open",
          checks: { state: "failing", passing: 4, failing: 2, pending: 0 },
          url: "https://github.com/example-org/storefront/pull/51",
        },
      };
    };
    return { asked, ask };
  }

  async function pulling(env: Record<string, string>, folder: string) {
    const source = standInSource([
      makeSession({ id, name: "checkout-flow", cwd: folder, project: "storefront" }),
    ]);
    const gh = standInGh();
    const warnings: string[] = [];
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [source.adapter],
      env: { AGENT_LOOKOUT_HISTORY: "off", AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE, ...env },
      notifier: fakeSystemNotifier(),
      gh: gh.ask,
      now: () => source.state.now,
      warn: (line) => warnings.push(line),
    });
    const port = await listen(createServer(collector.handler));
    return {
      collector,
      gh,
      warnings,
      async poll() {
        await collector.poller.pollOnce();
        await collector.pullRequests?.settled();
        return (await request(port, "/api/sessions")).json<SessionsSnapshot>();
      },
      async status() {
        return (await request(port, "/api/pull-requests")).json<PullRequestsStatusResponse>();
      },
    };
  }

  test("with AGENT_LOOKOUT_PULL_REQUESTS=on, a branch's pull request is asked for once and given to its sessions", async () => {
    const server = await pulling(
      { AGENT_LOOKOUT_PULL_REQUESTS: "on" },
      await repositoryOn("checkout-flow"),
    );

    await server.poll();
    const snapshot = await server.poll();
    expect(snapshot.sessions[0]?.git).toMatchObject({
      branch: "checkout-flow",
      pullRequest: { number: 51, state: "open", checks: { state: "failing" } },
    });
    expect(server.gh.asked).toEqual([
      { repository: { owner: "example-org", name: "storefront" }, head: "checkout-flow" },
    ]);
    // The page reads it as the collector sent it.
    expect(readSnapshot(snapshot)?.sessions[0]?.git?.pullRequest?.number).toBe(51);
    expect(await server.status()).toEqual({
      on: true,
      problem: null,
      gh: "ready",
      last: { at: T0, ok: true },
    });
    expect(server.warnings).toEqual([]);
  });

  test("the default branch is never asked about", async () => {
    const server = await pulling({ AGENT_LOOKOUT_PULL_REQUESTS: "on" }, await repositoryOn("main"));
    await server.poll();
    const snapshot = await server.poll();
    expect(snapshot.sessions[0]?.git).toEqual({ branch: "main", repository: expect.any(Object) });
    expect(server.gh.asked).toEqual([]);
    expect((await server.status()).gh).toBe("unknown");
  });

  test("with the setting left out, gh is never asked, and the answer says pull requests are off", async () => {
    const server = await pulling({}, await repositoryOn("checkout-flow"));
    await server.poll();
    const snapshot = await server.poll();
    expect(snapshot.sessions[0]?.git).not.toHaveProperty("pullRequest");
    expect(server.gh.asked).toEqual([]);
    expect(server.collector.pullRequests).toBeNull();
    expect(await server.status()).toEqual({ on: false, problem: null, gh: null, last: null });
    expect(server.warnings).toEqual([]);
  });

  test("a value that cannot be read leaves them off, with one line at start that names the setting", async () => {
    const server = await pulling(
      { AGENT_LOOKOUT_PULL_REQUESTS: "yes" },
      await repositoryOn("checkout-flow"),
    );
    await server.poll();
    await server.poll();
    expect(server.gh.asked).toEqual([]);
    expect(server.warnings).toEqual([
      "Pull requests are off: AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
    ]);
    expect(await server.status()).toEqual({
      on: false,
      problem: "AGENT_LOOKOUT_PULL_REQUESTS must be on or off.",
      gh: null,
      last: null,
    });
  });
});

// The stand-in ssh is a POSIX sh script, ended by POSIX signals, and the machine's
// waiting session is answered through a Unix socket, so this is for macOS and Linux.
describe.skipIf(process.platform === "win32")("another machine over SSH", () => {
  /**
   * The collector as every host builds it, with nothing of this machine to
   * read, and one other machine named: a stand-in Agent Lookout reached
   * through the stand-in ssh. Started, so its tunnel starts, and stopped when
   * the test finishes.
   */
  async function withMachine(lookoutPort: number, settings: Record<string, string> = {}) {
    const ssh = await makeStandInSsh();
    const warnings: string[] = [];
    const notifier = fakeSystemNotifier();
    const collector = createCollector({
      version: "0.2.3",
      env: {
        ...ssh.env,
        AGENT_LOOKOUT_HISTORY: "off",
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
        AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
        AGENT_LOOKOUT_CODEX_HOME: path.join(await tempDir(), "no-codex-here"),
        AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_NOTIFICATIONS: "on",
        // Answering is on, with its socket in a folder of the test's own.
        AGENT_LOOKOUT_ANSWER_SOCKET: path.join(await tempDir(), "al", "answer.sock"),
        AGENT_LOOKOUT_REMOTES: `devbox=dev@devbox.local:${lookoutPort}`,
        ...settings,
      },
      notifier,
      platform: "darwin",
      warn: (line) => warnings.push(line),
    });
    onTestFinished(async () => {
      collector.stop();
      await collector.remotes.stop();
    });
    collector.start();
    const port = await listen(createServer(collector.handler));
    /** Polls until the machine's card is in the state given, and returns what the page is sent. */
    const until = (state: string) =>
      vi.waitFor(
        async () => {
          await collector.poller.pollOnce();
          const snapshot = readSnapshot((await request(port, "/api/sessions")).json());
          const card = snapshot?.sources.find((source) => source.id === "remote:devbox");
          if (!snapshot || card?.state !== state) throw new Error(`still ${card?.state}`);
          return snapshot;
        },
        { timeout: 8_000, interval: 100 },
      );
    return { collector, ssh, warnings, notifier, port, until };
  }

  test("its sessions are listed with the machine's name, waiting ones among them, with no Jump, no Stop and nothing to answer", async () => {
    const lookout = await startStandInLookout(snapshotThere());
    const { until, warnings } = await withMachine(lookout.port);
    const snapshot = await until("ok");

    expect(warnings).toEqual([]);
    const card = snapshot.sources.find((source) => source.id === "remote:devbox");
    expect(card).toMatchObject({ label: "devbox", machine: "devbox", state: "ok" });
    expect(card?.agents?.map((agent) => agent.label)).toEqual(["Claude Code", "Status files"]);
    expect(
      snapshot.sessions.map((session) => [
        session.id,
        session.machine,
        session.agent,
        session.status,
      ]),
    ).toEqual([
      [
        "remote:devbox:claude-code:00000000-0000-4000-8000-0000000000aa",
        "devbox",
        "Claude Code",
        "needs-you",
      ],
      ["remote:devbox:status-files:night-shift.json", "devbox", "Night Shift", "working"],
    ]);
    // The waiting one was sent with a Jump, a Stop and a held request to answer,
    // which act on that machine only.
    for (const session of snapshot.sessions) {
      expect(session.jump).toBeUndefined();
      expect(session.stop).toBeUndefined();
      expect(session.ask).toBeUndefined();
      expect(session.git?.pullRequest).toBeUndefined();
      expect(session.links).toEqual({});
    }
    expect(snapshot.answering?.state).toBe("on");
    const cells = card?.agents?.map((agent) => [
      agent.capabilities.jump.level,
      agent.capabilities.stop.level,
      agent.capabilities.answer.level,
    ]);
    expect(cells).toEqual([
      ["no", "no", "no"],
      ["no", "no", "no"],
    ]);
    // The other machine sent what the waiting session is asking, so it is shown.
    expect(snapshot.sessions[0]?.waitingText).toBe("Run: npm test");
  });

  test("its sessions are stale by this computer's idle rule, whatever that machine said, and its time rules and quiet hours are not taken", async () => {
    const hour = 60 * 60_000;
    const now = Date.now();
    // That machine's rules: stale after an hour, and quiet all day, which it says it is.
    const lookout = await startStandInLookout({
      ...snapshotThere([
        workingThere({ id: "status-files:a.json", status: "idle", statusSince: now - 3 * hour }),
        workingThere({
          id: "status-files:b.json",
          status: "idle",
          statusSince: now - 30 * 60_000,
          stale: true,
        }),
      ]),
      timeRules: {
        ...DEFAULT_TIME_RULES,
        idle: { on: true, hours: 1 },
        quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "00:00", to: "23:59" },
      },
      quiet: true,
    });
    // This computer's: stale after two hours, and no quiet hours.
    const rules: TimeRules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 2 } };
    const file = path.join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ timeRules: rules }));
    const { until } = await withMachine(lookout.port, { AGENT_LOOKOUT_SETTINGS_FILE: file });
    const snapshot = await until("ok");

    expect(snapshot.sessions.map((session) => [session.id, session.stale])).toEqual([
      ["remote:devbox:status-files:b.json", false],
      ["remote:devbox:status-files:a.json", true],
    ]);
    expect(snapshot.timeRules).toEqual(rules);
    expect(snapshot.quiet).toBe(false);
  });

  test("a wait that begins there is an event here, and a notification that names the machine", async () => {
    const lookout = await startStandInLookout(snapshotThere([workingThere()]));
    const { until, port, notifier, collector } = await withMachine(lookout.port);
    await until("ok");

    lookout.answer(
      snapshotThere([workingThere({ status: "needs-you", waitingReason: "question" })]),
    );
    await vi.waitFor(
      async () => {
        await collector.poller.pollOnce();
        const events = readEvents((await request(port, "/api/events?since=0")).json()) ?? [];
        expect(events.map((event) => [event.sessionId, event.kind, event.to])).toEqual([
          ["remote:devbox:status-files:night-shift.json", "status-changed", "needs-you"],
        ]);
      },
      { timeout: 8_000, interval: 100 },
    );
    await vi.waitFor(() => expect(notifier.shown).toHaveLength(1), { timeout: 8_000 });
    expect(notifier.shown[0]).toEqual({
      title: "demo-docs on devbox",
      body: "Asked you a question",
    });
  });

  test("a prompt answered there is no wait here: no event, no notification, and the page reads it as answered", async () => {
    const claude = { id: "claude-code:00000000-0000-4000-8000-0000000000aa" };
    const working = waitingThere({
      ...claude,
      status: "working",
      waitingReason: undefined,
      waitingDetail: undefined,
      waitingText: undefined,
      ask: undefined,
    });
    const lookout = await startStandInLookout(snapshotThere([working]));
    const { until, port, notifier, collector } = await withMachine(lookout.port);
    await until("ok");

    // Agent Lookout there answered the prompt, by a press or a rule, and Claude
    // Code has not yet rewritten its file.
    lookout.answer(snapshotThere([waitingThere({ ...claude, answered: true, ask: undefined })]));
    const id = `remote:devbox:${claude.id}`;
    const seen = await vi.waitFor(
      async () => {
        await collector.poller.pollOnce();
        const snapshot = readSnapshot((await request(port, "/api/sessions")).json());
        const session = snapshot?.sessions.find((one) => one.id === id);
        if (session?.status !== "needs-you") throw new Error(`still ${session?.status}`);
        return session;
      },
      { timeout: 8_000, interval: 100 },
    );
    expect(seen).toMatchObject({ machine: "devbox", answered: true });
    await collector.poller.pollOnce();

    lookout.answer(snapshotThere([working]));
    await vi.waitFor(
      async () => {
        await collector.poller.pollOnce();
        const snapshot = readSnapshot((await request(port, "/api/sessions")).json());
        expect(snapshot?.sessions.find((one) => one.id === id)?.status).toBe("working");
      },
      { timeout: 8_000, interval: 100 },
    );
    const events = readEvents((await request(port, "/api/events?since=0")).json()) ?? [];
    expect(events).toEqual([]);
    expect(notifier.shown).toEqual([]);
  });

  test("when Agent Lookout there stops, the card says so, nothing of its sessions is said to have ended, and the history goes on", async () => {
    const lookout = await startStandInLookout(snapshotThere([waitingThere()]));
    const { until, port, collector } = await withMachine(lookout.port);
    await until("ok");

    await lookout.close();
    const snapshot = await until("unavailable");
    const card = snapshot.sources.find((source) => source.id === "remote:devbox");
    expect(card?.detail).toBe(
      `ssh is connected to devbox, but no Agent Lookout answers on its port ${lookout.port}.`,
    );
    expect(snapshot.sessions).toEqual([]);
    const events = readEvents((await request(port, "/api/events?since=0")).json()) ?? [];
    expect(events).toEqual([]);

    // After one gap, this computer's history goes on being kept without it.
    const points = async () =>
      readHistory((await request(port, "/api/history")).json())?.points.length ?? 0;
    await collector.poller.pollOnce();
    const before = await points();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await collector.poller.pollOnce();
    expect(await points()).toBeGreaterThan(before);
  });

  test("a setting that cannot be read is one line on the console and a card in Sources, and nothing is started", async () => {
    const lookout = await startStandInLookout(snapshotThere());
    const { collector, warnings, ssh } = await withMachine(lookout.port, {
      AGENT_LOOKOUT_REMOTES: "devbox=dev box",
    });
    expect(warnings).toEqual([
      "Other machines are not read: AGENT_LOOKOUT_REMOTES gives devbox a target that Agent Lookout does not hand to ssh. Give a host alias from your ssh config, a host name or user@host, with no spaces, no leading dash and no other punctuation.",
    ]);
    const snapshot = await collector.poller.pollOnce();
    expect(snapshot.sources.map((source) => source.id)).toEqual([
      "claude-code",
      "codex",
      "status-files",
      "remote:",
    ]);
    expect(snapshot.sources.at(-1)).toMatchObject({
      label: "Other machines",
      state: "not-set-up",
      detail:
        "AGENT_LOOKOUT_REMOTES gives devbox a target that Agent Lookout does not hand to ssh. Give a host alias from your ssh config, a host name or user@host, with no spaces, no leading dash and no other punctuation.",
    });
    expect(snapshot.sessions.filter((session) => session.source === "remote:")).toEqual([]);
    expect(await ssh.runs()).toEqual([]);
  });

  test("stopping the collector ends its ssh", async () => {
    const lookout = await startStandInLookout(snapshotThere());
    const { until, collector, ssh } = await withMachine(lookout.port);
    await until("ok");
    const [run] = await ssh.runs();
    collector.stop();
    await vi.waitFor(() => expect(isRunning(run?.pid as number)).toBe(false), { timeout: 4_000 });
  });
});
