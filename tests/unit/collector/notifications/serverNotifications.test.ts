import { describe, expect, test } from "vitest";

import { HANDOVER_GRACE_MS, PAGE_GONE_AFTER_MS } from "@collector/notifications/heldWait";
import {
  createServerNotifications,
  notificationsOnAtStart,
} from "@collector/notifications/serverNotifications";
import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";
import { fakeSystemNotifier } from "@tests/support/node/systemNotifier";

const T0 = 1_700_000_000_000;

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function working(n: number, name: string): Session {
  return makeSession({ id: id(n), name, status: "working" });
}

function waiting(n: number, name: string, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: id(n),
    name,
    status: "needs-you",
    waitingReason: "permission",
    ...overrides,
  });
}

function snapshot(sessions: Session[], state: SourceState = "ok"): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state, checkedAt: T0 }],
    sessions,
  };
}

/** The collector's notifications over a fake notifier, with a clock the test moves. */
function setUp(onAtStart: boolean) {
  const notifier = fakeSystemNotifier();
  const clock = { now: T0 };
  const notifications = createServerNotifications({ notifier, onAtStart, now: () => clock.now });
  return {
    notifier,
    notifications,
    /** Moves the clock to this long after the start and hands over a snapshot. */
    poll(atOffsetMs: number, sessions: Session[], state: SourceState = "ok") {
      clock.now = T0 + atOffsetMs;
      notifications.handle(snapshot(sessions, state));
    },
    /** A page's request arrives this long after the start. */
    page(atOffsetMs: number, said: "on" | "off", fetchedSessions = true) {
      clock.now = T0 + atOffsetMs;
      notifications.pageSaid(said, fetchedSessions);
    },
  };
}

describe("which waits are announced", () => {
  test("a wait that begins with no page open is shown at once, by its name and its reason", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "checkout-flow")]);
    expect(notifier.shown).toEqual([]);

    poll(2_000, [waiting(1, "checkout-flow", { waitingReason: "question" })]);
    // The same answer again, with the wait still open.
    poll(4_000, [waiting(1, "checkout-flow", { waitingReason: "question" })]);
    poll(6_000, [waiting(1, "checkout-flow", { waitingReason: "question" })]);

    expect(notifier.shown).toEqual([{ title: "checkout-flow", body: "Asked you a question" }]);
  });

  test("a session already waiting when the collector started is never announced", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [waiting(1, "api-rate-limits")]);
    poll(2_000, [waiting(1, "api-rate-limits")]);
    poll(60_000, [waiting(1, "api-rate-limits")]);

    expect(notifier.shown).toEqual([]);
  });

  test("each wait that begins is announced once, and a session that waits again is announced again", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "billing-webhooks"), working(2, "search-indexing")]);
    poll(2_000, [waiting(1, "billing-webhooks"), working(2, "search-indexing")]);
    poll(4_000, [working(1, "billing-webhooks"), waiting(2, "search-indexing")]);
    poll(6_000, [waiting(1, "billing-webhooks"), waiting(2, "search-indexing")]);

    expect(notifier.shown.map((notice) => notice.title)).toEqual([
      "billing-webhooks",
      "search-indexing",
      "billing-webhooks",
    ]);
  });

  test("a source that stops answering for a poll does not announce its waits again", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "docs-site")]);
    poll(2_000, [waiting(1, "docs-site")]);
    poll(4_000, [], "error");
    poll(6_000, [waiting(1, "docs-site")]);

    expect(notifier.shown).toHaveLength(1);
  });

  test("a notifier that throws does not stop the next notification", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "mobile-onboarding"), working(2, "infra-terraform")]);

    notifier.throwsNext = true;
    expect(() => poll(2_000, [waiting(1, "mobile-onboarding")])).not.toThrow();
    poll(4_000, [waiting(1, "mobile-onboarding"), waiting(2, "infra-terraform")]);

    expect(notifier.shown).toEqual([{ title: "infra-terraform", body: "Waiting for permission" }]);
  });
});

describe("the one switch", () => {
  test("before any page has said anything they are off, unless the environment turned them on", () => {
    const off = setUp(false);
    off.poll(0, [working(1, "email-templates")]);
    off.poll(2_000, [waiting(1, "email-templates")]);
    off.poll(10_000, [waiting(1, "email-templates")]);
    expect(off.notifier.shown).toEqual([]);

    expect(notificationsOnAtStart({})).toBe(false);
    expect(notificationsOnAtStart({ AGENT_LOOKOUT_NOTIFICATIONS: "on" })).toBe(true);
    expect(notificationsOnAtStart({ AGENT_LOOKOUT_NOTIFICATIONS: " ON " })).toBe(true);
    expect(notificationsOnAtStart({ AGENT_LOOKOUT_NOTIFICATIONS: "off" })).toBe(false);
    expect(notificationsOnAtStart({ AGENT_LOOKOUT_NOTIFICATIONS: "1" })).toBe(false);
    expect(notificationsOnAtStart({ AGENT_LOOKOUT_NOTIFICATIONS: "" })).toBe(false);
  });

  test("a page that said on and then closed leaves them on", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "checkout-flow")]);
    page(1_000, "on");

    // The page is closed. A minute later a session starts waiting.
    poll(60_000, [working(1, "checkout-flow")]);
    poll(62_000, [waiting(1, "checkout-flow")]);

    expect(notifier.shown).toEqual([{ title: "checkout-flow", body: "Waiting for permission" }]);
  });

  test("a page that says off turns them off, and wins over the environment", () => {
    const { notifier, poll, page } = setUp(true);
    poll(0, [working(1, "api-rate-limits")]);
    page(1_000, "off");
    poll(60_000, [waiting(1, "api-rate-limits")]);
    poll(70_000, [waiting(1, "api-rate-limits")]);

    expect(notifier.shown).toEqual([]);
  });

  test("turning them on says nothing of a wait that had already begun", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "billing-webhooks")]);
    poll(2_000, [waiting(1, "billing-webhooks")]);
    page(3_000, "on", false);
    poll(60_000, [waiting(1, "billing-webhooks")]);

    expect(notifier.shown).toEqual([]);
  });
});

describe("never twice", () => {
  test("with a page that said on still asking, a wait is held, and dropped when the page fetches the sessions", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "search-indexing")]);
    page(1_000, "on");

    poll(2_000, [waiting(1, "search-indexing")]);
    expect(notifier.shown).toEqual([]);
    // The page's next turn: it now has the wait, and shows it itself.
    page(3_000, "on");
    poll(4_000, [waiting(1, "search-indexing")]);
    poll(6_000, [waiting(1, "search-indexing")]);
    poll(60_000, [waiting(1, "search-indexing")]);

    expect(notifier.shown).toEqual([]);
  });

  test("a wait the page never comes for is shown when the grace period is over", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "docs-site")]);
    page(1_900, "on");

    poll(2_000, [waiting(1, "docs-site")]);
    // The page asks for something else, and not for the sessions.
    page(3_000, "on", false);
    poll(4_000, [waiting(1, "docs-site")]);
    expect(notifier.shown).toEqual([]);

    page(5_000, "on", false);
    poll(2_000 + HANDOVER_GRACE_MS + 1_000, [waiting(1, "docs-site")]);
    expect(notifier.shown).toEqual([{ title: "docs-site", body: "Waiting for permission" }]);

    // Shown once: later polls add nothing.
    poll(8_000, [waiting(1, "docs-site")]);
    expect(notifier.shown).toHaveLength(1);
  });

  test("the limit: a page four seconds between two fetches of the sessions still takes the wait, and one later than that is not waited for", () => {
    const inTime = setUp(false);
    inTime.poll(0, [working(1, "search-indexing")]);
    // Its last fetch was just before the wait was seen.
    inTime.page(1_999, "on");
    inTime.poll(2_000, [waiting(1, "search-indexing")]);
    inTime.poll(4_000, [waiting(1, "search-indexing")]);
    inTime.page(5_999, "on");
    inTime.poll(6_000, [waiting(1, "search-indexing")]);
    inTime.poll(8_000, [waiting(1, "search-indexing")]);
    expect(inTime.notifier.shown).toEqual([]);

    const late = setUp(false);
    late.poll(0, [working(1, "search-indexing")]);
    late.page(1_999, "on");
    late.poll(2_000, [waiting(1, "search-indexing")]);
    late.poll(4_000, [waiting(1, "search-indexing")]);
    expect(late.notifier.shown).toEqual([]);
    late.poll(6_000, [waiting(1, "search-indexing")]);
    expect(late.notifier.shown).toHaveLength(1);
    // The page fetches at last, and shows the wait as well. Nothing is added here.
    late.page(6_001, "on");
    late.poll(8_000, [waiting(1, "search-indexing")]);
    expect(late.notifier.shown).toHaveLength(1);
  });

  test("a page that went quiet a few seconds before is not waited for", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "mobile-onboarding")]);
    page(1_000, "on");

    poll(1_000 + PAGE_GONE_AFTER_MS + 1, [waiting(1, "mobile-onboarding")]);

    expect(notifier.shown).toHaveLength(1);
  });

  test("a wait that ends while it is held is never shown", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "infra-terraform")]);
    page(1_900, "on");

    poll(2_000, [waiting(1, "infra-terraform")]);
    page(3_000, "on", false);
    // Answered inside the grace period.
    poll(4_000, [working(1, "infra-terraform")]);
    poll(6_000, [working(1, "infra-terraform")]);
    poll(60_000, [working(1, "infra-terraform")]);

    expect(notifier.shown).toEqual([]);
  });

  test("a session answered and waiting again inside one poll has its first wait forgotten and its second held anew", () => {
    const { notifier, poll, page } = setUp(false);
    const first = waiting(1, "email-templates", { statusSince: T0 + 1_500 });
    const second = waiting(1, "email-templates", { statusSince: T0 + 3_500 });
    poll(0, [working(1, "email-templates")]);
    page(1_900, "on");

    poll(2_000, [first]);
    page(3_900, "on", false);
    poll(4_000, [second]);
    // The first wait would have been due here. The second is not yet.
    page(5_400, "on", false);
    poll(5_500, [second]);
    expect(notifier.shown).toEqual([]);

    page(6_900, "on", false);
    poll(7_000, [second]);
    expect(notifier.shown).toHaveLength(1);
  });

  test("a page that says off while a wait is held drops it", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "checkout-flow")]);
    page(1_900, "on");

    poll(2_000, [waiting(1, "checkout-flow")]);
    page(3_000, "off");
    poll(4_000, [waiting(1, "checkout-flow")]);
    // On again later: the wait had already begun, so nothing is said of it.
    page(5_000, "on", false);
    poll(60_000, [waiting(1, "checkout-flow")]);

    expect(notifier.shown).toEqual([]);
  });
});
