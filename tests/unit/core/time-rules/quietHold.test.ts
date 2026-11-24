import { describe, expect, test } from "vitest";

import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
} from "@core/notices/sessionChanges";
import type { Session, SessionsSnapshot, SourceHealth } from "@core/sessions/session";
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

function snapshot(sessions: Session[], source: Partial<SourceHealth> = {}): SessionsSnapshot {
  return {
    generatedAt: T0,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0, ...source }],
    sessions,
  };
}

/** What is remembered after each of these answers of Claude Code in turn. */
function remembered(...snapshots: SessionsSnapshot[]): ChangeMemory {
  return snapshots.reduce(
    (memory, each) => sessionChanges(memory, each).memory,
    EMPTY_CHANGE_MEMORY,
  );
}

/** What is remembered once Claude Code has answered with nothing waiting. */
const READ = remembered(snapshot([]));

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

    const end = hold.end(snapshot([session(1, "checkout-flow")]), T0 + 60 * MINUTE, false, READ);
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
    expect(hold.end(snapshot([]), T0 + 61 * MINUTE, false, READ)).toEqual({
      summary: null,
      open: [],
    });
  });

  test("a wait still open when they end is told of as usual, from the session as it is then, and is not in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0 + MINUTE, "Run: npm test"), T0 + MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 2 * MINUTE);
    expect(hold.holdsWait(id(1))).toBe(true);

    const now = waiting(1, "checkout-flow", T0 + MINUTE, "Run: npm run build");
    const end = hold.end(snapshot([now]), T0 + 30 * MINUTE, false, READ);
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
    const end = hold.end(snapshot([answered]), T0 + 5 * MINUTE + 2_000, false, READ);
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toMatchObject([
      { event: "needs-you", at: T0, waitedMs: 5 * MINUTE, times: 1 },
    ]);
  });

  test("with nothing left to say once the open waits are told of, there is no summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    const end = hold.end(snapshot([waiting(1, "checkout-flow", T0)]), T0 + MINUTE, false, READ);
    expect(end.summary).toBeNull();
    expect(end.open).toHaveLength(1);
  });

  test("leaving answered waits out keeps the rest, and with nothing else there is no summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 5 * MINUTE);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + 6 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 10 * MINUTE, true, READ);
    expect(end.summary?.items.map((item) => item.event)).toEqual(["finished"]);

    const only = createQuietHold();
    only.begin(T0);
    only.holdWait(waiting(1, "checkout-flow", T0), T0);
    only.waitEnded(id(1), T0 + 5 * MINUTE);
    expect(only.end(snapshot([]), T0 + 10 * MINUTE, true, READ)).toEqual({
      summary: null,
      open: [],
    });
  });

  test("a session that waited more than once is one line, with how many times and how long in all", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    hold.waitEnded(id(1), T0 + 4 * MINUTE);
    hold.holdWait(waiting(1, "checkout-flow", T0 + 10 * MINUTE), T0 + 10 * MINUTE);
    hold.waitEnded(id(1), T0 + 16 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 30 * MINUTE, false, READ);
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
    expect(hold.end(snapshot([]), T0 + 5 * MINUTE, false, READ).summary?.items).toEqual([
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
    const end = flickered.end(snapshot([now]), T0 + 30 * MINUTE, false, READ);
    expect(end).toEqual({ summary: null, open: [{ session: now, begunAt: T0 }] });

    // As a notifier holds it: the wait comes back as a change, and is held again.
    const again = createQuietHold();
    again.begin(T0);
    again.holdWait(waiting(1, "checkout-flow", T0), T0);
    again.waitEnded(id(1), T0 + 5 * MINUTE);
    again.holdWait(waiting(1, "checkout-flow", T0), T0);
    expect(again.holdsWait(id(1))).toBe(true);
    const told = again.end(snapshot([now]), T0 + 30 * MINUTE, false, READ);
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
      READ,
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

    const end = hold.end(snapshot([]), T0 + 60 * MINUTE, false, READ);
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
    expect(leftOut.end(snapshot([]), T0 + 10 * MINUTE, true, READ).summary?.items).toEqual([
      { event: "ended", session: session(1, "checkout-flow"), at: T0 + 6 * MINUTE },
    ]);
  });

  test("a wait whose end nobody saw, whose source was read without it all the same, is counted to the end", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0), T0);
    const end = hold.end(snapshot([]), T0 + 20 * MINUTE, false, READ);
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toEqual([expect.objectContaining({ waitedMs: 20 * MINUTE })]);
    expect(hold.holding()).toBe(false);
  });

  test("nothing held keeps what a waiting session was asking", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(waiting(1, "checkout-flow", T0, "Run: rm -rf build"), T0);
    hold.waitEnded(id(1), T0 + MINUTE);
    hold.holdOver("ended", waiting(2, "docs-site", T0, "Edit: src/app.ts"), T0 + 2 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 3 * MINUTE, false, READ);
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
      // Told of already, so it is not held to be told of.
      expect(hold.holdsWait(id(1))).toBe(false);
    }
    hold.waitEnded(id(1), T0 + 70 * MINUTE);
    const end = hold.end(snapshot([session(1, "checkout-flow")]), T0 + 90 * MINUTE, false, READ);
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
    const end = hold.end(
      snapshot([waiting(1, "checkout-flow", begun)]),
      T0 + 60 * MINUTE,
      false,
      READ,
    );
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
      READ,
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
    expect(hold.end(snapshot([]), T0 + 60 * MINUTE, true, READ)).toEqual({
      summary: null,
      open: [],
    });
  });
});

describe("a held wait that cannot be read as quiet hours end", () => {
  const wait = waiting(1, "checkout-flow", T0);
  const unread = snapshot([], { state: "error" });
  const memory = remembered(snapshot([wait]), unread);

  /** A hold of the wait, with a finish beside it, at the first poll past quiet hours, which cannot read it. */
  function heldPast() {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(wait, T0);
    hold.holdOver("finished", session(2, "billing-webhooks"), T0 + MINUTE);
    const end = hold.end(unread, T0 + 60 * MINUTE, false, memory);
    expect(end.open).toEqual([]);
    expect(end.summary?.items.map((item) => item.session.name)).toEqual(["billing-webhooks"]);
    expect(hold.holding()).toBe(true);
    expect(hold.holdsWait(id(1))).toBe(true);
    return hold;
  }

  test("is in no summary, and is told of once it is read and still waits", () => {
    const hold = heldPast();
    expect(hold.end(unread, T0 + 61 * MINUTE, false, memory)).toEqual({ summary: null, open: [] });
    const read = snapshot([wait]);
    expect(hold.end(read, T0 + 62 * MINUTE, false, remembered(read))).toEqual({
      summary: null,
      open: [{ session: wait, begunAt: T0 }],
    });
    expect(hold.holding()).toBe(false);
  });

  test("is forgotten, with nothing said, when it is read and its session waits no more", () => {
    const answered = heldPast();
    answered.waitEnded(id(1), T0 + 62 * MINUTE);
    const read = snapshot([session(1, "checkout-flow")]);
    expect(answered.end(read, T0 + 62 * MINUTE, false, remembered(read))).toEqual({
      summary: null,
      open: [],
    });
    expect(answered.holding()).toBe(false);

    // Gone from the list, and not known to have waited, as after a page found a new collector.
    const gone = heldPast();
    expect(gone.end(snapshot([]), T0 + 62 * MINUTE, false, READ)).toEqual({
      summary: null,
      open: [],
    });
    expect(gone.holding()).toBe(false);
  });

  test("is held through the next quiet hours too, whose summary begins when they do", () => {
    const hold = heldPast();
    hold.begin(T0 + 900 * MINUTE);
    hold.holdOver("ended", session(3, "docs-site"), T0 + 901 * MINUTE);
    const read = snapshot([wait]);
    const end = hold.end(read, T0 + 960 * MINUTE, false, remembered(read));
    expect(end.open).toEqual([{ session: wait, begunAt: T0 }]);
    expect(end.summary).toMatchObject({ from: T0 + 900 * MINUTE, to: T0 + 960 * MINUTE });
    expect(end.summary?.items).toHaveLength(1);
  });

  test("found over in the next quiet hours, is in no summary of theirs, nor is what it would have waited", () => {
    const answered = heldPast();
    answered.begin(T0 + 900 * MINUTE);
    answered.waitEnded(id(1), T0 + 930 * MINUTE);
    answered.holdOver("finished", session(1, "checkout-flow"), T0 + 940 * MINUTE);
    const read = snapshot([session(1, "checkout-flow")]);
    const end = answered.end(read, T0 + 960 * MINUTE, false, remembered(read));
    expect(end.open).toEqual([]);
    expect(end.summary?.items).toEqual([
      { event: "finished", session: session(1, "checkout-flow"), at: T0 + 940 * MINUTE },
    ]);
    expect(answered.holding()).toBe(false);

    // Nor one gone from the list, whose end nobody saw.
    const gone = heldPast();
    gone.begin(T0 + 900 * MINUTE);
    expect(gone.end(snapshot([]), T0 + 960 * MINUTE, false, READ)).toEqual({
      summary: null,
      open: [],
    });
  });

  test("found still waiting in the next quiet hours and answered in them, is in their summary", () => {
    const hold = heldPast();
    hold.begin(T0 + 900 * MINUTE, []);
    hold.begin(T0 + 930 * MINUTE, [wait]);
    hold.waitEnded(id(1), T0 + 940 * MINUTE);
    hold.begin(T0 + 940 * MINUTE, [session(1, "checkout-flow")]);
    const read = snapshot([session(1, "checkout-flow")]);
    expect(hold.end(read, T0 + 960 * MINUTE, false, remembered(read)).summary?.items).toEqual([
      expect.objectContaining({ at: T0, waitedMs: 940 * MINUTE, times: 1 }),
    ]);
  });

  test("found over in the next quiet hours, leaves a later wait held in them to their summary", () => {
    const hold = heldPast();
    hold.begin(T0 + 900 * MINUTE);
    hold.waitEnded(id(1), T0 + 930 * MINUTE);
    const next = waiting(1, "checkout-flow", T0 + 940 * MINUTE);
    hold.holdWait(next, T0 + 940 * MINUTE);
    hold.waitEnded(id(1), T0 + 945 * MINUTE);
    const end = hold.end(snapshot([]), T0 + 960 * MINUTE, false, READ);
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ at: T0 + 940 * MINUTE, waitedMs: 5 * MINUTE, times: 1 }),
    ]);
  });

  test("held for its reminder alone, is left to its reminder", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdReminder(wait, T0);
    expect(hold.end(unread, T0 + 60 * MINUTE, false, memory)).toEqual({ summary: null, open: [] });
    const read = snapshot([wait]);
    expect(hold.end(read, T0 + 61 * MINUTE, false, remembered(read))).toEqual({
      summary: null,
      open: [],
    });
    expect(hold.holding()).toBe(false);
  });

  test("held for its reminder alone, and hidden by another way of reading, is told of again once it is back, as no reminder is to come", () => {
    const main = snapshot([wait], { basis: "feed" });
    const fallback = snapshot([], { basis: "registry" });
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdReminder(wait, T0);
    hold.waitEnded(id(1), T0 + 60 * MINUTE);
    const hidden = remembered(main, fallback);
    expect(hold.end(fallback, T0 + 60 * MINUTE, false, hidden)).toEqual({
      summary: null,
      open: [],
    });
    expect(hold.end(main, T0 + 61 * MINUTE, false, remembered(main, fallback, main))).toEqual({
      summary: null,
      open: [{ session: wait, begunAt: T0 }],
    });
    expect(hold.holding()).toBe(false);
  });

  test("hidden by another way of reading, leaves the waits it had before that one to the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0 - 60 * MINUTE);
    hold.holdWait(waiting(1, "checkout-flow", T0 - 60 * MINUTE), T0 - 60 * MINUTE);
    hold.waitEnded(id(1), T0 - 50 * MINUTE);
    hold.holdWait(wait, T0);
    hold.waitEnded(id(1), T0 + 60 * MINUTE);
    const fallback = snapshot([], { basis: "registry" });
    const hidden = remembered(snapshot([wait], { basis: "feed" }), fallback);
    const end = hold.end(fallback, T0 + 60 * MINUTE, false, hidden);
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ at: T0 - 60 * MINUTE, waitedMs: 10 * MINUTE, times: 1 }),
    ]);
    expect(hold.holding()).toBe(true);
  });

  test("answered, with a later wait of its session open and not held yet, is in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0);
    hold.holdWait(wait, T0);
    hold.waitEnded(id(1), T0 + 10 * MINUTE);
    const later = snapshot([waiting(1, "checkout-flow", T0 + 59 * MINUTE)]);
    const end = hold.end(unread, T0 + 60 * MINUTE, false, remembered(later, unread));
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ at: T0, waitedMs: 10 * MINUTE, times: 1 }),
    ]);
    expect(hold.holding()).toBe(false);
  });

  test("the waits it had before that one are in the summary", () => {
    const hold = createQuietHold();
    hold.begin(T0 - 60 * MINUTE);
    hold.holdWait(waiting(1, "checkout-flow", T0 - 60 * MINUTE), T0 - 60 * MINUTE);
    hold.waitEnded(id(1), T0 - 50 * MINUTE);
    hold.holdWait(wait, T0);
    const end = hold.end(unread, T0 + 60 * MINUTE, false, memory);
    expect(end.summary?.items).toEqual([
      expect.objectContaining({ at: T0 - 60 * MINUTE, waitedMs: 10 * MINUTE, times: 1 }),
    ]);
    expect(hold.holdsWait(id(1))).toBe(true);
  });
});
