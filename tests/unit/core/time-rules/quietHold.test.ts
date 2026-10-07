import { describe, expect, test } from "vitest";

import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { createQuietHold } from "@core/time-rules/quietHold";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function session(n: number, name: string, overrides: Partial<Session> = {}): Session {
  return makeSession({ id: id(n), name, status: "working", ...overrides });
}

function waiting(n: number, name: string, since: number, text?: string): Session {
  return session(n, name, {
    status: "needs-you",
    waitingReason: "permission",
    statusSince: since,
    ...(text !== undefined && { waitingText: text }),
  });
}

function snapshot(sessions: Session[]): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
    sessions,
  };
}

describe("what quiet hours hold, and what is told when they end", () => {
  test("before anything is noted, nothing is being held", () => {
    const hold = createQuietHold();
    expect(hold.holding()).toBe(false);
    hold.begin(T0);
    hold.begin(T0 + MINUTE);
    expect(hold.holding()).toBe(true);
  });

  test("the summary lists the waits answered, with how long, and the sessions that finished, failed or ended, oldest first", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0 + 10 * MINUTE), T0 + 10 * MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 20 * MINUTE);
    hold.waitEnded(id(1), T0 + 35 * MINUTE);
    hold.holdOver("failed", session(3, "search-indexing"), T0 + 40 * MINUTE);
    hold.holdOver("ended", session(4, "docs-site"), T0 + 5 * MINUTE);

    const end = hold.end(snapshot([session(1, "checkout-flow")]), T0 + 60 * MINUTE, false);
    expect(end.open).toEqual([]);
    expect(end.summary).toEqual({
      from: T0,
      to: T0 + 60 * MINUTE,
      items: [
        { event: "ended", session: session(4, "docs-site"), at: T0 + 5 * MINUTE },
        {
          event: "needs-you",
          session: waiting(1, "checkout-flow", T0 + 10 * MINUTE),
          at: T0 + 10 * MINUTE,
          waitedMs: 25 * MINUTE,
          times: 1,
        },
        { event: "finished", session: session(2, "billing-webhooks"), at: T0 + 20 * MINUTE },
        { event: "failed", session: session(3, "search-indexing"), at: T0 + 40 * MINUTE },
      ],
    });
    // It is forgotten once told.
    expect(hold.holding()).toBe(false);
    expect(hold.end(snapshot([]), T0 + 61 * MINUTE, false)).toEqual({ summary: null, open: [] });
  });

  test("a wait still open when they end is told of as usual, from the session as it is then, and is not in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0 + MINUTE, "Run: npm test"), T0 + MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 2 * MINUTE);
    expect(hold.holdsWait(id(1))).toBe(true);

    const now = waiting(1, "checkout-flow", T0 + MINUTE, "Run: npm run build");
    const end = hold.end(snapshot([now]), T0 + 30 * MINUTE, false);
    expect(end.open).toEqual([{ session: now, begunAt: T0 + MINUTE }]);
    expect(end.summary?.items.map((item) => [item.event, item.session.name])).toEqual([
      ["finished", "billing-webhooks"],
    ]);
  });

  test("a held wait Agent Lookout answered is not open when they end, though it still reads as waiting, and is in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 5 * MINUTE);
    const answered = { ...waiting(1, "checkout-flow", T0), answered: true as const };
    const end = hold.end(snapshot([answered]), T0 + 5 * MINUTE + 2_000, false);
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toMatchObject([
      { event: "needs-you", at: T0, waitedMs: 5 * MINUTE, times: 1 },
    ]);
  });

  test("with nothing left to say once the open waits are told of, there is no summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    const end = hold.end(snapshot([waiting(1, "checkout-flow", T0)]), T0 + MINUTE, false);
    expect(end.summary).toBeNull();
    expect(end.open).toHaveLength(1);
  });

  test("leaving answered waits out keeps the rest, and with nothing else there is no summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 5 * MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 6 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 10 * MINUTE, true);
    expect(end.summary?.items.map((item) => item.event)).toEqual(["finished"]);

    const only = createQuietHold();
    only.begin(T0);
    only.holdWait(waiting(1, "checkout-flow", T0), T0);
    only.waitEnded(id(1), T0 + 5 * MINUTE);
    expect(only.end(snapshot([]), T0 + 10 * MINUTE, true)).toEqual({ summary: null, open: [] });
  });

  test("a session that waited more than once is one line, with how many times and how long in all", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 4 * MINUTE);
    hold.holdWait(waiting(1, "checkout-flow", T0 + 10 * MINUTE), T0 + 10 * MINUTE);
    hold.waitEnded(id(1), T0 + 16 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 30 * MINUTE, false);
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ event: "needs-you", at: T0, waitedMs: 10 * MINUTE, times: 2 }),
    ]);
  });

  test("the same wait seen again, as after a poll its source missed, is held once", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 3 * MINUTE);
    expect(hold.end(snapshot([]), T0 + 5 * MINUTE, false).summary?.items).toEqual([
      expect.objectContaining({ times: 1, waitedMs: 3 * MINUTE }),
    ]);
  });

  test("a held wait seen to end, and back with the time it began, is still open: told of once, and in no summary", () => {
    // As email holds it: the session reads as another status for one poll, and
    // comes back with the same status time, which is not held again.
    const flickered = createQuietHold();
    flickered.begin(T0);
    flickered.holdWait(waiting(1, "checkout-flow", T0), T0);
    flickered.waitEnded(id(1), T0 + 5 * MINUTE);
    const now = waiting(1, "checkout-flow", T0, "Run: npm test");
    const end = flickered.end(snapshot([now]), T0 + 30 * MINUTE, false);
    expect(end).toEqual({ summary: null, open: [{ session: now, begunAt: T0 }] });

    // As a notifier holds it: the wait comes back as a change, and is held again.
    const again = createQuietHold();
    again.begin(T0);
    again.holdWait(waiting(1, "checkout-flow", T0), T0);
    again.waitEnded(id(1), T0 + 5 * MINUTE);
    again.holdWait(waiting(1, "checkout-flow", T0), T0);
    expect(again.holdsWait(id(1))).toBe(true);
    const told = again.end(snapshot([now]), T0 + 30 * MINUTE, false);
    expect(told).toEqual({ summary: null, open: [{ session: now, begunAt: T0 }] });
  });

  test("a held wait seen to end, whose session waits again with a later time, is in the summary, and the new wait is not held", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 5 * MINUTE);
    const end = hold.end(
      snapshot([waiting(1, "checkout-flow", T0 + 20 * MINUTE)]),
      T0 + 30 * MINUTE,
      false,
    );
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ event: "needs-you", waitedMs: 5 * MINUTE, times: 1 }),
    ]);
  });

  test("a session that waited and then finished, failed or ended is one item; one that ended before it waited is two", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0 + 10 * MINUTE), T0 + 10 * MINUTE);
    hold.waitEnded(id(1), T0 + 35 * MINUTE);
    hold.holdOver("ended", session(1, "checkout-flow"), T0 + 40 * MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 5 * MINUTE);
    hold.holdWait(waiting(2, "billing-webhooks", T0 + 20 * MINUTE), T0 + 20 * MINUTE);
    hold.waitEnded(id(2), T0 + 22 * MINUTE);

    const end = hold.end(snapshot([]), T0 + 60 * MINUTE, false);
    expect(end.summary?.items).toEqual([
      { event: "finished", session: session(2, "billing-webhooks"), at: T0 + 5 * MINUTE },
      {
        event: "needs-you",
        session: waiting(1, "checkout-flow", T0 + 10 * MINUTE),
        at: T0 + 10 * MINUTE,
        waitedMs: 25 * MINUTE,
        times: 1,
        then: { event: "ended", at: T0 + 40 * MINUTE },
      },
      {
        event: "needs-you",
        session: waiting(2, "billing-webhooks", T0 + 20 * MINUTE),
        at: T0 + 20 * MINUTE,
        waitedMs: 2 * MINUTE,
        times: 1,
      },
    ]);

    // With the answered waits left out, what it did stands alone.
    const leftOut = createQuietHold();
    leftOut.begin(T0);
    leftOut.holdWait(waiting(1, "checkout-flow", T0), T0);
    leftOut.waitEnded(id(1), T0 + 5 * MINUTE);
    leftOut.holdOver("ended", session(1, "checkout-flow"), T0 + 6 * MINUTE);
    expect(leftOut.end(snapshot([]), T0 + 10 * MINUTE, true).summary?.items).toEqual([
      { event: "ended", session: session(1, "checkout-flow"), at: T0 + 6 * MINUTE },
    ]);
  });

  test("a wait whose end nobody saw, as when its source stopped answering, is counted to the end", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    const end = hold.end(snapshot([]), T0 + 20 * MINUTE, false);
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toEqual([expect.objectContaining({ waitedMs: 20 * MINUTE })]);
  });

  test("nothing held keeps what a waiting session was asking", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0, "Run: rm -rf build"), T0);
    hold.waitEnded(id(1), T0 + MINUTE);
    hold.holdOver("ended", waiting(2, "docs-site", T0, "Edit: src/app.ts"), T0 + 2 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 3 * MINUTE, false);
    expect(JSON.stringify(end)).not.toMatch(/rm -rf|src\/app/);
  });
});

describe("a reminder that comes due in quiet hours", () => {
  test("holds its wait once, however many come due: answered before they end, it is one item in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    // Told of before quiet hours, at T0 - 15 minutes, and reminded of three times in them.
    const begun = T0 - 15 * MINUTE;
    for (let reminder = 0; reminder < 3; reminder += 1) {
      hold.holdReminder(waiting(1, "checkout-flow", begun, "Run: npm test"), begun);
      expect(hold.holdsWait(id(1))).toBe(true);
    }
    hold.waitEnded(id(1), T0 + 70 * MINUTE);
    const end = hold.end(snapshot([session(1, "checkout-flow")]), T0 + 90 * MINUTE, false);
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toEqual([
      {
        event: "needs-you",
        session: waiting(1, "checkout-flow", begun),
        at: begun,
        waitedMs: 85 * MINUTE,
        times: 1,
      },
    ]);
    expect(JSON.stringify(end)).not.toContain("npm test");
  });

  test("still open when they end, it is left to its reminder: neither told of again as a wait nor in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    const begun = T0 - 15 * MINUTE;
    hold.holdReminder(waiting(1, "checkout-flow", begun), begun);
    hold.holdReminder(waiting(1, "checkout-flow", begun), begun);
    const end = hold.end(snapshot([waiting(1, "checkout-flow", begun)]), T0 + 60 * MINUTE, false);
    expect(end).toEqual({ summary: null, open: [] });
  });

  test("a wait held as a wait stays one, to be told of as usual, and one seen anew as a wait is told of as usual too", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0 + MINUTE), T0 + MINUTE);
    hold.holdReminder(waiting(1, "checkout-flow", T0 + MINUTE), T0 + MINUTE);
    const begun = T0 - 15 * MINUTE;
    hold.holdReminder(waiting(2, "docs-site", begun), begun);
    hold.holdWait(waiting(2, "docs-site", begun), begun);
    const end = hold.end(
      snapshot([waiting(1, "checkout-flow", T0 + MINUTE), waiting(2, "docs-site", begun)]),
      T0 + 60 * MINUTE,
      false,
    );
    expect(end.summary).toBeNull();
    expect(end.open.map((one) => [one.session.id, one.begunAt])).toEqual([
      [id(1), T0 + MINUTE],
      [id(2), begun],
    ]);
  });

  test("leaving answered waits out leaves it out too", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdReminder(waiting(1, "checkout-flow", T0 - MINUTE), T0 - MINUTE);
    hold.waitEnded(id(1), T0 + 10 * MINUTE);
    expect(hold.end(snapshot([]), T0 + 60 * MINUTE, true)).toEqual({ summary: null, open: [] });
  });
});
