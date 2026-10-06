import { expect, test } from "vitest";

import type { SessionEvent, SessionStatus } from "@core/sessions/session";
import {
  logEntries,
  logRows,
  logStart,
  watchGaps,
  type LogEntry,
} from "@dashboard/lib/events/events";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

const id = (n: number) => `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let serial = 0;
function changed(n: number, at: number, from: SessionStatus, to: SessionStatus): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at,
    sessionId: id(n),
    sessionName: `project-${n}`,
    kind: "status-changed",
    from,
    to,
    severity: to === "needs-you" ? "warning" : "advisory",
  };
}

const listed = (n: number, status: SessionStatus) => ({ id: id(n), status });

test("a wait is open while its session is listed as needing the person and it is that session's newest event", () => {
  const wait = changed(1, ago(2), "working", "needs-you");
  const [entry] = logEntries([wait], [listed(1, "needs-you")]);

  expect(entry).toMatchObject({ mark: "needs-you", open: true, waitedMs: null });
});

test("a wait that a later event followed is answered, even while the session waits again", () => {
  const first = changed(1, ago(30), "working", "needs-you");
  const answer = changed(1, ago(28), "needs-you", "working");
  const again = changed(1, ago(2), "working", "needs-you");
  const entries = logEntries([again, answer, first], [listed(1, "needs-you")]);

  expect(entries.map((entry) => [entry.mark, entry.open])).toEqual([
    ["needs-you", true],
    ["working", false],
    ["answered", false],
  ]);
});

test("a wait whose session is no longer listed as needing the person is answered", () => {
  const wait = changed(1, ago(2), "working", "needs-you");

  expect(logEntries([wait], [listed(1, "working")])[0]).toMatchObject({
    mark: "answered",
    open: false,
  });
  // A session that has left the list is not waiting either.
  expect(logEntries([wait], [])[0]).toMatchObject({ mark: "answered", open: false });
});

test("a move out of a wait says how long it lasted when the event that began it is held", () => {
  const wait = changed(1, ago(30), "working", "needs-you");
  const answer = changed(1, ago(28), "needs-you", "working");
  const [answered] = logEntries([answer, wait], [listed(1, "working")]);

  expect(answered).toMatchObject({ mark: "working", waitedMs: 2 * MINUTE });
  // Without the start of the wait, its length is not known.
  expect(logEntries([answer], [listed(1, "working")])[0]?.waitedMs).toBeNull();
});

test("the start of a wait is the session's own event, not another session's", () => {
  const otherWait = changed(2, ago(29), "working", "needs-you");
  const answer = changed(1, ago(28), "needs-you", "working");
  const before = changed(1, ago(40), "idle", "working");
  const [entry] = logEntries([answer, otherWait, before], []);

  expect(entry?.waitedMs).toBeNull();
});

test("the mark is the status the event moved to, and an ending with no status has the ended mark", () => {
  const entries = logEntries(
    [
      { ...changed(1, ago(1), "working", "idle"), kind: "ended", to: undefined },
      { ...changed(2, ago(2), "idle", "working"), kind: "appeared", from: undefined },
      changed(3, ago(3), "working", "finished"),
      changed(4, ago(4), "working", "failed"),
      { ...changed(5, ago(5), "idle", "working"), to: undefined },
    ],
    [],
  );

  expect(entries.map((entry) => entry.mark)).toEqual([
    "ended",
    "working",
    "finished",
    "failed",
    "unknown",
  ]);
});

test("while the log has room, it starts where Agent Lookout started watching", () => {
  const events = [changed(1, ago(2), "idle", "working")];

  expect(logStart(events, { startedAt: ago(40) }, false)).toEqual({
    at: ago(40),
    started: true,
  });
  // With no events yet, the start is still known.
  expect(logStart([], { startedAt: ago(40) }, false)).toEqual({ at: ago(40), started: true });
});

test("once the log is full it claims only as far back as its oldest event, and no start", () => {
  const events = [changed(1, ago(2), "idle", "working"), changed(1, ago(9), "working", "idle")];

  expect(logStart(events, { startedAt: ago(40) }, true)).toEqual({ at: ago(9), started: false });
});

test("since the history was cleared, a log with room starts there, and says it was cleared", () => {
  const events = [changed(1, ago(2), "idle", "working")];
  const history = { startedAt: ago(40), since: { at: ago(10), by: "cleared" as const } };

  expect(logStart(events, history, false)).toEqual({ at: ago(10), started: true, cleared: true });
  // Full, it claims only its oldest event, as ever.
  expect(logStart(events, history, true)).toEqual({ at: ago(2), started: false });
});

test("with history kept from before this run, a log with room starts where the history kept began", () => {
  const events = [changed(1, ago(2), "idle", "working")];
  const kept = { startedAt: ago(5), since: { at: ago(3 * 24 * 60), by: "started" as const } };
  expect(logStart(events, kept, false)).toEqual({ at: ago(3 * 24 * 60), started: true });

  // Where what came before was let go, it reaches that far and claims no start.
  const trimmed = { startedAt: ago(5), since: { at: ago(8 * 24 * 60), by: "trimmed" as const } };
  expect(logStart(events, trimmed, false)).toEqual({ at: ago(8 * 24 * 60), started: false });
});

test("without the history's start, a log with room claims nothing", () => {
  expect(logStart([changed(1, ago(2), "idle", "working")], null, false)).toBeNull();
});

/** Polls every two seconds from `from` up to and including `to`. */
function polls(from: number, to: number) {
  const points = [];
  for (let at = from; at <= to; at += 2_000) {
    points.push({ at, needsYou: 0, working: 1, idle: 0, total: 1 });
  }
  return points;
}

test("each break in the polls longer than the gap is a moment watching resumed, with how long was not measured, newest first", () => {
  const history = {
    startedAt: ago(50),
    points: [...polls(ago(50), ago(40)), ...polls(ago(36), ago(20)), ...polls(ago(19), NOW)],
  };

  expect(watchGaps(history, 8_000)).toEqual([
    { at: ago(19), unmeasuredMs: MINUTE },
    { at: ago(36), unmeasuredMs: 4 * MINUTE },
  ]);
});

test("a break no longer than the gap is not a break", () => {
  const points = [...polls(ago(10), ago(5)), ...polls(ago(5) + 8_000, NOW)];

  expect(watchGaps({ startedAt: ago(10), points }, 8_000)).toEqual([]);
  // One millisecond more is.
  const longer = [...polls(ago(10), ago(5)), ...polls(ago(5) + 8_001, NOW)];
  expect(watchGaps({ startedAt: ago(10), points: longer }, 8_000)).toEqual([
    { at: ago(5) + 8_001, unmeasuredMs: 8_001 },
  ]);
});

test("the edge of the history held is not a break, and nor is anything before Agent Lookout started", () => {
  // The page holds polls from 40 minutes ago: nothing says what came before.
  expect(watchGaps({ startedAt: ago(90), points: polls(ago(40), NOW) }, 8_000)).toEqual([]);

  // Points from before this start, then a pause, then this run: the pause is
  // the time before it started, not a break in its watching.
  const restarted = {
    startedAt: ago(20),
    points: [...polls(ago(40), ago(30)), ...polls(ago(20), NOW)],
  };
  expect(watchGaps(restarted, 8_000)).toEqual([]);
});

test("each restart is a break, from the newest moment before it, however short or long ago", () => {
  // The page holds the last hour of polls. Agent Lookout was stopped from
  // 70 minutes ago to 20 minutes ago, and for three seconds 10 minutes ago.
  const history = {
    startedAt: ago(10) + 3_000,
    since: { at: ago(300), by: "started" as const },
    points: [...polls(ago(20), ago(10)), ...polls(ago(10) + 3_500, NOW)],
    restarts: [
      { at: ago(20), lastBefore: ago(70) },
      { at: ago(10) + 3_000, lastBefore: ago(10) },
    ],
  };
  expect(watchGaps(history, 8_000)).toEqual([
    { at: ago(10) + 3_000, unmeasuredMs: 3_000 },
    { at: ago(20), unmeasuredMs: 50 * MINUTE },
  ]);
});

test("a restart the polls already show as a break is said once, at the poll that ended it", () => {
  const history = {
    startedAt: ago(20),
    since: { at: ago(40), by: "started" as const },
    points: [...polls(ago(40), ago(30)), ...polls(ago(20) + 1_000, NOW)],
    restarts: [{ at: ago(20), lastBefore: ago(30) }],
  };
  expect(watchGaps(history, 8_000)).toEqual([
    { at: ago(20) + 1_000, unmeasuredMs: 10 * MINUTE + 1_000 },
  ]);
});

test("a restart before where the history begins is not a break of it", () => {
  const history = {
    startedAt: ago(5),
    since: { at: ago(15), by: "cleared" as const },
    points: polls(ago(5), NOW),
    restarts: [
      { at: ago(15), lastBefore: ago(30) },
      { at: ago(5), lastBefore: ago(6) },
    ],
  };
  expect(watchGaps(history, 8_000)).toEqual([{ at: ago(5), unmeasuredMs: MINUTE }]);
});

test("without the history, or its points, there are no breaks", () => {
  expect(watchGaps(null)).toEqual([]);
  expect(watchGaps({ startedAt: ago(10) })).toEqual([]);
  // Restarts alone are breaks all the same.
  expect(
    watchGaps({
      startedAt: ago(10),
      since: { at: ago(30), by: "started" },
      restarts: [{ at: ago(10), lastBefore: ago(12) }],
    }),
  ).toEqual([{ at: ago(10), unmeasuredMs: 2 * MINUTE }]);
});

test("a break sits below the events that share its time, and among the rest by time", () => {
  const entries: LogEntry[] = logEntries(
    [
      changed(1, ago(2), "idle", "working"),
      changed(2, ago(19), "working", "idle"),
      changed(1, ago(19), "working", "idle"),
      changed(3, ago(30), "idle", "working"),
    ],
    [],
  );
  const gaps = [
    { at: ago(19), unmeasuredMs: MINUTE },
    { at: ago(36), unmeasuredMs: 4 * MINUTE },
  ];

  const rows = logRows(entries, gaps).map((row) =>
    row.kind === "event"
      ? `event ${row.entry.event.sessionName}`
      : `resumed ${row.gap.unmeasuredMs / MINUTE}m`,
  );
  expect(rows).toEqual([
    "event project-1",
    // Found by the poll that ended the break, so they happened during it or as it ended.
    "event project-2",
    "event project-1",
    "resumed 1m",
    "event project-3",
    "resumed 4m",
  ]);
});

test("a break newer than every event comes first, and with no events the breaks are the log", () => {
  const entries = logEntries([changed(1, ago(30), "idle", "working")], []);

  expect(logRows(entries, [{ at: ago(5), unmeasuredMs: MINUTE }]).map((row) => row.kind)).toEqual([
    "resumed",
    "event",
  ]);
  expect(logRows([], [{ at: ago(5), unmeasuredMs: MINUTE }])).toEqual([
    { kind: "resumed", gap: { at: ago(5), unmeasuredMs: MINUTE } },
  ]);
});

test("a restart under history kept on disk is a break like any other: the time it was not running was not measured", () => {
  // The last run stopped 30 minutes ago, and this one started 20 minutes ago.
  const history = {
    startedAt: ago(20),
    since: { at: ago(50), by: "started" as const },
    points: [...polls(ago(50), ago(30)), ...polls(ago(20), NOW)],
  };
  expect(watchGaps(history, 8_000)).toEqual([{ at: ago(20), unmeasuredMs: 10 * MINUTE }]);
});

test("nothing before the history was cleared is a break", () => {
  const history = {
    startedAt: ago(50),
    since: { at: ago(20), by: "cleared" as const },
    points: [...polls(ago(50), ago(30)), ...polls(ago(20), NOW)],
  };
  expect(watchGaps(history, 8_000)).toEqual([]);
});
