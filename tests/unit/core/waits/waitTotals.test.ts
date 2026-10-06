import { afterAll, describe, expect, test, vi } from "vitest";

import type { SessionEvent, SessionStatus } from "@core/sessions/session";
import type { Span } from "@core/waits/measured";
import {
  isWaitEvent,
  MAX_WAIT_SESSIONS,
  unendedWaits,
  waitsOf,
  waitTotals,
  type WaitTotalsInput,
} from "@core/waits/waitTotals";

// The days are this computer's own. The tests below are in a zone whose clocks
// do not change in the week they use, whatever the zone of the computer that
// runs them; those of a change of the clocks pick a zone of their own.
vi.stubEnv("TZ", "UTC");
afterAll(() => {
  vi.unstubAllEnvs();
});

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A moment on the local clock in a week of October. */
const at = (day: number, hours: number, minutes = 0, seconds = 0) =>
  new Date(2026, 9, day, hours, minutes, seconds).getTime();

/** Tuesday afternoon. Today began at midnight; the seven days at midnight on the Wednesday before. */
const NOW = at(6, 15, 0);

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let serial = 0;
function event(
  n: number,
  moment: number,
  kind: SessionEvent["kind"],
  from?: SessionStatus,
  to?: SessionStatus,
): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at: moment,
    sessionId: id(n),
    sessionName: `project-${n}`,
    kind,
    ...(from && { from }),
    ...(to && { to }),
    severity: to === "needs-you" ? "warning" : "advisory",
  };
}

const into = (n: number, moment: number) =>
  event(n, moment, "status-changed", "working", "needs-you");
const out = (n: number, moment: number) =>
  event(n, moment, "status-changed", "needs-you", "working");

/** Midnight on the Wednesday before: the seven days are it, the five days after and today. */
const WEEK_START = new Date(2026, 8, 30).getTime();

/** Measured without a break from before the seven days to the present. */
const ALL_WEEK: Span[] = [{ from: WEEK_START - 2 * 24 * HOUR, to: NOW }];

function input(overrides: Partial<WaitTotalsInput>): WaitTotalsInput {
  return {
    events: [],
    measured: ALL_WEEK,
    runStarts: [],
    waitingNow: [],
    since: WEEK_START - 2 * 24 * HOUR,
    now: NOW,
    ...overrides,
  };
}

describe("waitTotals", () => {
  test("a wait counts from the move into needs-you to the move out, today and in the seven days", () => {
    const { today, sevenDays } = waitTotals(
      input({ events: [into(1, at(6, 10)), out(1, at(6, 10, 12))] }),
    );
    expect(today).toMatchObject({
      from: at(6, 0),
      to: NOW,
      waitedMs: 12 * MINUTE,
      openMs: 0,
      waits: 1,
    });
    expect(today.measuredMs).toBe(15 * HOUR);
    expect(sevenDays).toMatchObject({ from: WEEK_START, to: NOW, waitedMs: 12 * MINUTE, waits: 1 });
    expect(today.sessions).toEqual([
      { sessionId: id(1), name: "project-1", waitedMs: 12 * MINUTE, waits: 1, open: false },
    ]);
    expect(today.sessionCount).toBe(1);
  });

  test("the seven days are today and the six local days before it, each with its own totals, oldest first", () => {
    const { sevenDays } = waitTotals(
      input({
        events: [into(1, at(1, 9)), out(1, at(1, 9, 5)), into(2, at(4, 18)), out(2, at(4, 18, 30))],
      }),
    );
    expect(sevenDays.from).toBe(WEEK_START);
    expect(sevenDays.days.map((day) => day.day)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
    expect(sevenDays.days.map((day) => day.waitedMs)).toEqual([
      0,
      5 * MINUTE,
      0,
      0,
      30 * MINUTE,
      0,
      0,
    ]);
    expect(sevenDays.days.map((day) => day.measuredMs)).toEqual([
      24 * HOUR,
      24 * HOUR,
      24 * HOUR,
      24 * HOUR,
      24 * HOUR,
      24 * HOUR,
      15 * HOUR,
    ]);
    expect(sevenDays.days.at(-1)).toMatchObject({ from: at(6, 0), to: NOW });
    expect(sevenDays).toMatchObject({ waitedMs: 35 * MINUTE, waits: 2, sessionCount: 2 });
    // Longest first.
    expect(sevenDays.sessions.map((session) => session.name)).toEqual(["project-2", "project-1"]);
  });

  test("overlapping waits of two sessions are each counted, so two waiting at once for five minutes are ten", () => {
    const { today } = waitTotals(
      input({
        events: [
          into(1, at(6, 10)),
          into(2, at(6, 10, 5)),
          out(1, at(6, 10, 10)),
          out(2, at(6, 10, 15)),
        ],
      }),
    );
    expect(today.waitedMs).toBe(20 * MINUTE);
    expect(today.waits).toBe(2);
    expect(today.sessions.map((session) => [session.name, session.waitedMs])).toEqual([
      ["project-1", 10 * MINUTE],
      ["project-2", 10 * MINUTE],
    ]);
  });

  test("a wait across midnight counts on each day for its part, and once in the seven days", () => {
    const { today, sevenDays } = waitTotals(
      input({ events: [into(1, at(5, 23, 50)), out(1, at(6, 0, 20))] }),
    );
    expect(today).toMatchObject({ waitedMs: 20 * MINUTE, waits: 1 });
    const [monday, tuesday] = sevenDays.days.slice(-2);
    expect(monday).toMatchObject({ day: "2026-10-05", waitedMs: 10 * MINUTE, waits: 1 });
    expect(tuesday).toMatchObject({ day: "2026-10-06", waitedMs: 20 * MINUTE, waits: 1 });
    expect(sevenDays).toMatchObject({ waitedMs: 30 * MINUTE, waits: 1 });
    expect(sevenDays.sessions[0]).toMatchObject({ waitedMs: 30 * MINUTE, waits: 1 });
  });

  test("a wait still open runs to the present, and is the open part, while its session needs the person", () => {
    const lastPoll = NOW - 2 * SECOND;
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 14, 50))],
        measured: [{ from: at(6, 0), to: lastPoll }],
        waitingNow: [{ id: id(1), name: "project-1" }],
      }),
    );
    // The newest stretch reaches the present: the last poll was two seconds ago.
    expect(today).toMatchObject({ waitedMs: 10 * MINUTE, openMs: 10 * MINUTE, waits: 1 });
    expect(today.measuredMs).toBe(15 * HOUR);
    expect(today.days[0]).toMatchObject({ openMs: 10 * MINUTE });
    expect(today.sessions[0]).toMatchObject({ open: true, waitedMs: 10 * MINUTE });
  });

  test("a session found waiting with no move into needs-you held is counted from when this run began", () => {
    const { today } = waitTotals(
      input({
        runStarts: [at(5, 9), at(6, 14, 30)],
        waitingNow: [{ id: id(3), name: "project-3" }],
      }),
    );
    expect(today).toMatchObject({ waitedMs: 30 * MINUTE, openMs: 30 * MINUTE, waits: 1 });
    expect(today.sessions).toEqual([
      { sessionId: id(3), name: "project-3", waitedMs: 30 * MINUTE, waits: 1, open: true },
    ]);
  });

  test("a wait whose start is not held is counted from the run it ended in, or the session's previous move", () => {
    const { today } = waitTotals(
      input({
        // Found waiting as Agent Lookout started at 11:00, answered at 12:00,
        // then a move out with no move in: it waited since its last event.
        events: [out(1, at(6, 12)), out(1, at(6, 12, 40))],
        runStarts: [at(6, 8), at(6, 11)],
      }),
    );
    expect(today.sessions[0]).toMatchObject({ waitedMs: HOUR + 40 * MINUTE, waits: 2 });
  });

  test("time not measured is not counted, and a wait across a break is still one wait", () => {
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 8, 50)), out(1, at(6, 9, 40))],
        // Stopped, or asleep, from 9:00 to 9:30.
        measured: [
          { from: at(6, 0), to: at(6, 9) },
          { from: at(6, 9, 30), to: NOW },
        ],
      }),
    );
    expect(today).toMatchObject({ waitedMs: 20 * MINUTE, waits: 1 });
    expect(today.measuredMs).toBe(15 * HOUR - 30 * MINUTE);
  });

  test("after a restart the newest stretch is not carried on to the present until a poll comes", () => {
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 14, 50))],
        measured: [{ from: at(6, 0), to: NOW - 5 * SECOND }],
        runStarts: [at(6, 0), NOW - 2 * SECOND],
        waitingNow: [{ id: id(1), name: "project-1" }],
      }),
    );
    expect(today.measuredMs).toBe(15 * HOUR - 5 * SECOND);
    expect(today.waitedMs).toBe(10 * MINUTE - 5 * SECOND);
  });

  test("nothing before the history begins is counted, as with history kept in memory only since this run started", () => {
    const started = at(6, 13);
    const { today, sevenDays } = waitTotals(
      input({
        events: [into(1, at(6, 12)), out(1, at(6, 13, 30)), into(2, at(4, 9)), out(2, at(4, 10))],
        measured: [
          { from: at(4, 8), to: at(4, 11) },
          { from: started, to: NOW },
        ],
        runStarts: [started],
        since: started,
      }),
    );
    expect(today).toMatchObject({ waitedMs: 30 * MINUTE, measuredMs: 2 * HOUR });
    expect(sevenDays).toMatchObject({ waitedMs: 30 * MINUTE, measuredMs: 2 * HOUR, waits: 1 });
    expect(sevenDays.days.filter((day) => day.measuredMs > 0).map((day) => day.day)).toEqual([
      "2026-10-06",
    ]);
  });

  test("a period nobody measured has every day in it, each with nothing measured", () => {
    const { today, sevenDays } = waitTotals(input({ measured: [] }));
    expect(today).toMatchObject({
      waitedMs: 0,
      waits: 0,
      measuredMs: 0,
      sessions: [],
      sessionCount: 0,
    });
    expect(sevenDays.days).toHaveLength(7);
    expect(sevenDays.days.every((day) => day.measuredMs === 0)).toBe(true);
  });

  test("an end closes a wait, an appearance in needs-you opens one, and moves that never touch needs-you are no wait", () => {
    const events = [
      event(1, at(6, 9), "appeared", undefined, "needs-you"),
      event(1, at(6, 9, 10), "ended", "needs-you"),
      event(1, at(6, 10), "appeared", undefined, "needs-you"),
      event(1, at(6, 10, 5), "status-changed", "needs-you", "finished"),
      // A Codex session never needs the person: working and idle are not waits.
      event(2, at(6, 11), "status-changed", "working", "idle"),
      event(2, at(6, 12), "status-changed", "idle", "working"),
    ];
    expect(events.filter(isWaitEvent)).toHaveLength(4);
    const { today } = waitTotals(input({ events }));
    expect(today).toMatchObject({ waitedMs: 15 * MINUTE, waits: 2, sessionCount: 1 });
  });

  test("an answer or a stop from Agent Lookout during a wait is no move: the wait is still one wait", () => {
    const answered = event(1, at(6, 10, 2), "answered", "needs-you");
    const stopped = event(2, at(6, 11, 4), "stopped", "needs-you");
    const events = [
      into(1, at(6, 10)),
      answered,
      out(1, at(6, 10, 3)),
      into(2, at(6, 11)),
      stopped,
      event(2, at(6, 11, 5), "ended", "needs-you"),
    ];
    expect(isWaitEvent(answered)).toBe(false);
    expect(isWaitEvent(stopped)).toBe(false);
    const { today } = waitTotals(input({ events }));
    expect(today).toMatchObject({ waitedMs: 8 * MINUTE, waits: 2, sessionCount: 2 });
    expect(today.sessions.map((session) => session.waits)).toEqual([1, 1]);
  });

  test("a session's name is its newest, and the snapshot's for a session waiting now", () => {
    const renamed = { ...out(1, at(6, 10, 5)), sessionName: "renamed" };
    const { waits, names } = waitsOf(input({ events: [into(1, at(6, 10)), renamed] }));
    expect(waits).toHaveLength(1);
    expect(names.get(id(1))).toBe("renamed");
    const now = waitsOf(
      input({ events: [into(1, at(6, 14))], waitingNow: [{ id: id(1), name: "now-named" }] }),
    );
    expect(now.names.get(id(1))).toBe("now-named");
  });

  test("a session renamed after its last wait is named as the latest poll found it, waiting or not", () => {
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 10)), out(1, at(6, 10, 5))],
        names: new Map([[id(1), "renamed-since"]]),
      }),
    );
    expect(today.sessions[0]).toMatchObject({ sessionId: id(1), name: "renamed-since" });
  });

  test("a wait with no end, of a session not waiting now, that began before this run ends at this run's start", () => {
    // Waiting from 9:10, while Agent Lookout ran until noon. Answered while it
    // was stopped, and idle since it started again at 14:00: no event closes it.
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 9, 10))],
        measured: [
          { from: at(6, 9), to: at(6, 12) },
          { from: at(6, 14), to: NOW },
        ],
        runStarts: [at(6, 9), at(6, 14)],
      }),
    );
    expect(today).toMatchObject({ waitedMs: 2 * HOUR + 50 * MINUTE, openMs: 0, waits: 1 });
    expect(today.sessions[0]).toMatchObject({ open: false });
  });

  test("a wait with no end that began in this run runs to the present, counting only what was measured", () => {
    // Its source stopped answering, so the latest poll does not list it.
    const { today } = waitTotals(
      input({
        events: [into(1, at(6, 14, 10))],
        measured: [{ from: at(6, 14), to: at(6, 14, 40) }],
        runStarts: [at(6, 14)],
      }),
    );
    expect(today).toMatchObject({ waitedMs: 30 * MINUTE, openMs: 0, waits: 1 });
  });

  test("the waits with no end are each session's newest move into needs-you, if nothing after it moved the session out", () => {
    const events = [
      into(1, at(6, 9)),
      out(1, at(6, 9, 5)),
      into(1, at(6, 9, 30)),
      into(2, at(6, 10)),
      out(2, at(6, 10, 5)),
      into(3, at(6, 11)),
      event(3, at(6, 11, 5), "ended", "needs-you"),
      event(4, at(6, 12), "appeared", undefined, "needs-you"),
      event(5, at(6, 12), "status-changed", "working", "idle"),
    ];
    expect(
      unendedWaits(events)
        .map((each) => [each.sessionId, each.at])
        .sort(),
    ).toEqual(
      [
        [id(1), at(6, 9, 30)],
        [id(4), at(6, 12)],
      ].sort(),
    );
  });

  test(`at most ${MAX_WAIT_SESSIONS} sessions are named, longest first, with how many waited in all`, () => {
    const events = Array.from({ length: 12 }, (_, n) => [
      into(n + 1, at(6, 10)),
      out(n + 1, at(6, 10) + (n + 1) * MINUTE),
    ]).flat();
    const { today } = waitTotals(input({ events }));
    expect(today.sessions).toHaveLength(MAX_WAIT_SESSIONS);
    expect(today.sessions[0]).toMatchObject({ name: "project-12", waitedMs: 12 * MINUTE });
    expect(today.sessionCount).toBe(12);
  });
});

describe("a change of the clocks", () => {
  test.each([
    { zone: "Europe/London", change: 25, hours: 25, before: 30 * MINUTE, after: 4 * HOUR },
    { zone: "Australia/Sydney", change: 4, hours: 23, before: 30 * MINUTE, after: 2 * HOUR },
  ])(
    "in $zone the day the clocks change is a day of $hours hours, and a wait across its midnight is split at it",
    ({ zone, change, hours, before, after }) => {
      vi.stubEnv("TZ", zone);
      try {
        const local = (day: number, hour: number, minutes = 0) =>
          new Date(2026, 9, day, hour, minutes).getTime();
        const now = local(change + 2, 12);
        // From 23:30 the night before to 03:00, by the clock on the wall: in
        // London an hour is lived twice that night, and in Sydney one is skipped.
        const { sevenDays } = waitTotals({
          events: [into(1, local(change - 1, 23, 30)), out(1, local(change, 3))],
          measured: [{ from: local(change - 10, 0), to: now }],
          runStarts: [],
          waitingNow: [],
          since: local(change - 10, 0),
          now,
        });
        const days = new Map(sevenDays.days.map((day) => [day.day, day]));
        const dayOf = (day: number) => `2026-10-${String(day).padStart(2, "0")}`;
        expect(sevenDays.days).toHaveLength(7);
        expect(days.get(dayOf(change))?.measuredMs).toBe(hours * HOUR);
        expect(days.get(dayOf(change - 1))?.measuredMs).toBe(24 * HOUR);
        expect(days.get(dayOf(change - 1))).toMatchObject({ waitedMs: before, waits: 1 });
        expect(days.get(dayOf(change))).toMatchObject({ waitedMs: after, waits: 1 });
        expect(sevenDays).toMatchObject({ waitedMs: before + after, waits: 1 });
      } finally {
        vi.stubEnv("TZ", "UTC");
      }
    },
  );
});
