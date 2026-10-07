import { describe, expect, test } from "vitest";

import { HANDOVER_GRACE_MS, PAGE_GONE_AFTER_MS } from "@collector/notifications/heldWait";
import {
  createServerNotifications,
  notificationsAtStartLine,
  notificationsOnAtStart,
  NOTIFICATIONS_NOT_SHOWN_LINE,
} from "@collector/notifications/serverNotifications";
import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import type { NoticeEvent } from "@core/notices/sessionChanges";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import { makeSession } from "@tests/fixtures/session";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";

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
    /** A page's request arrives this long after the start, saying on, off, or the events it chose. */
    page(atOffsetMs: number, said: "on" | "off" | NoticeEvent[], fetchedSessions = true) {
      clock.now = T0 + atOffsetMs;
      const events: NoticeEvent[] = said === "on" ? ["needs-you"] : said === "off" ? [] : said;
      notifications.pageSaid(events, fetchedSessions);
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

  test("what the session is asking follows the reason, as the page's notification says it", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "checkout-flow")]);
    poll(2_000, [waiting(1, "checkout-flow", { waitingText: "Edit: src/app.ts" })]);
    expect(notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission: Edit: src/app.ts" },
    ]);
  });

  test("a wait held for a page is shown with what the session is asking by the time it is shown", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "docs-site")]);
    page(1_900, "on");

    // The transcript said nothing yet when the wait was seen, and has by the next poll.
    poll(2_000, [waiting(1, "docs-site")]);
    page(3_000, "on", false);
    poll(4_000, [waiting(1, "docs-site", { waitingText: "Run: npm test" })]);
    page(5_000, "on", false);
    poll(2_000 + HANDOVER_GRACE_MS + 1_000, [
      waiting(1, "docs-site", { waitingText: "Run: npm test" }),
    ]);
    expect(notifier.shown).toEqual([
      { title: "docs-site", body: "Waiting for permission: Run: npm test" },
    ]);
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

  test("the environment turning them on where nothing can show one is said once, in a line", () => {
    const on = { AGENT_LOOKOUT_NOTIFICATIONS: "on" };
    expect(notificationsAtStartLine(on, false)).toBe(NOTIFICATIONS_NOT_SHOWN_LINE);
    expect(NOTIFICATIONS_NOT_SHOWN_LINE).toBe(
      "AGENT_LOOKOUT_NOTIFICATIONS is on, but Agent Lookout shows notifications itself on macOS only, so it shows none here. A dashboard tab with notifications on still shows them.",
    );
    expect(notificationsAtStartLine(on, true)).toBeNull();
    expect(notificationsAtStartLine({}, false)).toBeNull();
    expect(notificationsAtStartLine({ AGENT_LOOKOUT_NOTIFICATIONS: "off" }, false)).toBeNull();
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

  test("a wait held for a page and then answered from Agent Lookout is dropped at the poll that marks it, before its session reads as moved on", () => {
    const { notifier, poll, page } = setUp(false);
    poll(0, [working(1, "infra-terraform")]);
    page(1_900, "on");
    poll(2_000, [waiting(1, "infra-terraform")]);
    page(3_000, "on", false);
    poll(4_000, [waiting(1, "infra-terraform", { answered: true })]);
    poll(60_000, [waiting(1, "infra-terraform", { answered: true })]);
    poll(62_000, [working(1, "infra-terraform")]);
    expect(notifier.shown).toEqual([]);
  });

  test("a wait already answered when a poll first reads it is never shown", () => {
    const { notifier, poll } = setUp(true);
    poll(0, [working(1, "infra-terraform")]);
    poll(2_000, [waiting(1, "infra-terraform", { answered: true })]);
    poll(4_000, [working(1, "infra-terraform")]);
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

describe("finished, failed and ended", () => {
  function over(n: number, name: string, status: "finished" | "failed"): Session {
    return makeSession({ id: id(n), name, status });
  }

  /** As `setUp`, with `choose` for a page that names the events it chose. */
  function choosing(onAtStart = false) {
    const set = setUp(onAtStart);
    return { ...set, choose: set.page };
  }

  test("with no page open, each event chosen is shown at once, by the session's name and what happened", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [
      working(1, "billing-webhooks"),
      working(2, "search-indexing"),
      working(3, "docs-site"),
    ]);
    // A page chose the events, then closed.
    choose(1_000, ["finished", "failed", "ended"]);

    poll(60_000, [over(1, "billing-webhooks", "finished"), over(2, "search-indexing", "failed")]);

    expect(notifier.shown).toEqual([
      { title: "billing-webhooks", body: "Finished" },
      { title: "search-indexing", body: "Failed" },
      { title: "docs-site", body: "Ended" },
    ]);
  });

  test("an event the page did not choose is not shown, and on alone is a wait alone", () => {
    const { notifier, poll, page, choose } = choosing();
    poll(0, [working(1, "checkout-flow"), working(2, "api-rate-limits")]);
    page(1_000, "on");
    poll(60_000, [over(1, "checkout-flow", "finished")]);
    expect(notifier.shown).toEqual([]);

    choose(61_000, ["ended"]);
    poll(120_000, [over(1, "checkout-flow", "finished"), waiting(3, "email-templates")]);
    expect(notifier.shown).toEqual([]);
  });

  test("the environment turns on a wait alone", () => {
    const { notifier, poll } = choosing(true);
    poll(0, [working(1, "infra-terraform")]);
    poll(2_000, [over(1, "infra-terraform", "failed")]);
    poll(10_000, []);
    expect(notifier.shown).toEqual([]);
  });

  test("never twice: with a page that chose it still asking, a finish is held, and dropped when the page fetches the sessions", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [working(1, "mobile-onboarding")]);
    choose(1_000, ["needs-you", "finished"]);

    poll(2_000, [over(1, "mobile-onboarding", "finished")]);
    expect(notifier.shown).toEqual([]);
    // The page's next turn: it has the finish, and shows it itself.
    choose(3_000, ["needs-you", "finished"]);
    poll(4_000, [over(1, "mobile-onboarding", "finished")]);
    poll(60_000, [over(1, "mobile-onboarding", "finished")]);

    expect(notifier.shown).toEqual([]);
  });

  test("an end the page never comes for is shown when the grace period is over", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [working(1, "docs-site")]);
    choose(1_900, ["ended"]);

    poll(2_000, []);
    choose(3_000, ["ended"], false);
    poll(4_000, []);
    expect(notifier.shown).toEqual([]);

    choose(5_000, ["ended"], false);
    poll(2_000 + HANDOVER_GRACE_MS + 1_000, []);
    expect(notifier.shown).toEqual([{ title: "docs-site", body: "Ended" }]);
    poll(10_000, []);
    expect(notifier.shown).toHaveLength(1);
  });

  test("a finish held when the page switches that event off is dropped", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [working(1, "billing-webhooks")]);
    choose(1_900, ["finished"]);

    poll(2_000, [over(1, "billing-webhooks", "finished")]);
    choose(3_000, ["needs-you"], false);
    poll(4_000, [over(1, "billing-webhooks", "finished")]);
    poll(60_000, [over(1, "billing-webhooks", "finished")]);

    expect(notifier.shown).toEqual([]);
  });

  test("a wait held when its session finishes is dropped, and the finish is held in its place", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [working(1, "search-indexing")]);
    choose(1_900, ["needs-you", "finished"]);

    poll(2_000, [waiting(1, "search-indexing")]);
    choose(3_000, ["needs-you", "finished"], false);
    poll(4_000, [over(1, "search-indexing", "finished")]);
    choose(5_000, ["needs-you", "finished"], false);
    poll(6_000, [over(1, "search-indexing", "finished")]);
    choose(7_000, ["needs-you", "finished"], false);
    poll(8_000, [over(1, "search-indexing", "finished")]);

    expect(notifier.shown).toEqual([{ title: "search-indexing", body: "Finished" }]);
  });

  test("nothing is said of what was already over when the collector started, nor of it leaving", () => {
    const { notifier, poll, choose } = choosing();
    choose(0, ["finished", "failed", "ended"]);
    poll(0, [over(1, "checkout-flow", "finished"), over(2, "api-rate-limits", "failed")]);
    poll(60_000, []);
    expect(notifier.shown).toEqual([]);
  });

  test("a source that stops answering ends nothing", () => {
    const { notifier, poll, choose } = choosing();
    poll(0, [working(1, "email-templates")]);
    choose(1_000, ["ended"]);
    poll(60_000, [], "error");
    poll(62_000, [], "unavailable");
    expect(notifier.shown).toEqual([]);
  });
});

describe("the time rules", () => {
  /** Monday 5 October 2026 at 21:58, on the local clock. */
  const EVENING = new Date(2026, 9, 5, 21, 58).getTime();
  /** The next morning at 08:00, when quiet hours end. */
  const MORNING = new Date(2026, 9, 6, 8, 0).getTime();
  const MINUTE = 60_000;

  const QUIET: TimeRules = {
    ...DEFAULT_TIME_RULES,
    longWait: { on: true, minutes: 10 },
    quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "22:00", to: "08:00" },
  };

  /** The collector's notifications, with the rules in every snapshot and a clock the test sets. */
  function ruled(rules: TimeRules, onAtStart = true) {
    const notifier = fakeSystemNotifier();
    const clock = { now: EVENING };
    const notifications = createServerNotifications({ notifier, onAtStart, now: () => clock.now });
    return {
      notifier,
      poll(at: number, sessions: Session[]) {
        clock.now = at;
        notifications.handle({
          generatedAt: at,
          sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: at }],
          sessions,
          timeRules: rules,
        });
      },
      page(at: number, said: NoticeEvent[], fetchedSessions = true) {
        clock.now = at;
        notifications.pageSaid(said, fetchedSessions);
      },
    };
  }

  const since = (n: number, at: number, name: string, text?: string) =>
    waiting(n, name, { statusSince: at, ...(text !== undefined && { waitingText: text }) });

  test("with no page open, nothing is shown in quiet hours, and when they end, the summary and each wait still open are", () => {
    const { notifier, poll } = ruled(QUIET);
    poll(EVENING, [working(1, "checkout-flow"), working(2, "docs-site")]);
    poll(EVENING + 10 * MINUTE, [
      since(1, EVENING + 10 * MINUTE, "checkout-flow"),
      working(2, "docs-site"),
    ]);
    poll(EVENING + 20 * MINUTE, [
      working(1, "checkout-flow"),
      since(2, EVENING + 20 * MINUTE, "docs-site"),
    ]);
    poll(EVENING + 60 * MINUTE, [
      working(1, "checkout-flow"),
      since(2, EVENING + 20 * MINUTE, "docs-site"),
    ]);
    expect(notifier.shown).toEqual([]);

    poll(MORNING, [
      working(1, "checkout-flow"),
      since(2, EVENING + 20 * MINUTE, "docs-site", "Run: npm test"),
    ]);
    poll(MORNING + 2_000, [
      working(1, "checkout-flow"),
      since(2, EVENING + 20 * MINUTE, "docs-site", "Run: npm test"),
    ]);
    expect(notifier.shown).toEqual([
      { title: "While quiet", body: "checkout-flow waited 10 minutes" },
      { title: "docs-site", body: "Waiting for permission: Run: npm test" },
    ]);
  });

  test("a page that is open shows the summary and the waits itself, and the collector drops its own", () => {
    const { notifier, poll, page } = ruled(QUIET, false);
    page(EVENING, ["needs-you"]);
    poll(EVENING, [working(1, "checkout-flow")]);
    page(EVENING + MINUTE, ["needs-you"]);
    poll(EVENING + 3 * MINUTE, [since(1, EVENING + 3 * MINUTE, "checkout-flow")]);
    page(EVENING + 4 * MINUTE, ["needs-you"]);
    poll(EVENING + 5 * MINUTE, [working(1, "checkout-flow")]);
    page(MORNING - 1_000, ["needs-you"]);
    poll(MORNING, [working(1, "checkout-flow")]);
    page(MORNING + 1_000, ["needs-you"]);
    poll(MORNING + 2_000, [working(1, "checkout-flow")]);
    poll(MORNING + 10_000, [working(1, "checkout-flow")]);
    expect(notifier.shown).toEqual([]);
  });

  test("a wait that lasts the long wait reminder's minutes is reminded of once, unless it ends while the reminder is held", () => {
    const rules: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 10 } };
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    const { notifier, poll } = ruled(rules);
    poll(noon, [working(1, "checkout-flow"), working(2, "docs-site")]);
    poll(noon + 2_000, [
      since(1, noon + 2_000, "checkout-flow"),
      since(2, noon + 2_000, "docs-site"),
    ]);
    poll(noon + 4_000, [
      since(1, noon + 2_000, "checkout-flow"),
      since(2, noon + 2_000, "docs-site"),
    ]);
    poll(noon + 10 * MINUTE + 2_000, [
      since(1, noon + 2_000, "checkout-flow"),
      since(2, noon + 2_000, "docs-site"),
    ]);
    poll(noon + 10 * MINUTE + 4_000, [
      since(1, noon + 2_000, "checkout-flow"),
      since(2, noon + 2_000, "docs-site"),
    ]);
    poll(noon + 30 * MINUTE, [
      since(1, noon + 2_000, "checkout-flow"),
      since(2, noon + 2_000, "docs-site"),
    ]);
    expect(notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission" },
      { title: "docs-site", body: "Waiting for permission" },
      { title: "checkout-flow", body: "Has waited 10 minutes for permission" },
      { title: "docs-site", body: "Has waited 10 minutes for permission" },
    ]);
  });

  test("a reminder held for a page that has gone quiet is dropped when the wait ends first", () => {
    const rules: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 10 } };
    const noon = new Date(2026, 9, 5, 12, 0).getTime();
    const { notifier, poll, page } = ruled(rules, false);
    page(noon, ["needs-you"]);
    poll(noon, [since(1, noon - MINUTE, "checkout-flow")]);
    page(noon + 9 * MINUTE, ["needs-you"], false);
    poll(noon + 9 * MINUTE + 2_000, [since(1, noon - MINUTE, "checkout-flow")]);
    page(noon + 9 * MINUTE + 3_000, ["needs-you"], false);
    poll(noon + 9 * MINUTE + 4_000, [working(1, "checkout-flow")]);
    poll(noon + 20 * MINUTE, [working(1, "checkout-flow")]);
    expect(notifier.shown).toEqual([]);
  });

  test("a reminder held for a page when quiet hours begin is held through them, and its wait is shown when they end", () => {
    const { notifier, poll, page } = ruled(QUIET);
    const begun = EVENING - 10 * MINUTE + 1_000;
    poll(EVENING - 11 * MINUTE, [working(1, "checkout-flow")]);
    // With no page open, the wait is shown at once.
    poll(begun, [since(1, begun, "checkout-flow")]);
    // Ten minutes on, a page that has not fetched the sessions is still asking, so the reminder is held for it.
    page(EVENING, ["needs-you"], false);
    poll(EVENING + 1_000, [since(1, begun, "checkout-flow")]);
    expect(notifier.shown).toEqual([{ title: "checkout-flow", body: "Waiting for permission" }]);
    // The page never comes, and quiet hours have begun when the reminder would go.
    poll(new Date(2026, 9, 5, 22, 0).getTime(), [since(1, begun, "checkout-flow")]);
    poll(new Date(2026, 9, 6, 3, 0).getTime(), [since(1, begun, "checkout-flow")]);
    expect(notifier.shown).toHaveLength(1);

    poll(MORNING, [since(1, begun, "checkout-flow")]);
    poll(MORNING + 2_000, [since(1, begun, "checkout-flow")]);
    expect(notifier.shown).toEqual([
      { title: "checkout-flow", body: "Waiting for permission" },
      { title: "checkout-flow", body: "Waiting for permission" },
    ]);
  });

  test("a wait held in quiet hours whose session reads as another status for a poll is shown once when they end, and in no summary", () => {
    const { notifier, poll } = ruled(QUIET);
    const begun = EVENING + 10 * MINUTE;
    poll(EVENING, [working(1, "checkout-flow")]);
    poll(begun, [since(1, begun, "checkout-flow")]);
    poll(begun + 2_000, [working(1, "checkout-flow")]);
    poll(begun + 4_000, [since(1, begun, "checkout-flow")]);
    poll(MORNING, [since(1, begun, "checkout-flow")]);
    poll(MORNING + 2_000, [since(1, begun, "checkout-flow")]);
    expect(notifier.shown).toEqual([{ title: "checkout-flow", body: "Waiting for permission" }]);
  });

  test("with notifications off, nothing is held and there is no summary", () => {
    const { notifier, poll } = ruled(QUIET, false);
    poll(EVENING, [working(1, "checkout-flow")]);
    poll(EVENING + 10 * MINUTE, [since(1, EVENING + 10 * MINUTE, "checkout-flow")]);
    poll(EVENING + 20 * MINUTE, [working(1, "checkout-flow")]);
    poll(MORNING, [working(1, "checkout-flow")]);
    poll(MORNING + 10_000, [working(1, "checkout-flow")]);
    expect(notifier.shown).toEqual([]);
  });

  describe("with the reminder's repeat on", () => {
    const REPEATING: TimeRules = {
      ...QUIET,
      longWait: { on: true, minutes: 10, repeat: { on: true, minutes: 30 } },
    };

    test("with no page open, a wait still open is reminded of again each time the minutes pass, saying how long by then, and not once it ends", () => {
      const noon = new Date(2026, 9, 5, 12, 0).getTime();
      const { notifier, poll } = ruled(REPEATING);
      poll(noon, [working(1, "checkout-flow")]);
      for (const minutes of [1, 11, 12, 41, 42, 71]) {
        poll(noon + minutes * MINUTE, [since(1, noon + MINUTE, "checkout-flow")]);
      }
      poll(noon + 72 * MINUTE, [working(1, "checkout-flow")]);
      poll(noon + 101 * MINUTE, [working(1, "checkout-flow")]);
      expect(notifier.shown).toEqual([
        { title: "checkout-flow", body: "Waiting for permission" },
        { title: "checkout-flow", body: "Has waited 10 minutes for permission" },
        { title: "checkout-flow", body: "Has waited 40 minutes for permission" },
        { title: "checkout-flow", body: "Has waited 1 hour 10 minutes for permission" },
      ]);
    });

    test("a page that is open shows each repeat itself, and the collector drops its own", () => {
      const noon = new Date(2026, 9, 5, 12, 0).getTime();
      const { notifier, poll, page } = ruled(REPEATING, false);
      page(noon, ["needs-you"]);
      poll(noon, [working(1, "checkout-flow")]);
      for (const minutes of [1, 11, 41, 71]) {
        page(noon + minutes * MINUTE - 1_000, ["needs-you"]);
        poll(noon + minutes * MINUTE, [since(1, noon + MINUTE, "checkout-flow")]);
        page(noon + minutes * MINUTE + 1_000, ["needs-you"]);
        poll(noon + minutes * MINUTE + 2_000, [since(1, noon + MINUTE, "checkout-flow")]);
      }
      expect(notifier.shown).toEqual([]);
      // Once the page has closed, the collector shows the next itself.
      poll(noon + 101 * MINUTE, [since(1, noon + MINUTE, "checkout-flow")]);
      expect(notifier.shown).toEqual([
        { title: "checkout-flow", body: "Has waited 1 hour 40 minutes for permission" },
      ]);
    });

    test("in quiet hours each comes due held, as its wait: answered in them it is one line of the summary, and still open it has one reminder when they end", () => {
      const { notifier, poll } = ruled(REPEATING);
      const begun = EVENING - 30 * MINUTE;
      poll(begun - MINUTE, [working(1, "checkout-flow"), working(2, "docs-site")]);
      // Both begin at 21:28, before quiet hours, and are shown, and reminded of at 21:38.
      poll(begun, [since(1, begun, "checkout-flow"), since(2, begun, "docs-site")]);
      poll(begun + 10 * MINUTE, [since(1, begun, "checkout-flow"), since(2, begun, "docs-site")]);
      expect(notifier.shown).toHaveLength(4);
      // Repeats come due at 22:08, 22:38 and 23:08, in quiet hours.
      for (const minutes of [40, 70, 100]) {
        poll(begun + minutes * MINUTE, [
          since(1, begun, "checkout-flow"),
          since(2, begun, "docs-site"),
        ]);
      }
      // checkout-flow is answered at 23:28.
      poll(begun + 120 * MINUTE, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      poll(begun + 300 * MINUTE, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      expect(notifier.shown).toHaveLength(4);

      poll(MORNING, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      poll(MORNING + 2_000, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      // 08:08 is a moment, but too soon after the one that went at 08:00.
      poll(MORNING + 8 * MINUTE, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      poll(MORNING + 38 * MINUTE, [working(1, "checkout-flow"), since(2, begun, "docs-site")]);
      expect(notifier.shown.slice(4)).toEqual([
        { title: "While quiet", body: "checkout-flow waited 2 hours" },
        { title: "docs-site", body: "Has waited 10 hours 32 minutes for permission" },
        { title: "docs-site", body: "Has waited 11 hours 10 minutes for permission" },
      ]);
    });
  });
});

test("a wait and its reminder name the session they are about, for a host that opens it or answers it; a summary and a finish do not", () => {
  const notifier = fakeSystemNotifier();
  const noon = new Date(2026, 9, 5, 12, 0).getTime();
  const clock = { now: noon };
  const notifications = createServerNotifications({
    notifier,
    onAtStart: false,
    now: () => clock.now,
  });
  const rules: TimeRules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 10 } };
  const poll = (at: number, sessions: Session[]) => {
    clock.now = at;
    notifications.handle({
      generatedAt: at,
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: at }],
      sessions,
      timeRules: rules,
    });
  };
  const wait = waiting(1, "checkout-flow", { statusSince: noon + 2_000 });
  // A page chose these a minute before, and closed, so nothing is held for it.
  clock.now = noon - 60_000;
  notifications.pageSaid(["needs-you", "finished"], true);
  poll(noon, [working(1, "checkout-flow"), working(2, "docs-site")]);
  poll(noon + 2_000, [wait, makeSession({ id: id(2), name: "docs-site", status: "finished" })]);
  poll(noon + 10 * 60_000 + 2_000, [wait]);
  expect(notifier.shown.map((notice) => notice.body)).toEqual([
    "Waiting for permission",
    "Finished",
    "Has waited 10 minutes for permission",
  ]);
  expect(notifier.about).toEqual([
    { sessionId: id(1) },
    undefined,
    { sessionId: id(1), waitedMs: 10 * 60_000 },
  ]);
});
