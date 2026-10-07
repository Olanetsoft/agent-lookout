import { describe, expect, test } from "vitest";

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint, Session, SessionEvent, SessionStatus } from "@core/sessions/session";
import {
  measuredNote,
  unmeasuredNote,
  waitedHeading,
  waitedOnYou,
  type WaitsInput,
} from "@dashboard/lib/sessions/waits";
import { makeSession } from "@tests/fixtures/session";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A moment on the local clock, on one ordinary winter day, or the day before. */
const at = (hours: number, minutes: number, seconds = 0, day = 5) =>
  new Date(2026, 0, day, hours, minutes, seconds).getTime();

const NOW = at(14, 32, 30);

/** One point every two seconds, the way the collector polls, from `from` up to and including `to`. */
function polls(from: number, to: number): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (let moment = from; moment <= to; moment += 2 * SECOND) {
    points.push({ at: moment, needsYou: 0, working: 1, idle: 0, total: 1 });
  }
  return points;
}

function history(startedAt: number, ...stretches: HistoryPoint[][]): HistoryResponse {
  return { startedAt, points: stretches.flat() };
}

/** A collector that started at 13:30 and has polled without a break since. */
const watchedSince1330 = () => history(at(13, 30), polls(at(13, 30), NOW));

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: id(n), name: `project-${n}`, startedAt: null, ...overrides });
}

let serial = 0;
function changed(n: number, moment: number, from: SessionStatus, to: SessionStatus): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at: moment,
    sessionId: id(n),
    sessionName: `project-${n}`,
    kind: "status-changed",
    from,
    to,
    severity: to === "needs-you" ? "warning" : "advisory",
  };
}

function ended(n: number, moment: number): SessionEvent {
  return { ...changed(n, moment, "needs-you", "unknown"), kind: "ended", to: undefined };
}

function waits(input: Partial<WaitsInput>) {
  const result = waitedOnYou({
    sessions: [],
    events: [],
    history: watchedSince1330(),
    now: NOW,
    ...input,
  });
  if (!result) throw new Error("Expected the waits to be known.");
  return result;
}

/**
 * Three sessions that waited on the person in the hour:
 *   1  waited 14:00 to 14:05 and 14:20 to 14:22, both answered: 7 minutes
 *   2  has waited since 14:25 and still does: 7 minutes 30 seconds
 *   3  waited 14:10 to 14:11, then went idle: 1 minute
 */
const SESSIONS: Session[] = [
  session(1, { status: "working", statusSince: at(14, 22) }),
  session(2, { status: "needs-you", waitingReason: "permission", statusSince: at(14, 25) }),
  session(3, { status: "idle", statusSince: at(14, 11) }),
];
const EVENTS: SessionEvent[] = [
  changed(1, at(14, 0), "working", "needs-you"),
  changed(1, at(14, 5), "needs-you", "working"),
  changed(3, at(14, 10), "working", "needs-you"),
  changed(3, at(14, 11), "needs-you", "idle"),
  changed(1, at(14, 20), "working", "needs-you"),
  changed(1, at(14, 22), "needs-you", "working"),
  changed(2, at(14, 25), "working", "needs-you"),
];

describe("each session's waits", () => {
  test("are added up per session and listed longest first, with the total", () => {
    const result = waits({ sessions: SESSIONS, events: EVENTS });

    expect(result.sessions.map((s) => [s.name, s.ms, s.open])).toEqual([
      ["project-2", 7 * MINUTE + 30 * SECOND, true],
      ["project-1", 7 * MINUTE, false],
      ["project-3", 1 * MINUTE, false],
    ]);
    expect(result.totalMs).toBe(15 * MINUTE + 30 * SECOND);
    expect(result.sessions.every((s) => s.startKnown)).toBe(true);
  });

  test("are counted: each wait once, the one still open included", () => {
    const result = waits({ sessions: SESSIONS, events: EVENTS });

    expect(result.sessions.map((s) => [s.name, s.times])).toEqual([
      ["project-2", 1],
      ["project-1", 2],
      ["project-3", 1],
    ]);
  });

  test("a wait still open grows with the clock, and stops at the last answer once answers stop", () => {
    const live = waits({ sessions: SESSIONS, events: EVENTS });
    const later = waits({
      sessions: SESSIONS,
      events: EVENTS,
      now: NOW + 30 * SECOND,
      history: history(at(13, 30), polls(at(13, 30), NOW + 30 * SECOND)),
    });
    expect(later.sessions[0]?.ms).toBe((live.sessions[0]?.ms ?? 0) + 30 * SECOND);

    // Answers stopped at 14:30. The clock goes on, and the wait does not.
    const stalled = (now: number) =>
      waits({
        sessions: SESSIONS,
        events: EVENTS,
        now,
        asOf: at(14, 30),
        history: history(at(13, 30), polls(at(13, 30), at(14, 30))),
      });
    const open = (now: number) => stalled(now).sessions.find((s) => s.name === "project-2");
    expect(open(NOW)).toMatchObject({ ms: 5 * MINUTE, open: true });
    expect(open(NOW + 5 * MINUTE)?.ms).toBe(5 * MINUTE);
  });

  test("a wait already under way when the period began is cut there, and its length is a minimum", () => {
    const result = waits({
      sessions: [session(4, { status: "needs-you", statusSince: at(13, 0) })],
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({ ms: NOW - at(13, 32, 30), open: true, startKnown: false }),
    ]);
  });

  test("time nobody measured is left out of a wait that runs across it", () => {
    // Polls broke off from 14:06 to 14:10, in the middle of session 1's wait.
    const result = waits({
      sessions: [session(1, { status: "working", statusSince: at(14, 12) })],
      events: [
        changed(1, at(14, 0), "working", "needs-you"),
        changed(1, at(14, 12), "needs-you", "working"),
      ],
      history: history(at(13, 30), polls(at(13, 30), at(14, 6)), polls(at(14, 10), NOW)),
    });

    expect(result.sessions[0]?.ms).toBe(8 * MINUTE);
    // Nothing was seen to answer it in the break, so it is one wait.
    expect(result.sessions[0]?.times).toBe(1);
  });

  test("a wait answered by a press, while its source still says it waits, is no longer open", () => {
    const answered = SESSIONS.map((s) => (s.id === id(2) ? { ...s, answered: true as const } : s));
    const result = waits({ sessions: answered, events: EVENTS });

    expect(result.sessions.map((s) => [s.name, s.ms, s.open])).toEqual([
      ["project-2", 7 * MINUTE + 30 * SECOND, false],
      ["project-1", 7 * MINUTE, false],
      ["project-3", 1 * MINUTE, false],
    ]);
  });

  test("a wait a rule answered before any poll saw it begin is no wait at all", () => {
    // Working since 14:22 as far as the log goes; its file has said for a second that it waits.
    const result = waits({
      sessions: [
        session(1, {
          status: "needs-you",
          waitingReason: "permission",
          answered: true,
          statusSince: NOW - SECOND,
        }),
      ],
      events: [changed(1, at(14, 22), "idle", "working")],
    });

    expect(result.sessions).toEqual([]);
    expect(result.totalMs).toBe(0);
  });

  test("with nothing waited, there are no bars, no total and no last wait", () => {
    const result = waits({ sessions: [session(1, { status: "working", statusSince: at(14, 0) })] });

    expect(result.sessions).toEqual([]);
    expect(result.totalMs).toBe(0);
    expect(result.lastWait).toBeNull();
    expect(measuredNote(result)).toBe("Measured since 13:32.");
    expect(unmeasuredNote(result)).toBeNull();
  });

  test("without the history nothing can be vouched for", () => {
    expect(waitedOnYou({ sessions: SESSIONS, events: EVENTS, history: null, now: NOW })).toBeNull();
  });
});

describe("time not measured", () => {
  test("each break is counted out and reported: how many, how long, and when the first began", () => {
    const result = waits({
      history: history(
        at(13, 30),
        polls(at(13, 30), at(14, 6)),
        polls(at(14, 10), at(14, 15)),
        polls(at(14, 16), NOW),
      ),
    });

    expect(result.gaps).toEqual([
      { from: at(14, 6), to: at(14, 10) },
      { from: at(14, 15), to: at(14, 16) },
    ]);
    expect(result.unmeasuredMs).toBe(5 * MINUTE);
    expect(measuredNote(result)).toBe(
      "Measured since 13:32, with 5m 00s not measured in 2 breaks, the first after 14:06.",
    );
    expect(unmeasuredNote(result)).toBe("5m 00s not measured in 2 breaks, the first after 14:06");
  });

  test("one break is named by when it began", () => {
    const result = waits({
      history: history(at(13, 30), polls(at(13, 30), at(14, 6)), polls(at(14, 10), NOW)),
    });

    expect(measuredNote(result)).toBe(
      "Measured since 13:32, with 4m 00s not measured after 14:06.",
    );
    // The same, as a fragment, for the quiet hero to say when there are no bars.
    expect(unmeasuredNote(result)).toBe("4m 00s not measured after 14:06");
  });

  test("after the last answer nothing is counted as a break: the page says above it that it stopped", () => {
    const result = waits({
      asOf: at(14, 20),
      history: history(at(13, 30), polls(at(13, 30), at(14, 20))),
    });

    expect(result.gaps).toEqual([]);
    expect(result.unmeasuredMs).toBe(0);
  });
});

describe("the period", () => {
  test("starts when Agent Lookout started, when that is inside the hour the page holds", () => {
    const result = waits({ history: history(at(14, 0), polls(at(14, 0), NOW)) });

    expect(result.period).toEqual({ from: at(14, 0), to: NOW, bound: "started", today: false });
    expect(waitedHeading(result)).toBe("Waited on you since 14:00");
  });

  test("starts at the hour the page holds, when Agent Lookout has run longer", () => {
    const result = waits({ history: history(at(9, 0), polls(at(13, 0), NOW)) });

    expect(result.period).toMatchObject({ from: NOW - 60 * MINUTE, bound: "held" });
  });

  test("starts at the oldest poll held, when the page holds less than an hour of them", () => {
    const result = waits({ history: history(at(9, 0), polls(at(14, 10), NOW)) });

    expect(result.period).toMatchObject({ from: at(14, 10), bound: "held" });
  });

  test("starts at the oldest event once the log is full, since older ones may be gone", () => {
    const events = [changed(1, at(14, 5), "idle", "working")];
    const history9 = history(at(9, 0), polls(at(13, 0), NOW));

    expect(waits({ events, history: history9, eventsFull: true }).period).toMatchObject({
      from: at(14, 5),
      bound: "events",
    });
    // With room in the log, the events say nothing about where it starts.
    expect(waits({ events, history: history9, eventsFull: false }).period.bound).toBe("held");
  });

  test("is today only when it reaches back to local midnight, and then starts there", () => {
    const now = at(0, 40);
    const result = waits({
      now,
      // Watching since 23:00 yesterday, polling since 23:30.
      history: history(at(23, 0, 0, 4), polls(at(23, 30, 0, 4), now)),
      // A wait from 23:50 to 00:10 is counted from midnight, as a minimum.
      sessions: [session(1, { status: "working", statusSince: at(0, 10) })],
      events: [
        changed(1, at(23, 50, 0, 4), "working", "needs-you"),
        changed(1, at(0, 10), "needs-you", "working"),
      ],
    });

    expect(result.period).toEqual({ from: at(0, 0), to: now, bound: "midnight", today: true });
    expect(waitedHeading(result)).toBe("Waited on you today");
    expect(result.sessions[0]).toMatchObject({ ms: 10 * MINUTE, startKnown: false });
    expect(measuredNote(result)).toBe("Measured since 00:00.");
  });

  test("starting exactly at midnight is today", () => {
    const now = at(0, 40);
    const result = waits({ now, history: history(at(0, 0), polls(at(0, 0), now)) });

    expect(result.period.today).toBe(true);
  });

  test("is not today when it starts after midnight, however early", () => {
    const now = at(0, 40);
    const result = waits({ now, history: history(at(0, 10), polls(at(0, 10), now)) });

    expect(result.period.today).toBe(false);
    expect(waitedHeading(result)).toBe("Waited on you since 00:10");
  });
});

describe("the last wait that is over", () => {
  test("is the one over most recently, answered, with its length and when", () => {
    const result = waits({ sessions: SESSIONS, events: EVENTS });

    expect(result.lastWait).toEqual({
      id: id(1),
      name: "project-1",
      ms: 2 * MINUTE,
      startKnown: true,
      at: at(14, 22),
      how: "answered",
    });
  });

  test("a wait ended by stopping the session from Agent Lookout is over when the session left, not at the stop", () => {
    const stopped: SessionEvent = {
      ...changed(5, at(14, 27), "needs-you", "unknown"),
      kind: "stopped",
      to: undefined,
      by: "agent-lookout",
    };
    const result = waits({
      events: [changed(5, at(14, 26), "working", "needs-you"), stopped, ended(5, at(14, 28))],
    });
    expect(result.lastWait).toMatchObject({ ms: 2 * MINUTE, at: at(14, 28), how: "ended" });
  });

  test("is ended, not answered, when the session finished, failed or left while it waited", () => {
    const left = waits({
      events: [changed(5, at(14, 26), "working", "needs-you"), ended(5, at(14, 28))],
    });
    expect(left.lastWait).toMatchObject({ ms: 2 * MINUTE, at: at(14, 28), how: "ended" });

    for (const to of ["finished", "failed"] as const) {
      const over = waits({
        events: [
          changed(5, at(14, 26), "working", "needs-you"),
          changed(5, at(14, 27), "needs-you", to),
        ],
      });
      expect(over.lastWait, to).toMatchObject({ ms: MINUTE, how: "ended" });
    }
  });

  test("when the page does not hold the start of the wait, is offered from the start of the period, its start not known, as the bars count it", () => {
    const result = waits({
      sessions: [session(1, { status: "working", statusSince: at(14, 22) })],
      events: [changed(1, at(14, 22), "needs-you", "working")],
    });

    expect(result.lastWait).toEqual({
      id: id(1),
      name: "project-1",
      ms: at(14, 22) - result.period.from,
      startKnown: false,
      at: at(14, 22),
      how: "answered",
    });
    // The bar for it is the same length.
    expect(result.sessions).toMatchObject([{ id: id(1), ms: at(14, 22) - result.period.from }]);
  });

  test("is not offered from the first event the page holds unless that event ends a wait", () => {
    const result = waits({ events: [changed(1, at(14, 22), "idle", "working")] });

    expect(result.lastWait).toBeNull();
  });

  test("is not one that was over before the period began, or after the last answer", () => {
    const before = waits({
      history: history(at(14, 0), polls(at(14, 0), NOW)),
      events: [
        changed(1, at(13, 50), "working", "needs-you"),
        changed(1, at(13, 55), "needs-you", "working"),
      ],
    });
    expect(before.lastWait).toBeNull();

    const after = waits({
      asOf: at(14, 20),
      history: history(at(13, 30), polls(at(13, 30), at(14, 20))),
      events: [
        changed(1, at(14, 18), "working", "needs-you"),
        changed(1, at(14, 25), "needs-you", "working"),
      ],
    });
    expect(after.lastWait).toBeNull();
  });
});

describe("across a restart of Agent Lookout", () => {
  // The history kept from a run that polled from 13:40 to 14:10, and this run,
  // which started at 14:15 and has polled since: what the collector answers
  // after a restart.
  const RESTART = at(14, 15);
  const acrossRestart = (): HistoryResponse => ({
    startedAt: RESTART,
    since: { at: at(13, 40), by: "started" },
    points: [...polls(at(13, 40), at(14, 10)), ...polls(RESTART, NOW)],
    restarts: [{ at: RESTART, lastBefore: at(14, 10) }],
  });

  test("a wait that began while it was stopped counts from the poll that found it, not from before the stop", () => {
    // Working from 13:41. The first poll after the restart found it waiting,
    // and the collector recorded that then. Its source does not say when.
    const result = waits({
      history: acrossRestart(),
      sessions: [session(1, { status: "needs-you", statusSince: null })],
      events: [
        changed(1, at(13, 41), "idle", "working"),
        changed(1, RESTART, "working", "needs-you"),
      ],
    });
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: id(1), ms: NOW - RESTART, open: true, startKnown: false }),
    ]);
    expect(result.unmeasuredMs).toBe(5 * MINUTE);
  });

  test("a wait that ended while it was stopped is closed by the ending found then, and the stop is not counted", () => {
    const result = waits({
      history: acrossRestart(),
      sessions: [],
      events: [changed(2, at(14, 0), "working", "needs-you"), ended(2, RESTART)],
    });
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: id(2), ms: 10 * MINUTE, open: false }),
    ]);
  });

  test("a session the page holds no event of is not counted as waiting before the restart", () => {
    // Found waiting by the first poll after the restart, and in no event: what
    // it did before is not known.
    const result = waits({
      history: acrossRestart(),
      sessions: [session(3, { status: "needs-you", statusSince: null })],
    });
    expect(result.sessions).toEqual([
      expect.objectContaining({ id: id(3), ms: NOW - RESTART, open: true, startKnown: false }),
    ]);

    // Unless its source says when its wait began.
    const said = waits({
      history: acrossRestart(),
      sessions: [session(3, { status: "needs-you", statusSince: at(14, 5) })],
    });
    expect(said.sessions[0]?.ms).toBe(NOW - at(14, 5));
  });
});
