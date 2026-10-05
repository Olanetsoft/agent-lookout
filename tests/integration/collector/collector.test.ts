import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { NEEDS_YOU_NOTE } from "@collector/adapters/codex/index";
import { createCollector } from "@collector/collector";
import { HANDOVER_GRACE_MS } from "@collector/notifications/heldWait";
import { NOTIFICATIONS_HEADER } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { fixtureSessions, NOW } from "@tests/fixtures/codex";
import { makeSession } from "@tests/fixtures/session";
import { listen, request } from "@tests/support/node/http";
import { fakeSystemNotifier } from "@tests/support/node/systemNotifier";
import { CODEX_FIXTURE_HOME, makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

/**
 * A collector built the way every host builds it, with its default adapters,
 * and settings that name nothing on this machine: an empty Claude Code folder,
 * which on its own keeps the claude command from being run, a Codex folder of
 * the test's choosing, and tmux turned off. Served over real HTTP on a free
 * loopback port.
 */
async function serve(codex: Record<string, string>) {
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_TMUX: "off",
      ...codex,
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
    ]);
    expect(snapshot.sources[1]).not.toHaveProperty("advice");
    expect(snapshot.sessions).toEqual([]);
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
    async page(atOffsetMs: number, said: "on" | "off", target = "/api/sessions") {
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
});
