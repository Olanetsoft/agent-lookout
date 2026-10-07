import { createServer } from "node:http";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { createCollector } from "@collector/collector";
import { createRemoteAdapter } from "@collector/remotes/remoteAdapter";
import { createSmtpSender } from "@collector/email/smtpSender";
import { createNtfySender } from "@collector/ntfy/ntfySender";
import { createPushoverSender } from "@collector/pushover/pushoverSender";
import type { WebhookPost } from "@collector/webhook/webhookMessage";
import { createHttpSender } from "@collector/webhook/webhookSender";
import type { Session } from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { makeSession } from "@tests/fixtures/session";
import { decodedHeader, headerValues, startSmtpServer, textOf } from "@tests/support/channels/smtp";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { startWebhookServer } from "@tests/support/channels/webhook";
import { listen, request } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

// Every channel that leaves the page, through the collector as every host
// builds it: the notifications it shows itself, email to a mail server of the
// test's own, posts to a webhook of its own, and pushes to an ntfy server and
// a Pushover API of its own, all on 127.0.0.1. The time rules are set as the
// Time rules card sets them, through the route, and the clock is the test's
// own.

/** Monday 5 October 2026 at 21:50, on this computer's clock. */
const EVENING = new Date(2026, 9, 5, 21, 50).getTime();
/** 08:00 the next morning, when the quiet hours end. */
const MORNING = new Date(2026, 9, 6, 8, 0).getTime();
const MINUTE = 60_000;

const RULES: TimeRules = {
  longWait: { on: true, minutes: 10 },
  idle: DEFAULT_TIME_RULES.idle,
  quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "22:00", to: "08:00" },
};

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const busy = (n: number, name: string) =>
  makeSession({ id: id(n), name, project: name, status: "working", statusSince: null });
const asking = (n: number, name: string, since: number) =>
  makeSession({
    id: id(n),
    name,
    project: name,
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: since,
  });
const finished = (n: number, name: string) =>
  makeSession({ id: id(n), name, project: name, status: "finished", statusSince: null });

/** What a push says, as one line to set beside an email's subject: a summary's title and its line. */
const pushLine = (body: { title: string; message: string }) =>
  body.title === "While quiet" ? `${body.title}: ${body.message}` : body.title;

/**
 * The collector over a source the test feeds, with email, the webhook, ntfy
 * and Pushover set up to send waits of a minute and finishes, notifications on
 * from the start, and its settings in a file of the test's own. `more` makes
 * further sources, on the collector's clock.
 */
async function lookout(more: (now: () => number) => Adapter[] = () => []) {
  const state = { sessions: [] as Session[], now: EVENING };
  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => ({
      health: { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: state.now },
      sessions: state.sessions,
    }),
  };
  const mail = await startSmtpServer();
  const hook = await startWebhookServer();
  const ntfy = await startWebhookServer();
  const pushover = await startWebhookServer();
  const notifier = fakeSystemNotifier();
  const collector = createCollector({
    version: "9.9.9-test",
    adapters: [adapter, ...more(() => state.now)],
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: path.join(await tempDir(), "settings.json"),
      AGENT_LOOKOUT_NOTIFICATIONS: "on",
      AGENT_LOOKOUT_EMAIL_TO: "notify@example.test",
      AGENT_LOOKOUT_SMTP_URL: mail.url(),
      AGENT_LOOKOUT_EMAIL_EVENTS: "needs-you,finished",
      AGENT_LOOKOUT_WEBHOOK_URL: hook.url(),
      AGENT_LOOKOUT_WEBHOOK_EVENTS: "needs-you,finished",
      AGENT_LOOKOUT_NTFY_URL: ntfy.url("/agent-lookout-topic"),
      AGENT_LOOKOUT_NTFY_EVENTS: "needs-you,finished",
      AGENT_LOOKOUT_PUSHOVER_TOKEN: "atest0000000000000000000000000",
      AGENT_LOOKOUT_PUSHOVER_USER: "utest0000000000000000000000000",
      AGENT_LOOKOUT_PUSHOVER_EVENTS: "needs-you,finished",
    },
    notifier,
    now: () => state.now,
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
  });
  const port = await listen(createServer(collector.handler));

  return {
    notifier,
    mail,
    hook,
    ntfy,
    pushover,
    /** Sets the rules as the Time rules card does. */
    async rules(rules: TimeRules) {
      const response = await request(port, "/api/settings/time-rules", {
        method: "POST",
        headers: {
          Origin: `http://localhost:${port}`,
          "Content-Type": "application/json",
          "X-Agent-Lookout-Action": "time-rules",
        },
        body: JSON.stringify(rules),
      });
      expect(response.status).toBe(200);
    },
    /** Moves the clock, replaces the sessions, polls once and waits for what that sent. */
    async poll(at: number, sessions: Session[]) {
      state.now = at;
      state.sessions = sessions;
      await collector.poller.pollOnce();
      await collector.email?.settled();
      await collector.webhook?.settled();
      await collector.ntfy?.settled();
      await collector.pushover?.settled();
    },
    subjects: () =>
      mail.received.map((email) => decodedHeader(headerValues(email.data, "Subject")[0] ?? "")),
    posts: () => hook.received.map((post) => JSON.parse(post.body) as WebhookPost),
    /** Each push, as one line to set beside the emails' subjects: ntfy's, then Pushover's. */
    pushes: () =>
      [ntfy, pushover].map((server) =>
        server.received.map((push) =>
          pushLine(JSON.parse(push.body) as { title: string; message: string }),
        ),
      ),
  };
}

describe("every channel follows the time rules", () => {
  test("in quiet hours nothing goes; when they end, one summary each way, and a wait still open as usual", async () => {
    const server = await lookout();
    await server.rules(RULES);
    await server.poll(EVENING, [
      busy(1, "checkout-flow"),
      busy(2, "billing-webhooks"),
      busy(3, "docs-site"),
    ]);

    // 22:10: checkout-flow and docs-site ask, and billing-webhooks finishes.
    const asked = EVENING + 20 * MINUTE;
    const night = (sessions: Session[], at: number) => server.poll(at, sessions);
    await night(
      [
        asking(1, "checkout-flow", asked),
        finished(2, "billing-webhooks"),
        asking(3, "docs-site", asked),
      ],
      asked,
    );
    await night(
      [
        asking(1, "checkout-flow", asked),
        finished(2, "billing-webhooks"),
        asking(3, "docs-site", asked),
      ],
      asked + 2 * MINUTE,
    );
    // Both last their reminder's ten minutes in the quiet hours.
    await night(
      [
        asking(1, "checkout-flow", asked),
        finished(2, "billing-webhooks"),
        asking(3, "docs-site", asked),
      ],
      asked + 12 * MINUTE,
    );
    // 22:35: checkout-flow is answered.
    await night(
      [busy(1, "checkout-flow"), finished(2, "billing-webhooks"), asking(3, "docs-site", asked)],
      asked + 25 * MINUTE,
    );
    expect(server.notifier.shown).toEqual([]);
    expect(server.mail.received).toEqual([]);
    expect(server.hook.received).toEqual([]);
    expect(server.pushes()).toEqual([[], []]);

    await server.poll(MORNING, [
      busy(1, "checkout-flow"),
      finished(2, "billing-webhooks"),
      asking(3, "docs-site", asked),
    ]);
    // The collector holds its own for a page for a few seconds, and then shows them.
    await server.poll(MORNING + 4_000, [
      busy(1, "checkout-flow"),
      finished(2, "billing-webhooks"),
      asking(3, "docs-site", asked),
    ]);

    expect(server.subjects()).toEqual([
      "While quiet: checkout-flow waited 25 minutes and billing-webhooks finished",
      "docs-site is waiting for permission",
    ]);
    // Each push says what each email does, and what the summary holds in its lines.
    expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
    expect(textOf(server.mail.received[0]?.data ?? "")).toContain(
      // The night before, so the day is said too.
      "checkout-flow waited 25 minutes, from 22:10 on ",
    );
    expect(server.posts().map((post) => [post.event, post.text])).toEqual([
      [
        "quiet-summary",
        "While quiet: checkout-flow waited 25 minutes and billing-webhooks finished",
      ],
      ["needs-you", expect.stringMatching(/^docs-site is waiting for permission \(9h 50m/)],
    ]);
    // Notifications are on for a wait alone, so theirs leaves the finish out.
    expect(server.notifier.shown).toEqual([
      { title: "While quiet", body: "checkout-flow waited 25 minutes" },
      { title: "docs-site", body: "Waiting for permission" },
    ]);

    // docs-site was told of only once it had waited past its ten minutes, so no reminder follows.
    await server.poll(MORNING + 10 * MINUTE, [
      busy(1, "checkout-flow"),
      finished(2, "billing-webhooks"),
      asking(3, "docs-site", asked),
    ]);
    expect(server.mail.received).toHaveLength(2);
    expect(server.hook.received).toHaveLength(2);
    expect(server.pushes().map((pushes) => pushes.length)).toEqual([2, 2]);
    expect(server.notifier.shown).toHaveLength(2);
  });

  test("out of quiet hours, a long wait is reminded of once each way, worded as a reminder", async () => {
    const server = await lookout();
    await server.rules(RULES);
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await server.poll(noon, [busy(1, "checkout-flow")]);
    await server.poll(noon + 2_000, [asking(1, "checkout-flow", noon + 2_000)]);
    await server.poll(noon + 6_000, [asking(1, "checkout-flow", noon + 2_000)]);
    await server.poll(noon + 2_000 + MINUTE, [asking(1, "checkout-flow", noon + 2_000)]);
    await server.poll(noon + 2_000 + 10 * MINUTE, [asking(1, "checkout-flow", noon + 2_000)]);
    await server.poll(noon + 6_000 + 10 * MINUTE, [asking(1, "checkout-flow", noon + 2_000)]);
    await server.poll(noon + 30 * MINUTE, [asking(1, "checkout-flow", noon + 2_000)]);

    expect(server.subjects()).toEqual([
      "checkout-flow is waiting for permission",
      "checkout-flow has waited 10 minutes for permission",
    ]);
    expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
    expect(server.posts().map((post) => [post.text.split(" (")[0], "reminder" in post])).toEqual([
      ["checkout-flow is waiting for permission", false],
      ["checkout-flow has waited 10 minutes for permission", true],
    ]);
    expect(server.notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission" },
      { title: "checkout-flow", body: "Has waited 10 minutes for permission" },
    ]);
  });

  test("a wait on another machine is reminded of and held by this computer's rules, whatever that machine's say", async () => {
    // What devbox's Agent Lookout answers, with rules of its own: no reminder,
    // and quiet all day, which at noon it says it is and at night it says it is not.
    const there = { sessions: [] as Session[], quiet: true };
    const theirRules: TimeRules = {
      longWait: { on: false, minutes: 10 },
      idle: DEFAULT_TIME_RULES.idle,
      quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "00:00", to: "23:59" },
    };
    const server = await lookout((now) => [
      createRemoteAdapter({
        remote: { name: "devbox", target: "dev@devbox.local", port: 4777 },
        version: "9.9.9-test",
        tunnel: {
          state: () => ({ kind: "running", run: 1, port: 53211, since: 0, command: ["ssh"] }),
          connected: () => {},
        },
        read: async () => ({
          kind: "read",
          version: "9.9.9-test",
          snapshot: {
            generatedAt: now(),
            sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: now() }],
            sessions: there.sessions,
            timeRules: { ...theirRules, quietHours: { ...theirRules.quietHours, on: there.quiet } },
            quiet: there.quiet,
          },
        }),
        now,
      }),
    ]);
    await server.rules(RULES);
    const poll = (at: number, sessions: Session[]) => {
      there.sessions = sessions;
      return server.poll(at, []);
    };

    // At noon, out of this computer's quiet hours: told at once, and reminded after ten minutes.
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    await poll(noon, [busy(1, "docs-site")]);
    await poll(noon + 2_000, [asking(1, "docs-site", noon + 2_000)]);
    await poll(noon + 2_000 + MINUTE, [asking(1, "docs-site", noon + 2_000)]);
    await poll(noon + 2_000 + 10 * MINUTE, [asking(1, "docs-site", noon + 2_000)]);
    await poll(noon + 20 * MINUTE, [busy(1, "docs-site")]);
    expect(server.notifier.shown).toEqual([
      { title: "docs-site on devbox", body: "Waiting for permission" },
      { title: "docs-site on devbox", body: "Has waited 10 minutes for permission" },
    ]);
    expect(server.subjects()).toEqual([
      "docs-site is waiting for permission",
      "docs-site has waited 10 minutes for permission",
    ]);

    // At night, in this computer's quiet hours, though devbox says it is not in its own:
    // held, and summed up as answered when they end.
    there.quiet = false;
    const asked = EVENING + 20 * MINUTE;
    await poll(asked, [asking(1, "docs-site", asked)]);
    await poll(asked + 12 * MINUTE, [asking(1, "docs-site", asked)]);
    await poll(asked + 25 * MINUTE, [busy(1, "docs-site")]);
    expect(server.notifier.shown).toHaveLength(2);
    expect(server.mail.received).toHaveLength(2);
    await poll(MORNING, [busy(1, "docs-site")]);
    expect(server.notifier.shown.slice(2)).toEqual([
      { title: "While quiet", body: "docs-site on devbox waited 25 minutes" },
    ]);
    expect(server.subjects().slice(2)).toEqual(["While quiet: docs-site waited 25 minutes"]);
  });

  test("with every rule off, nothing is held and no reminder goes", async () => {
    const server = await lookout();
    await server.poll(EVENING, [busy(1, "checkout-flow")]);
    const asked = EVENING + 20 * MINUTE;
    await server.poll(asked, [asking(1, "checkout-flow", asked)]);
    await server.poll(asked + 4_000, [asking(1, "checkout-flow", asked)]);
    await server.poll(asked + MINUTE, [asking(1, "checkout-flow", asked)]);
    await server.poll(asked + 30 * MINUTE, [asking(1, "checkout-flow", asked)]);
    expect(server.subjects()).toEqual(["checkout-flow is waiting for permission"]);
    expect(server.hook.received).toHaveLength(1);
    expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
    expect(server.notifier.shown).toHaveLength(1);
  });

  describe("with the reminder's repeat on", () => {
    const REPEATING: TimeRules = {
      ...RULES,
      longWait: { on: true, minutes: 10, repeat: { on: true, minutes: 30 } },
    };
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    const reminders = (posts: WebhookPost[]) =>
      posts
        .filter((post) => "reminder" in post)
        .map((post) => [post.text.split(" (")[0], "repeat" in post ? post.repeat : undefined]);

    test("a long wait is reminded of again each way at each interval, one after a sleep, and none once it is answered", async () => {
      const server = await lookout();
      await server.rules(REPEATING);
      const begun = noon + 2_000;
      const poll = (minutes: number, sessions = [asking(1, "checkout-flow", begun)]) =>
        server.poll(begun + minutes * MINUTE, sessions);
      await server.poll(noon, [busy(1, "checkout-flow")]);
      for (const minutes of [0, 1, 10, 11, 40, 70]) await poll(minutes);
      // The computer sleeps from 1 hour 10 minutes to 3 hours 28 minutes.
      await poll(208);
      await poll(209);
      // 3 hours 40 minutes is a moment, but too soon after the one that went at 3 hours 28.
      await poll(220);
      // Answered at 3 hours 45 minutes.
      await poll(225, [busy(1, "checkout-flow")]);
      await poll(250, [busy(1, "checkout-flow")]);

      expect(server.subjects()).toEqual([
        "checkout-flow is waiting for permission",
        "checkout-flow has waited 10 minutes for permission",
        "checkout-flow has waited 40 minutes for permission",
        "checkout-flow has waited 1 hour 10 minutes for permission",
        "checkout-flow has waited 3 hours 28 minutes for permission",
      ]);
      expect(textOf(server.mail.received[2]?.data ?? "")).toContain(
        "Agent Lookout reminds you once a wait lasts 10 minutes, and again every 30 minutes while it goes on",
      );
      expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
      expect(reminders(server.posts())).toEqual([
        ["checkout-flow has waited 10 minutes for permission", undefined],
        ["checkout-flow has waited 40 minutes for permission", 1],
        ["checkout-flow has waited 1 hour 10 minutes for permission", 2],
        ["checkout-flow has waited 3 hours 28 minutes for permission", 6],
      ]);
      expect(server.notifier.shown.map((shown) => shown.body)).toEqual([
        "Waiting for permission",
        "Has waited 10 minutes for permission",
        "Has waited 40 minutes for permission",
        "Has waited 1 hour 10 minutes for permission",
        "Has waited 3 hours 28 minutes for permission",
      ]);
    });

    test("in quiet hours they are held: a wait answered in them is one item of each summary, and one still open has one reminder each way when they end", async () => {
      const server = await lookout();
      await server.rules(REPEATING);
      // Both ask at 21:30, before quiet hours, and are sent, and reminded of at 21:40.
      const begun = EVENING - 20 * MINUTE;
      const both = [asking(1, "checkout-flow", begun), asking(2, "docs-site", begun)];
      await server.poll(begun - MINUTE, [busy(1, "checkout-flow"), busy(2, "docs-site")]);
      for (const minutes of [0, 1, 10]) await server.poll(begun + minutes * MINUTE, both);
      expect(server.mail.received).toHaveLength(4);
      // Their repeats come due at 22:10 and 22:40, in quiet hours.
      for (const minutes of [40, 70]) await server.poll(begun + minutes * MINUTE, both);
      // checkout-flow is answered at 23:00.
      const after = [busy(1, "checkout-flow"), asking(2, "docs-site", begun)];
      await server.poll(begun + 90 * MINUTE, after);
      await server.poll(begun + 300 * MINUTE, after);
      expect(server.mail.received).toHaveLength(4);
      expect(server.hook.received).toHaveLength(4);
      expect(server.pushes().map((pushes) => pushes.length)).toEqual([4, 4]);
      expect(server.notifier.shown).toHaveLength(4);

      await server.poll(MORNING, after);
      await server.poll(MORNING + 4_000, after);
      expect(server.subjects().slice(4)).toEqual([
        "While quiet: checkout-flow waited 1 hour 30 minutes",
        "docs-site has waited 10 hours 30 minutes for permission",
      ]);
      expect(server.pushes()).toEqual([server.subjects(), server.subjects()]);
      expect(
        server
          .posts()
          .slice(4)
          .map((post) => [post.event, post.text.split(" (")[0]]),
      ).toEqual([
        ["quiet-summary", "While quiet: checkout-flow waited 1 hour 30 minutes"],
        ["needs-you", "docs-site has waited 10 hours 30 minutes for permission"],
      ]);
      expect(server.notifier.shown.slice(4)).toEqual([
        { title: "While quiet", body: "checkout-flow waited 1 hour 30 minutes" },
        { title: "docs-site", body: "Has waited 10 hours 30 minutes for permission" },
      ]);
      // The next comes at 08:40, by the wait's own moments.
      await server.poll(MORNING + 39 * MINUTE, after);
      expect(server.mail.received).toHaveLength(6);
      await server.poll(MORNING + 40 * MINUTE, after);
      expect(server.subjects().slice(6)).toEqual([
        "docs-site has waited 11 hours 10 minutes for permission",
      ]);
    });

    test("started again under a long wait, Agent Lookout sends nothing at once, and one reminder each way at the next moment", async () => {
      const server = await lookout();
      await server.rules(REPEATING);
      const begun = noon - 2 * 60 * MINUTE;
      await server.poll(noon, [asking(1, "checkout-flow", begun)]);
      await server.poll(noon + 4_000, [asking(1, "checkout-flow", begun)]);
      await server.poll(noon + 9 * MINUTE, [asking(1, "checkout-flow", begun)]);
      expect(server.mail.received).toEqual([]);
      expect(server.hook.received).toEqual([]);
      expect(server.notifier.shown).toEqual([]);

      await server.poll(noon + 10 * MINUTE, [asking(1, "checkout-flow", begun)]);
      expect(server.subjects()).toEqual([
        "checkout-flow has waited 2 hours 10 minutes for permission",
      ]);
      expect(reminders(server.posts())).toEqual([
        ["checkout-flow has waited 2 hours 10 minutes for permission", 4],
      ]);
      expect(server.notifier.shown).toEqual([
        { title: "checkout-flow", body: "Has waited 2 hours 10 minutes for permission" },
      ]);
    });
  });
});
