import { describe, expect, test } from "vitest";

import { sessionChanges, EMPTY_CHANGE_MEMORY } from "@core/notices/sessionChanges";
import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import { createReminderWatch } from "@core/time-rules/reminders";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function waiting(n: number, since: number | null, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: id(n),
    name: `session-${n}`,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: since,
    ...overrides,
  });
}

const working = (n: number) => makeSession({ id: id(n), name: `session-${n}`, status: "working" });

function snapshot(at: number, sessions: Session[], state: SourceState = "ok"): SessionsSnapshot {
  return {
    generatedAt: at,
    sources: [{ id: "claude-code", label: "Claude Code", state, checkedAt: at }],
    sessions,
  };
}

/**
 * A watch over snapshots the test hands it, with the waits that ended worked
 * out by `sessionChanges`, as every channel does. `poll` gives the reminders
 * due at that moment, marked as sent, as the session ids.
 */
function setUp(thresholdMs = TEN_MINUTES) {
  const watch = createReminderWatch();
  let memory = EMPTY_CHANGE_MEMORY;
  return {
    watch,
    poll(at: number, sessions: Session[], state: SourceState = "ok", threshold = thresholdMs) {
      const shot = snapshot(at, sessions, state);
      const result = sessionChanges(memory, shot);
      memory = result.memory;
      watch.observe(shot, result.stopped, at);
      const due = watch.due(shot, at, threshold);
      for (const one of due) watch.reminded(one.session.id, threshold);
      return due.map((one) => [one.session.id, one.waitedMs]);
    },
  };
}

describe("when a long wait's reminder is due", () => {
  test("once the wait has lasted the threshold, measured from its status time, and once only", () => {
    const { poll } = setUp();
    expect(poll(T0, [working(1)])).toEqual([]);
    expect(poll(T0 + MINUTE, [waiting(1, T0 + MINUTE)])).toEqual([]);
    expect(poll(T0 + 10 * MINUTE, [waiting(1, T0 + MINUTE)])).toEqual([]);
    expect(poll(T0 + 11 * MINUTE, [waiting(1, T0 + MINUTE)])).toEqual([[id(1), TEN_MINUTES]]);
    expect(poll(T0 + 12 * MINUTE, [waiting(1, T0 + MINUTE)])).toEqual([]);
    expect(poll(T0 + 90 * MINUTE, [waiting(1, T0 + MINUTE)])).toEqual([]);
  });

  test("a wait already older than the threshold when it was first seen is never reminded of", () => {
    const { poll } = setUp();
    expect(poll(T0, [waiting(1, T0 - 30 * MINUTE)])).toEqual([]);
    expect(poll(T0 + 60 * MINUTE, [waiting(1, T0 - 30 * MINUTE)])).toEqual([]);
  });

  test("a wait first seen younger than the threshold is, though it began before it was seen", () => {
    const { poll } = setUp();
    expect(poll(T0, [waiting(1, T0 - 4 * MINUTE)])).toEqual([]);
    expect(poll(T0 + 6 * MINUTE, [waiting(1, T0 - 4 * MINUTE)])).toEqual([[id(1), TEN_MINUTES]]);
  });

  test("a wait answered before the threshold sends nothing, and a new wait of the session is a new reminder", () => {
    const { poll } = setUp();
    poll(T0, [working(1)]);
    poll(T0 + MINUTE, [waiting(1, T0 + MINUTE)]);
    expect(poll(T0 + 5 * MINUTE, [working(1)])).toEqual([]);
    expect(poll(T0 + 6 * MINUTE, [waiting(1, T0 + 6 * MINUTE)])).toEqual([]);
    expect(poll(T0 + 16 * MINUTE, [waiting(1, T0 + 6 * MINUTE)])).toEqual([[id(1), TEN_MINUTES]]);
    // Answered and asked again inside one poll: the later status time is a new wait.
    expect(poll(T0 + 17 * MINUTE, [waiting(1, T0 + 17 * MINUTE)])).toEqual([]);
    expect(poll(T0 + 27 * MINUTE, [waiting(1, T0 + 17 * MINUTE)])).toEqual([[id(1), TEN_MINUTES]]);
  });

  test("once per wait for each threshold: a longer one is reminded of again, and a shorter one at once", () => {
    const { poll } = setUp();
    poll(T0, [waiting(1, T0)]);
    expect(poll(T0 + 10 * MINUTE, [waiting(1, T0)])).toEqual([[id(1), TEN_MINUTES]]);
    // The person sets 20 minutes while the wait goes on.
    expect(poll(T0 + 15 * MINUTE, [waiting(1, T0)], "ok", 20 * MINUTE)).toEqual([]);
    expect(poll(T0 + 20 * MINUTE, [waiting(1, T0)], "ok", 20 * MINUTE)).toEqual([
      [id(1), 20 * MINUTE],
    ]);
    // And back to 10, which this wait has been reminded at already.
    expect(poll(T0 + 22 * MINUTE, [waiting(1, T0)])).toEqual([]);

    const other = setUp(20 * MINUTE);
    other.poll(T0, [waiting(2, T0)]);
    expect(other.poll(T0 + 12 * MINUTE, [waiting(2, T0)])).toEqual([]);
    // A shorter threshold that the wait has passed, which it was seen before: due at once.
    expect(other.poll(T0 + 13 * MINUTE, [waiting(2, T0)], "ok", 5 * MINUTE)).toEqual([
      [id(2), 13 * MINUTE],
    ]);
  });

  test("a source that gives no status time is measured from when the wait was first seen", () => {
    const { poll } = setUp();
    poll(T0, [working(1)]);
    poll(T0 + MINUTE, [waiting(1, null)]);
    expect(poll(T0 + 10 * MINUTE, [waiting(1, null)])).toEqual([]);
    expect(poll(T0 + 11 * MINUTE, [waiting(1, null)])).toEqual([[id(1), TEN_MINUTES]]);
  });

  test("a source that misses a poll ends no wait, and its reminder comes when it answers again", () => {
    const { poll } = setUp();
    poll(T0, [waiting(1, T0)]);
    expect(poll(T0 + 9 * MINUTE, [], "error")).toEqual([]);
    expect(poll(T0 + 11 * MINUTE, [waiting(1, T0)])).toEqual([[id(1), 11 * MINUTE]]);
  });

  test("the reminders come in the snapshot's order, and a wait a channel has not told of is left out", () => {
    const { watch } = setUp();
    const shot = snapshot(T0 + 10 * MINUTE, [waiting(2, T0), waiting(1, T0)]);
    watch.observe(snapshot(T0, [waiting(2, T0), waiting(1, T0)]), [], T0);
    expect(watch.due(shot, T0 + 10 * MINUTE, TEN_MINUTES).map((one) => one.session.id)).toEqual([
      id(2),
      id(1),
    ]);
    expect(
      watch.due(shot, T0 + 10 * MINUTE, TEN_MINUTES, (sessionId) => sessionId !== id(2)),
    ).toEqual([{ session: waiting(1, T0), begunAt: T0, waitedMs: TEN_MINUTES }]);
  });

  test("a wait first told of only once it is past the threshold is not reminded of straight after", () => {
    const { watch } = setUp();
    watch.observe(snapshot(T0, [waiting(1, T0), waiting(2, T0)]), [], T0);
    const later = snapshot(T0 + 25 * MINUTE, [waiting(1, T0), waiting(2, T0)]);
    watch.toldLate(id(1), T0 + 25 * MINUTE, TEN_MINUTES);
    // One told of before the threshold is reminded of as usual.
    watch.toldLate(id(2), T0 + 5 * MINUTE, TEN_MINUTES);
    expect(watch.due(later, T0 + 25 * MINUTE, TEN_MINUTES).map((one) => one.session.id)).toEqual([
      id(2),
    ]);
  });

  test("clear forgets every wait: what is seen next is seen for the first time", () => {
    const { watch } = setUp();
    watch.observe(snapshot(T0, [waiting(1, T0)]), [], T0);
    watch.clear();
    const later = snapshot(T0 + 15 * MINUTE, [waiting(1, T0)]);
    watch.observe(later, [], T0 + 15 * MINUTE);
    expect(watch.due(later, T0 + 15 * MINUTE, TEN_MINUTES)).toEqual([]);
  });
});

describe("a wait Agent Lookout answered", () => {
  test("is reminded of never, though it still reads as waiting when the threshold comes", () => {
    const { poll } = setUp();
    poll(T0, [working(1)]);
    poll(T0 + MINUTE, [waiting(1, T0 + MINUTE)]);
    // Answered a moment before the threshold, and read as waiting past it.
    expect(poll(T0 + 11 * MINUTE, [waiting(1, T0 + MINUTE, { answered: true })])).toEqual([]);
    expect(poll(T0 + 11 * MINUTE + 2_000, [working(1)])).toEqual([]);
  });

  test("a wait that begins after it is reminded of as usual", () => {
    const { poll } = setUp();
    poll(T0, [working(1)]);
    poll(T0 + MINUTE, [waiting(1, T0 + MINUTE, { answered: true })]);
    poll(T0 + 2 * MINUTE, [waiting(1, T0 + 2 * MINUTE)]);
    expect(poll(T0 + 12 * MINUTE, [waiting(1, T0 + 2 * MINUTE)])).toEqual([[id(1), TEN_MINUTES]]);
  });
});
