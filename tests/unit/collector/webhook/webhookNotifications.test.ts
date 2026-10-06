import { describe, expect, test } from "vitest";

import type { SendOutcome } from "@collector/outbound/outboundChannel";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import type { WebhookPost } from "@collector/webhook/webhookMessage";
import {
  createWebhookNotifications,
  webhookOffStatus,
} from "@collector/webhook/webhookNotifications";
import type { WebhookSettings } from "@collector/webhook/webhookSettings";
import { SENDS_PER_HOUR } from "@core/api";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const SECOND = 1_000;

const SETTINGS: WebhookSettings = {
  url: new URL("https://hooks.example.com/services/T0000/B0000/s3cret-webhook-token"),
  events: ["needs-you"],
  afterMs: 60 * SECOND,
  asking: false,
};

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const working = (n: number, name = `session-${n}`): Session =>
  makeSession({ id: id(n), name, status: "working", statusSince: null });
const waiting = (n: number, name = `session-${n}`): Session =>
  makeSession({
    id: id(n),
    name,
    project: name,
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: null,
  });

function snapshot(sessions: Session[]): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
    sessions,
  };
}

/** A sender that posts nothing. It writes down each post and answers as the test says. */
function fakeSender() {
  const sender = {
    posted: [] as WebhookPost[],
    answer: { sent: true } as SendOutcome | (() => Promise<SendOutcome>),
    send(post: WebhookPost): Promise<SendOutcome> {
      sender.posted.push(post);
      const { answer } = sender;
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  };
  return sender;
}

function setUp(settings: Partial<WebhookSettings> = {}, sender = fakeSender()) {
  const clock = { now: T0 };
  const webhook = createWebhookNotifications({
    settings: { ...SETTINGS, ...settings },
    sender,
    now: () => clock.now,
  });
  return {
    webhook,
    sender,
    async poll(atMs: number, sessions: Session[]) {
      clock.now = T0 + atMs;
      webhook.handle(snapshot(sessions));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("createWebhookNotifications", () => {
  test("posts a wait that lasts the delay, once, and nothing for one answered before it", async () => {
    const { webhook, sender, poll } = setUp();
    await poll(0, [working(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(2 * SECOND, [waiting(1, "checkout-flow"), waiting(2, "docs-site")]);
    await poll(40 * SECOND, [waiting(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(62 * SECOND, [waiting(1, "checkout-flow"), working(2, "docs-site")]);
    await poll(HOUR_MS, [waiting(1, "checkout-flow"), working(2, "docs-site")]);

    expect(sender.posted).toEqual([
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
        at: new Date(T0 + 2 * SECOND).toISOString(),
        waitedSeconds: 60,
      },
    ]);
    await webhook.settled();
    expect(webhook.status().last).toEqual({ at: T0 + 62 * SECOND, sent: true });
  });

  test("posts a chosen finish at once, and nothing for an event not chosen", async () => {
    const { sender, poll } = setUp({ events: ["finished"] });
    await poll(0, [working(1, "billing-webhooks"), working(2)]);
    await poll(2 * SECOND, [
      makeSession({ id: id(1), name: "billing-webhooks", status: "finished" }),
      waiting(2),
    ]);
    await poll(HOUR_MS, []);
    expect(sender.posted.map((post) => [post.event, post.text])).toEqual([
      ["finished", "billing-webhooks finished (demo, Terminal, Claude Code)"],
    ]);
  });

  test(`posts at most ${SENDS_PER_HOUR} an hour, and says when the next can go`, async () => {
    const { webhook, sender, poll } = setUp({ afterMs: 0 });
    const many = (make: (n: number) => Session) =>
      Array.from({ length: SENDS_PER_HOUR + 5 }, (_, index) => make(index + 1));
    await poll(0, many(working));
    await poll(2 * SECOND, many(waiting));
    expect(sender.posted).toHaveLength(SENDS_PER_HOUR);
    expect(webhook.status().limitedUntil).toBe(T0 + 2 * SECOND + HOUR_MS);
  });

  test("a sender that rejects is a failure the status gives, and never reaches the poll", async () => {
    const sender = fakeSender();
    sender.answer = () => Promise.reject(new Error("https://hooks.example.com/services/s3cret"));
    const { webhook, poll } = setUp({ afterMs: 0 }, sender);
    await poll(0, [working(1)]);
    await expect(poll(2 * SECOND, [waiting(1)])).resolves.toBeUndefined();
    await webhook.settled();
    expect(webhook.status().last).toEqual({
      at: T0 + 2 * SECOND,
      sent: false,
      reason: "the post could not be sent",
    });
  });

  test("leaves out what a waiting session is asking unless its setting is on, and then says it for a wait alone", async () => {
    const askingWait = (n: number, name: string): Session => ({
      ...waiting(n, name),
      waitingText: "Run: npm test",
    });
    const off = setUp();
    await off.poll(0, [working(1, "checkout-flow")]);
    await off.poll(2 * SECOND, [askingWait(1, "checkout-flow")]);
    await off.poll(62 * SECOND, [askingWait(1, "checkout-flow")]);
    expect(off.sender.posted).toHaveLength(1);
    expect(JSON.stringify(off.sender.posted)).not.toMatch(/asking|npm test/);
    expect(off.webhook.status().asking).toBe(false);

    const on = setUp({ asking: true, events: ["needs-you", "ended"] });
    await on.poll(0, [working(1, "checkout-flow")]);
    await on.poll(2 * SECOND, [askingWait(1, "checkout-flow")]);
    await on.poll(62 * SECOND, [askingWait(1, "checkout-flow")]);
    await on.poll(64 * SECOND, []);
    expect(on.sender.posted.map((post) => [post.text, post.asking])).toEqual([
      [
        "checkout-flow is waiting for permission: Run: npm test (1m 00s, checkout-flow, VS Code, Claude Code)",
        "Run: npm test",
      ],
      ["checkout-flow ended (checkout-flow, VS Code, Claude Code)", undefined],
    ]);
    expect(on.webhook.status().asking).toBe(true);
    expect(JSON.stringify(on.webhook.status())).not.toContain("npm test");
  });

  test("the status gives the host and never the rest of the address", () => {
    const { webhook } = setUp({ events: ["needs-you", "ended"] });
    expect(webhook.status()).toEqual({
      on: true,
      host: "hooks.example.com",
      events: ["needs-you", "ended"],
      afterMs: 60_000,
      asking: false,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    const said = JSON.stringify(webhook.status());
    for (const secret of ["s3cret", "T0000", "services", "https://"]) {
      expect(said).not.toContain(secret);
    }
  });

  test("while the webhook is off the status says so, with the problem when there is one", () => {
    expect(webhookOffStatus(null)).toEqual({
      on: false,
      host: null,
      events: null,
      afterMs: null,
      asking: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    expect(webhookOffStatus("AGENT_LOOKOUT_WEBHOOK_AFTER must be ...").problem).toBe(
      "AGENT_LOOKOUT_WEBHOOK_AFTER must be ...",
    );
  });
});
