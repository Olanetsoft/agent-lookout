import { describe, expect, test } from "vitest";

import type { EmailContent } from "@collector/email/emailMessage";
import { createEmailNotifications, emailOffStatus } from "@collector/email/emailNotifications";
import type { EmailSettings } from "@collector/email/emailSettings";
import type { EmailSender } from "@collector/email/smtpSender";
import type { SendOutcome } from "@collector/outbound/outboundChannel";
import { HOUR_MS } from "@collector/outbound/outboundTiming";
import { EMAILS_PER_HOUR } from "@core/api";
import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const SECOND = 1_000;

const SETTINGS: EmailSettings = {
  to: "notify@example.com",
  from: "notify@example.com",
  events: ["needs-you"],
  afterMs: 60 * SECOND,
  server: {
    host: "smtp.example.com",
    port: 465,
    security: "tls",
    auth: { user: "name@example.com", pass: "s3cret-app-password" },
  },
};

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function working(n: number, name = `session-${n}`): Session {
  return makeSession({ id: id(n), name, status: "working", statusSince: null });
}

/** A session waiting for permission, with no status time unless one is given. */
function waiting(n: number, name = `session-${n}`, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: id(n),
    name,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: null,
    ...overrides,
  });
}

function snapshot(sessions: Session[], state: SourceState = "ok"): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state, checkedAt: T0 }],
    sessions: state === "ok" ? sessions : [],
  };
}

/** A sender that sends nothing. It writes down each email and answers as the test says. */
function fakeSender() {
  const sender = {
    sent: [] as EmailContent[],
    /** What the next sends answer. A function runs instead, as a broken sender might. */
    answer: { sent: true } as SendOutcome | (() => Promise<SendOutcome>),
    send(content: EmailContent): Promise<SendOutcome> {
      sender.sent.push(content);
      const { answer } = sender;
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  };
  return sender;
}

function setUp(settings: Partial<EmailSettings> = {}, sender: EmailSender = fakeSender()) {
  const clock = { now: T0 };
  const email = createEmailNotifications({
    settings: { ...SETTINGS, ...settings },
    sender,
    now: () => clock.now,
  });
  return {
    email,
    /**
     * Moves the clock to this long after the start, hands over a snapshot, and
     * lets the emails it handed on reach the sender, which happens after the poll.
     */
    async poll(atMs: number, sessions: Session[], state: SourceState = "ok") {
      clock.now = T0 + atMs;
      email.handle(snapshot(sessions, state));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

const subjects = (sender: ReturnType<typeof fakeSender>) => sender.sent.map((sent) => sent.subject);

describe("which waits are emailed", () => {
  test("a session already waiting when the collector starts sends nothing, however long it waits", async () => {
    const sender = fakeSender();
    const { poll } = setUp({}, sender);
    await poll(0, [waiting(1, "checkout-flow")]);
    await poll(2 * SECOND, [waiting(1, "checkout-flow")]);
    await poll(HOUR_MS, [waiting(1, "checkout-flow")]);
    expect(sender.sent).toEqual([]);
  });

  test("a wait answered before the delay sends nothing", async () => {
    const sender = fakeSender();
    const { poll } = setUp({}, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1)]);
    await poll(58 * SECOND, [waiting(1)]);
    await poll(60 * SECOND, [working(1)]);
    await poll(HOUR_MS, [working(1)]);
    expect(sender.sent).toEqual([]);
  });

  test("a wait that lasts the delay is emailed once, while it is still open", async () => {
    const sender = fakeSender();
    const { email, poll } = setUp({}, sender);
    await poll(0, [working(1, "api-rate-limits")]);
    await poll(2 * SECOND, [waiting(1, "api-rate-limits")]);
    await poll(60 * SECOND, [waiting(1, "api-rate-limits")]);
    expect(sender.sent).toEqual([]);

    await poll(62 * SECOND, [waiting(1, "api-rate-limits")]);
    expect(subjects(sender)).toEqual(["api-rate-limits is waiting for permission"]);
    expect(sender.sent[0]?.text).toContain("It has waited 1 minute, since ");
    expect(sender.sent[0]?.text).toContain("Agent: Claude Code");

    await poll(64 * SECOND, [waiting(1, "api-rate-limits")]);
    await poll(HOUR_MS, [waiting(1, "api-rate-limits")]);
    expect(sender.sent).toHaveLength(1);
    await email.settled();
    expect(email.status().last).toEqual({ at: T0 + 62 * SECOND, sent: true });
  });

  test("a session from a status file is named by its own agent, not the source's label", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 0 }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1, "docs-site", { agent: "Night Shift" })]);
    expect(sender.sent[0]?.text).toContain("Agent: Night Shift");
    expect(sender.sent[0]?.text).not.toContain("Agent: Claude Code");
  });

  test("with no delay, a wait is emailed on the poll that sees it", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 0 }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1, "billing-webhooks", { waitingReason: "question" })]);
    expect(subjects(sender)).toEqual(["billing-webhooks asked you a question"]);
  });

  test("the delay counts from when the source says the wait began", async () => {
    const sender = fakeSender();
    const { poll } = setUp({}, sender);
    await poll(0, [working(1)]);
    // Seen at 30 seconds, and the source says it began at 2.
    await poll(30 * SECOND, [waiting(1, "search-indexing", { statusSince: T0 + 2 * SECOND })]);
    await poll(60 * SECOND, [waiting(1, "search-indexing", { statusSince: T0 + 2 * SECOND })]);
    expect(subjects(sender)).toEqual([]);
    await poll(62 * SECOND, [waiting(1, "search-indexing", { statusSince: T0 + 2 * SECOND })]);
    expect(subjects(sender)).toEqual(["search-indexing is waiting for permission"]);
  });

  test("a session answered and waiting again is emailed again, once more", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 10 * SECOND }, sender);
    await poll(0, [working(1, "docs-site")]);
    await poll(2 * SECOND, [waiting(1, "docs-site")]);
    await poll(12 * SECOND, [waiting(1, "docs-site")]);
    await poll(14 * SECOND, [working(1, "docs-site")]);
    await poll(16 * SECOND, [waiting(1, "docs-site")]);
    await poll(26 * SECOND, [waiting(1, "docs-site")]);
    await poll(40 * SECOND, [waiting(1, "docs-site")]);
    expect(sender.sent).toHaveLength(2);
  });

  test("a wait whose source stops answering is held, and emailed when the source says it is still open", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 10 * SECOND }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1, "mobile-onboarding")]);
    await poll(20 * SECOND, [], "error");
    await poll(40 * SECOND, [], "error");
    expect(sender.sent).toEqual([]);
    await poll(42 * SECOND, [waiting(1, "mobile-onboarding")]);
    expect(subjects(sender)).toEqual(["mobile-onboarding is waiting for permission"]);
  });

  test("a wait that ended while its source was not answering is not emailed", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 10 * SECOND }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1)]);
    await poll(20 * SECOND, [], "error");
    await poll(40 * SECOND, [working(1)]);
    await poll(HOUR_MS, [working(1)]);
    expect(sender.sent).toEqual([]);
  });

  describe("a session that misses one poll and comes back with the same status time is the same wait", () => {
    const since = { statusSince: T0 + 10 * SECOND };

    test("one already emailed is not emailed again", async () => {
      const unknown = makeSession({ id: id(1), name: "checkout-flow", status: "unknown" });
      for (const gap of [[], [working(1, "checkout-flow")], [unknown]]) {
        const sender = fakeSender();
        const { poll } = setUp({}, sender);
        await poll(0, [working(1, "checkout-flow")]);
        await poll(10 * SECOND, [waiting(1, "checkout-flow", since)]);
        await poll(72 * SECOND, [waiting(1, "checkout-flow", since)]);
        expect(sender.sent).toHaveLength(1);
        await poll(74 * SECOND, gap);
        await poll(76 * SECOND, [waiting(1, "checkout-flow", since)]);
        await poll(HOUR_MS, [waiting(1, "checkout-flow", since)]);
        expect(sender.sent).toHaveLength(1);
      }
    });

    test("one open when the collector started is not emailed", async () => {
      const sender = fakeSender();
      const { poll } = setUp({}, sender);
      const before = { statusSince: T0 - 600 * SECOND };
      await poll(0, [waiting(1, "checkout-flow", before)]);
      await poll(2 * SECOND, []);
      await poll(4 * SECOND, [waiting(1, "checkout-flow", before)]);
      await poll(HOUR_MS, [waiting(1, "checkout-flow", before)]);
      expect(sender.sent).toEqual([]);
    });

    test("one not yet emailed keeps the time it began, and is emailed once when due", async () => {
      const sender = fakeSender();
      const { poll } = setUp({}, sender);
      await poll(0, [working(1, "checkout-flow")]);
      await poll(10 * SECOND, [waiting(1, "checkout-flow", since)]);
      await poll(30 * SECOND, []);
      await poll(32 * SECOND, [waiting(1, "checkout-flow", since)]);
      await poll(68 * SECOND, [waiting(1, "checkout-flow", since)]);
      expect(sender.sent).toEqual([]);
      await poll(70 * SECOND, [waiting(1, "checkout-flow", since)]);
      await poll(HOUR_MS, [waiting(1, "checkout-flow", since)]);
      expect(subjects(sender)).toEqual(["checkout-flow is waiting for permission"]);
    });

    test("a later status time is a new wait, and is emailed", async () => {
      const sender = fakeSender();
      const { poll } = setUp({}, sender);
      await poll(0, [working(1, "checkout-flow")]);
      await poll(10 * SECOND, [waiting(1, "checkout-flow", since)]);
      await poll(72 * SECOND, [waiting(1, "checkout-flow", since)]);
      await poll(74 * SECOND, []);
      const later = { statusSince: T0 + 76 * SECOND };
      await poll(76 * SECOND, [waiting(1, "checkout-flow", later)]);
      await poll(140 * SECOND, [waiting(1, "checkout-flow", later)]);
      expect(sender.sent).toHaveLength(2);
    });
  });

  test("the email is made from the session as it is when the email goes", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 10 * SECOND }, sender);
    await poll(0, [working(1, "infra-terraform")]);
    await poll(2 * SECOND, [waiting(1, "infra-terraform")]);
    await poll(12 * SECOND, [waiting(1, "infra-terraform-renamed")]);
    expect(subjects(sender)).toEqual(["infra-terraform-renamed is waiting for permission"]);
  });
});

describe(`at most ${EMAILS_PER_HOUR} an hour`, () => {
  const many = (count: number, make: (n: number) => Session) =>
    Array.from({ length: count }, (_, index) => make(index + 1));

  test("past the limit nothing more goes until the hour has passed, the status says when, and a wait still open then is emailed", async () => {
    const sender = fakeSender();
    const { email, poll } = setUp({ afterMs: 0 }, sender);
    await poll(
      0,
      many(25, (n) => working(n)),
    );
    await poll(
      2 * SECOND,
      many(25, (n) => waiting(n)),
    );

    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);
    expect(email.status().limitedUntil).toBe(T0 + 2 * SECOND + HOUR_MS);

    await poll(
      30 * 60 * SECOND,
      many(25, (n) => waiting(n)),
    );
    await poll(
      HOUR_MS,
      many(25, (n) => waiting(n)),
    );
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);

    // The hour has passed. The five still waiting go now, and are said to have waited an hour.
    await poll(
      HOUR_MS + 2 * SECOND,
      many(25, (n) => waiting(n)),
    );
    expect(sender.sent).toHaveLength(25);
    expect(sender.sent[24]?.text).toContain("It has waited 1 hour, since ");
    expect(email.status().limitedUntil).toBeNull();
    await poll(
      HOUR_MS + 4 * SECOND,
      many(25, (n) => waiting(n)),
    );
    expect(sender.sent).toHaveLength(25);
    await email.settled();
  });

  test("a held wait answered before the hour has passed is never emailed", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ afterMs: 0 }, sender);
    await poll(
      0,
      many(21, (n) => working(n)),
    );
    await poll(
      2 * SECOND,
      many(21, (n) => waiting(n)),
    );
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);

    await poll(
      60 * SECOND,
      many(21, (n) => working(n)),
    );
    await poll(
      2 * HOUR_MS,
      many(21, (n) => working(n)),
    );
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);
  });

  test("emails that could not be sent count toward the limit too", async () => {
    const sender = fakeSender();
    sender.answer = { sent: false, reason: "the mail server did not answer in time" };
    const { email, poll } = setUp({ afterMs: 0 }, sender);
    await poll(
      0,
      many(30, (n) => working(n)),
    );
    await poll(
      2 * SECOND,
      many(30, (n) => waiting(n)),
    );
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);
    await email.settled();
    expect(email.status().limitedUntil).not.toBeNull();
  });
});

describe("a failure", () => {
  test("is shown in the status with its reason, and that wait is not tried again", async () => {
    const sender = fakeSender();
    sender.answer = { sent: false, reason: "the mail server refused the email" };
    const { email, poll } = setUp({ afterMs: 0 }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [waiting(1)]);
    await email.settled();
    expect(email.status().last).toEqual({
      at: T0 + 2 * SECOND,
      sent: false,
      reason: "the mail server refused the email",
    });

    await poll(4 * SECOND, [waiting(1)]);
    await poll(HOUR_MS, [waiting(1)]);
    expect(sender.sent).toHaveLength(1);
  });

  test("from a sender that throws, rejects or never answers, never reaches the poll", async () => {
    for (const answer of [
      () => {
        throw new Error("thrown");
      },
      () => Promise.reject(new Error("rejected")),
    ]) {
      const sender = fakeSender();
      sender.answer = answer as () => Promise<SendOutcome>;
      const { email, poll } = setUp({ afterMs: 0 }, sender);
      await poll(0, [working(1)]);
      await expect(poll(2 * SECOND, [waiting(1)])).resolves.toBeUndefined();
      await email.settled();
      expect(email.status().last).toEqual({
        at: T0 + 2 * SECOND,
        sent: false,
        reason: "the email could not be sent",
      });
    }

    const stuck = fakeSender();
    stuck.answer = () => new Promise<SendOutcome>(() => {});
    const { email, poll } = setUp({ afterMs: 0 }, stuck);
    await poll(0, [working(1), working(2)]);
    await poll(2 * SECOND, [waiting(1), working(2)]);
    await poll(4 * SECOND, [waiting(1), waiting(2)]);
    // The first is still being sent, so the second waits its turn, and the polls go on.
    expect(stuck.sent).toHaveLength(1);
    expect(email.status().last).toBeNull();
  });

  test("emails go one at a time, in the order they fell due", async () => {
    const sender = fakeSender();
    const order: string[] = [];
    let release = () => {};
    sender.answer = () =>
      new Promise<SendOutcome>((resolve) => {
        order.push(`start ${sender.sent.length}`);
        release = () => {
          order.push(`end ${sender.sent.length}`);
          resolve({ sent: true });
        };
      });
    const { email, poll } = setUp({ afterMs: 0 }, sender);
    await poll(0, [working(1), working(2)]);
    await poll(2 * SECOND, [waiting(1, "first"), waiting(2, "second")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start 1"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await email.settled();
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(subjects(sender)).toEqual([
      "first is waiting for permission",
      "second is waiting for permission",
    ]);
  });
});

describe("the status", () => {
  test("says email is on, with the address masked and the delay, and nothing of the server", async () => {
    const { email } = setUp();
    const status = email.status();
    expect(status).toEqual({
      on: true,
      to: "n…@example.com",
      events: ["needs-you"],
      afterMs: 60_000,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    const said = JSON.stringify(status);
    for (const secret of [
      "notify@",
      "s3cret-app-password",
      "name@example.com",
      "smtp.example.com",
    ]) {
      expect(said).not.toContain(secret);
    }
  });

  test("while email is off it says so, with the problem when there is one", async () => {
    expect(emailOffStatus(null)).toEqual({
      on: false,
      to: null,
      events: null,
      afterMs: null,
      problem: null,
      last: null,
      limitedUntil: null,
    });
    expect(emailOffStatus("AGENT_LOOKOUT_SMTP_URL is not set.").problem).toBe(
      "AGENT_LOOKOUT_SMTP_URL is not set.",
    );
  });
});

describe("finished, failed and ended", () => {
  function over(n: number, status: "finished" | "failed", name = `session-${n}`): Session {
    return makeSession({ id: id(n), name, status, statusSince: null });
  }

  test("a wait alone is emailed unless the setting names others", async () => {
    const sender = fakeSender();
    const { poll } = setUp({}, sender);
    await poll(0, [working(1), working(2)]);
    await poll(2 * SECOND, [over(1, "finished")]);
    await poll(HOUR_MS, []);
    expect(sender.sent).toEqual([]);
  });

  test("each event chosen is emailed at once, without the delay a wait has, with its own subject", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ events: ["finished", "failed", "ended"] }, sender);
    await poll(0, [
      working(1, "billing-webhooks"),
      working(2, "search-indexing"),
      working(3, "docs-site"),
    ]);
    await poll(2 * SECOND, [over(1, "finished", "billing-webhooks"), working(3, "docs-site")]);
    expect(subjects(sender)).toEqual(["billing-webhooks finished", "search-indexing ended"]);

    await poll(4 * SECOND, [
      over(1, "finished", "billing-webhooks"),
      over(3, "failed", "docs-site"),
    ]);
    expect(subjects(sender)).toEqual([
      "billing-webhooks finished",
      "search-indexing ended",
      "docs-site failed",
    ]);
    expect(sender.sent[0]?.text).toContain("Agent Lookout saw this at ");
    expect(sender.sent[0]?.text).toContain("Agent: Claude Code");
  });

  test("an event not chosen is not emailed, and a wait is not when needs-you is left out", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ events: ["failed"], afterMs: 0 }, sender);
    await poll(0, [working(1), working(2), working(3)]);
    await poll(2 * SECOND, [over(1, "finished"), waiting(2), over(3, "failed")]);
    await poll(HOUR_MS, []);
    expect(subjects(sender)).toEqual(["session-3 failed"]);
  });

  test("nothing is emailed for what was already over when the collector started, nor for it leaving", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ events: ["finished", "failed", "ended"] }, sender);
    await poll(0, [over(1, "finished"), over(2, "failed")]);
    await poll(2 * SECOND, []);
    expect(sender.sent).toEqual([]);
  });

  test("a source that stops answering ends nothing", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ events: ["ended"] }, sender);
    await poll(0, [working(1)]);
    await poll(2 * SECOND, [], "error");
    expect(sender.sent).toEqual([]);
    // It answers again without the session: that is an end.
    await poll(4 * SECOND, []);
    expect(subjects(sender)).toEqual(["session-1 ended"]);
  });

  test("a wait and a finish are emailed together under one hourly limit, and a finish it held goes once the hour lets it", async () => {
    const sender = fakeSender();
    const { email, poll } = setUp({ events: ["needs-you", "finished"], afterMs: 0 }, sender);
    const many = (count: number, make: (n: number) => Session) =>
      Array.from({ length: count }, (_, index) => make(index + 1));
    await poll(
      0,
      many(25, (n) => working(n)),
    );
    await poll(2 * SECOND, [
      ...many(18, (n) => waiting(n)),
      ...many(25, (n) => working(n)).slice(18),
    ]);
    expect(sender.sent).toHaveLength(18);

    // Five finish: two can go, and three are held by the limit.
    await poll(4 * SECOND, [
      ...many(18, (n) => waiting(n)),
      ...many(23, (n) => over(n, "finished")).slice(18),
      ...many(25, (n) => working(n)).slice(23),
    ]);
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);
    expect(subjects(sender).slice(18)).toEqual(["session-19 finished", "session-20 finished"]);
    expect(email.status().limitedUntil).toBe(T0 + 2 * SECOND + HOUR_MS);

    // The hour has passed. The three held go, in the order they finished.
    await poll(
      HOUR_MS + 4 * SECOND,
      many(18, (n) => waiting(n)),
    );
    expect(subjects(sender).slice(20, 23)).toEqual([
      "session-21 finished",
      "session-22 finished",
      "session-23 finished",
    ]);
    expect(sender.sent[20]?.text).toMatch(/Agent Lookout saw this at \d\d:\d\d\./);
    await email.settled();
  });

  test("when the hourly limit lets one go, a finish held back goes before a wait held longer", async () => {
    const sender = fakeSender();
    const { poll } = setUp({ events: ["needs-you", "finished"], afterMs: 0 }, sender);
    const sessions = (waits: number, last: Session) => [
      ...Array.from({ length: waits }, (_, index) => waiting(index + 1)),
      ...Array.from({ length: 21 - waits }, (_, index) => working(waits + index + 1)),
      last,
    ];
    await poll(0, sessions(0, working(22)));
    // One goes first, and nineteen a moment later: the hour is full.
    await poll(2 * SECOND, sessions(1, working(22)));
    await poll(4 * SECOND, sessions(20, working(22)));
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);

    await poll(10 * 60 * SECOND, sessions(21, working(22)));
    await poll(20 * 60 * SECOND, sessions(21, over(22, "finished")));
    expect(sender.sent).toHaveLength(EMAILS_PER_HOUR);

    // The first email of the hour is an hour old, so one more can go.
    await poll(HOUR_MS + 2 * SECOND, sessions(21, over(22, "finished")));
    expect(subjects(sender).slice(EMAILS_PER_HOUR)).toEqual(["session-22 finished"]);
    await poll(HOUR_MS + 4 * SECOND, sessions(21, over(22, "finished")));
    expect(subjects(sender).slice(EMAILS_PER_HOUR)).toEqual([
      "session-22 finished",
      "session-21 is waiting for permission",
    ]);
  });

  test("the status names the events that are emailed", () => {
    const { email } = setUp({ events: ["needs-you", "ended"] });
    expect(email.status().events).toEqual(["needs-you", "ended"]);
  });
});
