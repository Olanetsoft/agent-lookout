import { describe, expect, test } from "vitest";

import { sessionChanges, EMPTY_CHANGE_MEMORY } from "@core/notices/sessionChanges";
import type { Session, SessionsSnapshot, SourceState } from "@core/sessions/session";
import {
  createReminderWatch,
  reminderNumber,
  reminderSchedule,
  type ReminderSchedule,
} from "@core/time-rules/reminders";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;

/** A threshold alone, with no repeat. */
const once = (thresholdMs: number): ReminderSchedule => ({ thresholdMs, everyMs: null });

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
 * due at that moment, marked as sent, as the session ids, and `pollRepeats`
 * the same with which reminder each is.
 */
function setUp(thresholdMs = TEN_MINUTES) {
  const watch = createReminderWatch();
  let memory = EMPTY_CHANGE_MEMORY;
  const dueAt = (
    at: number,
    sessions: Session[],
    state: SourceState,
    schedule: ReminderSchedule,
  ) => {
    const shot = snapshot(at, sessions, state);
    const result = sessionChanges(memory, shot);
    memory = result.memory;
    watch.observe(shot, result.stopped, at);
    const due = watch.due(shot, at, schedule);
    for (const one of due) watch.told(one.session.id, at);
    return due;
  };
  return {
    watch,
    poll(at: number, sessions: Session[], state: SourceState = "ok", threshold = thresholdMs) {
      return dueAt(at, sessions, state, once(threshold)).map((one) => [
        one.session.id,
        one.waitedMs,
      ]);
    },
    pollRepeats(at: number, sessions: Session[], schedule: ReminderSchedule) {
      return dueAt(at, sessions, "ok", schedule).map((one) => [
        one.session.id,
        one.waitedMs / MINUTE,
        one.repeat,
      ]);
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
    expect(
      watch.due(shot, T0 + 10 * MINUTE, once(TEN_MINUTES)).map((one) => one.session.id),
    ).toEqual([id(2), id(1)]);
    expect(
      watch.due(shot, T0 + 10 * MINUTE, once(TEN_MINUTES), (sessionId) => sessionId !== id(2)),
    ).toEqual([{ session: waiting(1, T0), begunAt: T0, waitedMs: TEN_MINUTES, repeat: 0 }]);
  });

  test("a wait first told of only once it is past the threshold is not reminded of straight after", () => {
    const { watch } = setUp();
    watch.observe(snapshot(T0, [waiting(1, T0), waiting(2, T0)]), [], T0);
    const later = snapshot(T0 + 25 * MINUTE, [waiting(1, T0), waiting(2, T0)]);
    watch.told(id(1), T0 + 25 * MINUTE);
    // One told of before the threshold is reminded of as usual.
    watch.told(id(2), T0 + 5 * MINUTE);
    expect(
      watch.due(later, T0 + 25 * MINUTE, once(TEN_MINUTES)).map((one) => one.session.id),
    ).toEqual([id(2)]);
  });

  test("clear forgets every wait: what is seen next is seen for the first time", () => {
    const { watch } = setUp();
    watch.observe(snapshot(T0, [waiting(1, T0)]), [], T0);
    watch.clear();
    const later = snapshot(T0 + 15 * MINUTE, [waiting(1, T0)]);
    watch.observe(later, [], T0 + 15 * MINUTE);
    expect(watch.due(later, T0 + 15 * MINUTE, once(TEN_MINUTES))).toEqual([]);
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

describe("the schedule of a wait's reminders", () => {
  const EVERY_30: ReminderSchedule = { thresholdMs: TEN_MINUTES, everyMs: 30 * MINUTE };

  test("the long wait rule makes it, and a repeat that is off or not there is the threshold alone", () => {
    expect(reminderSchedule({ on: true, minutes: 10 })).toEqual(once(TEN_MINUTES));
    expect(reminderSchedule({ on: true, minutes: 10, repeat: { on: false, minutes: 30 } })).toEqual(
      once(TEN_MINUTES),
    );
    expect(reminderSchedule({ on: true, minutes: 10, repeat: { on: true, minutes: 30 } })).toEqual(
      EVERY_30,
    );
  });

  test("each moment is counted by how long the wait has lasted, from 0 at the threshold", () => {
    expect(
      [0, 9, 10, 39, 40, 69, 70, 1_000].map((m) => reminderNumber(m * MINUTE, EVERY_30)),
    ).toEqual([-1, -1, 0, 0, 1, 1, 2, 33]);
    expect([9, 10, 1_000].map((m) => reminderNumber(m * MINUTE, once(TEN_MINUTES)))).toEqual([
      -1, 0, 0,
    ]);
  });
});

describe("with the repeat on", () => {
  const EVERY_30: ReminderSchedule = { thresholdMs: TEN_MINUTES, everyMs: 30 * MINUTE };

  test("a wait still open is reminded of again each time the repeat's minutes pass, with how long it has waited", () => {
    const { pollRepeats } = setUp();
    pollRepeats(T0, [working(1)], EVERY_30);
    const at = (minutes: number) => pollRepeats(T0 + minutes * MINUTE, [waiting(1, T0)], EVERY_30);
    expect(at(0)).toEqual([]);
    expect(at(10)).toEqual([[id(1), 10, 0]]);
    expect(at(20)).toEqual([]);
    expect(at(39)).toEqual([]);
    expect(at(40)).toEqual([[id(1), 40, 1]]);
    expect(at(41)).toEqual([]);
    expect(at(70)).toEqual([[id(1), 70, 2]]);
    expect(at(70.5)).toEqual([]);
  });

  test("after a gap, as when the computer slept, one reminder goes for the latest moment passed, and none for those before it", () => {
    const { pollRepeats } = setUp();
    pollRepeats(T0, [working(1)], EVERY_30);
    pollRepeats(T0 + MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30);
    expect(pollRepeats(T0 + 11 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 10, 0],
    ]);
    // Asleep from 12 minutes to 2 hours 6 minutes: four moments passed in that time.
    expect(pollRepeats(T0 + 126 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 125, 3],
    ]);
    // The moment at 2 hours 10 minutes is only 5 minutes after it, and is passed over.
    expect(pollRepeats(T0 + 131 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + 160 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([]);
    // The next keeps to the wait's own moments, not to when the last one went.
    expect(pollRepeats(T0 + 161 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 160, 5],
    ]);
  });

  test("a late one more than half the minutes before the next moment is followed by it as usual", () => {
    const { pollRepeats } = setUp();
    pollRepeats(T0, [working(1)], EVERY_30);
    pollRepeats(T0 + MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30);
    // Asleep from the start until 1 hour 14 minutes: the first reminder goes late, for 1 hour 10.
    expect(pollRepeats(T0 + 75 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 74, 2],
    ]);
    expect(pollRepeats(T0 + 101 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 100, 3],
    ]);
  });

  test("a page opened, or Agent Lookout started, a minute before a moment comes to it as the rest do", () => {
    const { pollRepeats } = setUp();
    expect(pollRepeats(T0, [waiting(1, T0 - 39 * MINUTE)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + MINUTE, [waiting(1, T0 - 39 * MINUTE)], EVERY_30)).toEqual([
      [id(1), 40, 1],
    ]);
  });

  test("a wait first seen past the threshold, as after Agent Lookout started again, has nothing for the moments it had passed, and its next at the next moment", () => {
    const { pollRepeats } = setUp();
    expect(pollRepeats(T0, [waiting(1, T0 - 50 * MINUTE)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + 19 * MINUTE, [waiting(1, T0 - 50 * MINUTE)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + 20 * MINUTE, [waiting(1, T0 - 50 * MINUTE)], EVERY_30)).toEqual([
      [id(1), 70, 2],
    ]);
  });

  test("a wait first told of late has its next at the moment after it", () => {
    const { watch } = setUp();
    watch.observe(snapshot(T0, [waiting(1, T0)]), [], T0);
    watch.told(id(1), T0 + 25 * MINUTE);
    const at = (minutes: number) =>
      watch
        .due(snapshot(T0 + minutes * MINUTE, [waiting(1, T0)]), T0 + minutes * MINUTE, EVERY_30)
        .map((one) => one.repeat);
    expect(at(25)).toEqual([]);
    expect(at(39)).toEqual([]);
    expect(at(40)).toEqual([1]);
  });

  test("a wait answered, by Agent Lookout or at its source, or one that ends, has no further reminder", () => {
    const { pollRepeats } = setUp();
    const sessions = [waiting(1, T0), waiting(2, T0), waiting(3, T0)];
    pollRepeats(T0, [working(1), working(2), working(3)], EVERY_30);
    pollRepeats(T0 + MINUTE, sessions, EVERY_30);
    expect(pollRepeats(T0 + 10 * MINUTE, sessions, EVERY_30).map(([one]) => one)).toEqual([
      id(1),
      id(2),
      id(3),
    ]);
    // session-1 is answered at its source, session-2 by Agent Lookout, though it
    // still reads as waiting, and session-3 ends.
    expect(
      pollRepeats(T0 + 40 * MINUTE, [working(1), waiting(2, T0, { answered: true })], EVERY_30),
    ).toEqual([]);
    expect(pollRepeats(T0 + 70 * MINUTE, [working(1), working(2)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + 100 * MINUTE, [working(1), working(2)], EVERY_30)).toEqual([]);
  });

  test("the repeat changed while a wait goes on counts from the last reminder, and never brings the moments before it", () => {
    const { pollRepeats } = setUp();
    const at = (minutes: number, everyMinutes: number | null) =>
      pollRepeats(T0 + minutes * MINUTE, [waiting(1, T0)], {
        thresholdMs: TEN_MINUTES,
        everyMs: everyMinutes === null ? null : everyMinutes * MINUTE,
      });
    at(0, 30);
    expect(at(10, 30)).toEqual([[id(1), 10, 0]]);
    // Every 5 minutes from 12: the next is at 15.
    expect(at(12, 5)).toEqual([]);
    expect(at(15, 5)).toEqual([[id(1), 15, 1]]);
    // Every hour from 16: 15 minutes is still before its first repeat, at 70.
    expect(at(16, 60)).toEqual([]);
    expect(at(69, 60)).toEqual([]);
    expect(at(70, 60)).toEqual([[id(1), 70, 1]]);
    // Turned off, there is none, however long it waits.
    expect(at(200, null)).toEqual([]);
  });

  test("a new wait of the session starts its schedule again", () => {
    const { pollRepeats } = setUp();
    pollRepeats(T0, [working(1)], EVERY_30);
    pollRepeats(T0 + MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30);
    expect(pollRepeats(T0 + 41 * MINUTE, [waiting(1, T0 + MINUTE)], EVERY_30)).toEqual([
      [id(1), 40, 1],
    ]);
    pollRepeats(T0 + 42 * MINUTE, [working(1)], EVERY_30);
    pollRepeats(T0 + 43 * MINUTE, [waiting(1, T0 + 43 * MINUTE)], EVERY_30);
    expect(pollRepeats(T0 + 52 * MINUTE, [waiting(1, T0 + 43 * MINUTE)], EVERY_30)).toEqual([]);
    expect(pollRepeats(T0 + 53 * MINUTE, [waiting(1, T0 + 43 * MINUTE)], EVERY_30)).toEqual([
      [id(1), 10, 0],
    ]);
  });
});
