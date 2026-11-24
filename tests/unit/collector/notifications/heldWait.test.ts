import { describe, expect, test } from "vitest";

import {
  HANDOVER_GRACE_MS,
  heldWaitOutcome,
  noPageReports,
  PAGE_GONE_AFTER_MS,
  pagesAt,
  type PageReports,
} from "@collector/notifications/heldWait";
import { POLL_INTERVAL_MS } from "@collector/poller";

const T0 = 1_700_000_000_000;

/** A page that said "on" and last asked for something `agoMs` before the wait was seen. */
function pageOn(agoMs: number, overrides: Partial<PageReports> = {}): PageReports {
  return { on: true, lastOnAt: T0 - agoMs, lastOnSessionsAt: T0 - agoMs, ...overrides };
}

describe("with no page to wait for", () => {
  test("a wait is shown at once when the environment turned notifications on and no page has asked for anything", () => {
    expect(heldWaitOutcome(T0, noPageReports(true), T0)).toBe("show");
  });

  test("a wait is shown at once when the last page that said on went quiet more than a few seconds ago", () => {
    expect(heldWaitOutcome(T0, pageOn(PAGE_GONE_AFTER_MS + 1), T0)).toBe("show");
    expect(heldWaitOutcome(T0, pageOn(60_000), T0)).toBe("show");
  });

  test("a held wait is shown as soon as its page has been quiet that long, without waiting out the grace period", () => {
    const pages = pageOn(PAGE_GONE_AFTER_MS - 1_000);
    expect(heldWaitOutcome(T0, pages, T0)).toBe("hold");
    expect(heldWaitOutcome(T0, pages, T0 + 1_001)).toBe("show");
    expect(1_001).toBeLessThan(HANDOVER_GRACE_MS);
  });
});

describe("with a page that said on still asking", () => {
  test("a wait is held until the grace period is over, and then shown", () => {
    // The page goes on asking for other things, and never for the sessions.
    const asking = (now: number): PageReports => pageOn(1_000, { lastOnAt: now });

    expect(heldWaitOutcome(T0, asking(T0), T0)).toBe("hold");
    expect(heldWaitOutcome(T0, asking(T0 + 1), T0 + 1)).toBe("hold");
    expect(
      heldWaitOutcome(T0, asking(T0 + HANDOVER_GRACE_MS - 1), T0 + HANDOVER_GRACE_MS - 1),
    ).toBe("hold");
    expect(heldWaitOutcome(T0, asking(T0 + HANDOVER_GRACE_MS), T0 + HANDOVER_GRACE_MS)).toBe(
      "show",
    );
    expect(heldWaitOutcome(T0, asking(T0 + 60_000), T0 + 60_000)).toBe("show");
  });

  test("a wait is dropped once the page has fetched the sessions after the wait was seen, however late that is noticed", () => {
    const fetched = pageOn(1_000, { lastOnAt: T0 + 1_500, lastOnSessionsAt: T0 + 1_500 });

    expect(heldWaitOutcome(T0, fetched, T0 + 1_500)).toBe("drop");
    expect(heldWaitOutcome(T0, fetched, T0 + HANDOVER_GRACE_MS)).toBe("drop");
    expect(heldWaitOutcome(T0, fetched, T0 + 60_000)).toBe("drop");
  });

  test("a fetch from before the wait was seen, or in the same millisecond, does not count", () => {
    expect(heldWaitOutcome(T0, pageOn(1), T0 + 1_000)).toBe("hold");
    expect(heldWaitOutcome(T0, pageOn(0), T0 + 1_000)).toBe("hold");
    expect(heldWaitOutcome(T0, pageOn(0), T0 + HANDOVER_GRACE_MS)).toBe("show");
  });

  test("a request for anything but the sessions keeps the wait held, and does not drop it", () => {
    const pages = pageOn(1_000, { lastOnAt: T0 + 2_000 });
    expect(heldWaitOutcome(T0, pages, T0 + 2_000)).toBe("hold");
  });
});

describe("with notifications off", () => {
  test("a wait is dropped, whatever any page did before", () => {
    expect(heldWaitOutcome(T0, noPageReports(false), T0)).toBe("drop");
    expect(heldWaitOutcome(T0, { ...pageOn(1_000), on: false }, T0)).toBe("drop");
    expect(heldWaitOutcome(T0, { ...pageOn(1_000), on: false }, T0 + 60_000)).toBe("drop");
  });
});

describe("with pages that show no notifications of their own, as the Mac app's window", () => {
  test("a wait is shown at once, though a page that said on keeps asking and has fetched the sessions since", () => {
    const fetched = pageOn(1_000, { lastOnAt: T0 + 1, lastOnSessionsAt: T0 + 1 });
    expect(heldWaitOutcome(T0, fetched, T0 + 1, false)).toBe("show");
    expect(heldWaitOutcome(T0, pageOn(0, { lastOnAt: T0 }), T0, false)).toBe("show");
    expect(heldWaitOutcome(T0, noPageReports(true), T0, false)).toBe("show");
  });

  test("a wait is still dropped while notifications are off", () => {
    expect(heldWaitOutcome(T0, noPageReports(false), T0, false)).toBe("drop");
    expect(heldWaitOutcome(T0, { ...pageOn(1_000), on: false }, T0 + 60_000, false)).toBe("drop");
  });

  test("left out, or true, pages are taken to show their own, and a wait is held or dropped for them as before", () => {
    const asking = pageOn(1_000, { lastOnAt: T0 });
    const fetched = pageOn(1_000, { lastOnAt: T0 + 1_500, lastOnSessionsAt: T0 + 1_500 });
    expect(heldWaitOutcome(T0, asking, T0)).toBe("hold");
    expect(heldWaitOutcome(T0, asking, T0, true)).toBe("hold");
    expect(heldWaitOutcome(T0, fetched, T0 + 1_500)).toBe("drop");
    expect(heldWaitOutcome(T0, fetched, T0 + 1_500, true)).toBe("drop");
    // With them off, the same two are shown at once.
    expect(heldWaitOutcome(T0, asking, T0, false)).toBe("show");
    expect(heldWaitOutcome(T0, fetched, T0 + 1_500, false)).toBe("show");
  });
});

describe("the clock set back", () => {
  test("a request of a page at a time later than now counts as made now, and one now or before as it was", () => {
    expect(pagesAt(pageOn(1, { lastOnAt: T0 + 1 }), T0)).toEqual(pageOn(1, { lastOnAt: T0 }));
    expect(pagesAt(pageOn(0), T0 - 1)).toEqual(pageOn(1));
    expect(pagesAt(noPageReports(false), T0)).toEqual(noPageReports(false));
  });
});

describe("the two lengths of time", () => {
  test("the grace period is five seconds at most, and leaves a page one full turn of its own polling", () => {
    expect(HANDOVER_GRACE_MS).toBeLessThanOrEqual(5_000);
    expect(HANDOVER_GRACE_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });

  test("checked on every poll, a wait no page takes is shown on the second poll after it was seen", () => {
    const asking = (now: number): PageReports => pageOn(0, { lastOnAt: now });
    const polls = [1, 2, 3].map((n) => T0 + n * POLL_INTERVAL_MS);

    expect(polls.map((now) => heldWaitOutcome(T0, asking(now), now))).toEqual([
      "hold",
      "show",
      "show",
    ]);
    // Polls that run up to a second late still decide inside five seconds.
    expect(heldWaitOutcome(T0, asking(T0 + 2_999), T0 + 2_999)).toBe("hold");
    expect(heldWaitOutcome(T0, asking(T0 + 4_999), T0 + 4_999)).toBe("show");
  });

  test("a page is not given up on between two of its own polls", () => {
    expect(PAGE_GONE_AFTER_MS).toBeGreaterThan(2 * POLL_INTERVAL_MS);
  });
});
