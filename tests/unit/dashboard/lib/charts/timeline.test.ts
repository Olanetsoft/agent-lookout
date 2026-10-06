import { expect, test } from "vitest";

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint, Session, SessionEvent, SessionStatus } from "@core/sessions/session";
import type { TrackSegment } from "@dashboard/components/ui/charts/StatusTrack";
import {
  buildTimeline,
  TIMELINE_WINDOW_MS,
  type TimelineInput,
} from "@dashboard/lib/charts/timeline";
import { makeSession } from "@tests/fixtures/session";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const NOW = 1_700_000_000_000;
const START = NOW - TIMELINE_WINDOW_MS;

/** A moment so many minutes before the present. */
const ago = (minutes: number) => NOW - minutes * MINUTE;

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function session(n: number, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: id(n),
    name: `project-${n}`,
    startedAt: null,
    statusSince: null,
    ...overrides,
  });
}

/** One point every two seconds, the way the collector polls. */
function polls(from: number, to: number): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (let at = from; at <= to; at += 2 * SECOND) {
    points.push({ at, needsYou: 0, working: 0, idle: 1, total: 1 });
  }
  return points;
}

/** A collector that began so many minutes ago and has polled without a break since. */
function running(minutes: number): HistoryResponse {
  return { startedAt: ago(minutes), points: polls(ago(minutes), NOW) };
}

let serial = 0;
function changed(
  n: number,
  at: number,
  from: SessionStatus,
  to: SessionStatus,
  name = `project-${n}`,
): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at,
    sessionId: id(n),
    sessionName: name,
    kind: "status-changed",
    from,
    to,
    severity: "advisory",
  };
}

function appeared(n: number, at: number, to: SessionStatus): SessionEvent {
  return { ...changed(n, at, "unknown", to), kind: "appeared", from: undefined };
}

function ended(n: number, at: number, from: SessionStatus, name?: string): SessionEvent {
  return { ...changed(n, at, from, "unknown", name), kind: "ended", to: undefined };
}

function timeline(input: Partial<TimelineInput>) {
  return buildTimeline({ sessions: [], events: [], history: running(120), now: NOW, ...input });
}

/** The segments of the only row, or of the row with this number. */
function segmentsOf(input: Partial<TimelineInput>, n?: number): TrackSegment[] {
  const { rows } = timeline(input);
  const row = n === undefined ? rows[0] : rows.find((candidate) => candidate.id === id(n));
  if (!row) throw new Error("no such row");
  return row.segments;
}

/** How long each kind lasts on a row, in whole minutes. */
function minutesByKind(segments: readonly TrackSegment[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const segment of segments) {
    totals[segment.kind] = (totals[segment.kind] ?? 0) + (segment.to - segment.from) / MINUTE;
  }
  return totals;
}

test("the window is the last hour and ends at the present", () => {
  const { start, end } = timeline({});
  expect(end).toBe(NOW);
  expect(start).toBe(START);
});

test("the timeline says which stretches of the window nobody measured", () => {
  expect(timeline({}).unmeasured).toEqual([]);
  expect(timeline({ history: running(10) }).unmeasured).toEqual([{ from: START, to: ago(10) }]);

  const broken = running(120);
  const points = broken.points.filter((point) => point.at <= ago(40) || point.at >= ago(30));
  expect(timeline({ history: { ...broken, points } }).unmeasured).toEqual([
    { from: ago(40), to: ago(30) },
  ]);
});

test("a session with no events has had its present status for as long as anyone was looking", () => {
  const segments = segmentsOf({ sessions: [session(1, { status: "working" })] });
  expect(segments).toEqual([
    { from: START, to: NOW, kind: "working", startKnown: false, ongoing: true },
  ]);
});

test("an idle session with no status time, on a collector that began ten minutes ago, is not drawn as idle before that", () => {
  const segments = segmentsOf({ sessions: [session(1)], history: running(10) });
  expect(segments).toEqual([
    { from: START, to: ago(10), kind: "unmeasured", startKnown: false },
    { from: ago(10), to: NOW, kind: "idle", startKnown: false, ongoing: true },
  ]);
  expect(minutesByKind(segments)).toEqual({ unmeasured: 50, idle: 10 });
});

test("across a restart, a session with no events is not drawn with its present status before the restart, though the run before was polling", () => {
  // The history kept from a run that polled until 30 minutes ago, and this
  // run, which started 20 minutes ago.
  const history: HistoryResponse = {
    startedAt: ago(20),
    since: { at: ago(120), by: "started" },
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
    restarts: [{ at: ago(20), lastBefore: ago(30) }],
  };
  const segments = segmentsOf({ sessions: [session(1, { status: "needs-you" })], history });
  expect(segments).toEqual([
    { from: START, to: ago(20), kind: "unmeasured", startKnown: false },
    { from: ago(20), to: NOW, kind: "needs-you", startKnown: false, ongoing: true, open: true },
  ]);

  // A session that started during this run is drawn from its start, as ever.
  const late = segmentsOf({
    sessions: [session(2, { status: "working", startedAt: ago(10) })],
    history,
  });
  expect(late).toEqual([
    { from: ago(10), to: NOW, kind: "working", startKnown: true, ongoing: true },
  ]);

  // And one whose source says when its status began is drawn from then.
  const said = segmentsOf({
    sessions: [session(3, { status: "working", statusSince: ago(50) })],
    history,
  });
  expect(minutesByKind(said)).toEqual({ unmeasured: 10, working: 50 });
});

test("the present status reaches back to when its source says it began, past the collector's start", () => {
  const segments = segmentsOf({
    sessions: [session(1, { statusSince: ago(40) })],
    history: running(10),
  });
  expect(segments).toEqual([
    { from: START, to: ago(40), kind: "unmeasured", startKnown: false },
    { from: ago(40), to: NOW, kind: "idle", startKnown: true, ongoing: true },
  ]);
});

test("a status that began before the window is cut at its edge, and its start is then not known", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "needs-you", statusSince: ago(180) })],
    history: running(10),
  });
  expect(segments).toEqual([
    { from: START, to: NOW, kind: "needs-you", startKnown: false, ongoing: true, open: true },
  ]);
});

test("the present status never reaches back past the session's last event", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle", statusSince: ago(50) })],
    events: [changed(1, ago(20), "working", "idle")],
  });
  expect(segments).toEqual([
    { from: START, to: ago(20), kind: "working", startKnown: false },
    { from: ago(20), to: NOW, kind: "idle", startKnown: true, ongoing: true },
  ]);
});

test("between two events the status comes from them, and before the first it is what that event changed from", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "needs-you" })],
    events: [
      // Newest first, the way the page holds them.
      changed(1, ago(5), "working", "needs-you"),
      changed(1, ago(30), "idle", "working"),
    ],
  });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "idle", startKnown: false },
    { from: ago(30), to: ago(5), kind: "working", startKnown: true },
    { from: ago(5), to: NOW, kind: "needs-you", startKnown: true, ongoing: true, open: true },
  ]);
});

test("a session that appeared inside the window has nothing drawn before it appeared", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "working" })],
    events: [appeared(1, ago(15), "working")],
  });
  expect(segments).toEqual([
    { from: ago(15), to: NOW, kind: "working", startKnown: true, ongoing: true },
  ]);
});

test("a session that started before the collector is not measured from its start to the collector's", () => {
  const segments = segmentsOf({
    sessions: [session(1, { startedAt: ago(30) })],
    history: running(10),
  });
  expect(segments).toEqual([
    { from: ago(30), to: ago(10), kind: "unmeasured", startKnown: true },
    { from: ago(10), to: NOW, kind: "idle", startKnown: false, ongoing: true },
  ]);
});

test("a break in the polls is not measured, and a status is not drawn across it", () => {
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
  };
  const segments = segmentsOf({ sessions: [session(1, { status: "working" })], history });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "working", startKnown: false },
    { from: ago(30), to: ago(20), kind: "unmeasured", startKnown: true },
    { from: ago(20), to: NOW, kind: "working", startKnown: false, ongoing: true },
  ]);
});

test("a status its source vouches for is drawn across a break in the polls", () => {
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
  };
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle", statusSince: ago(45) })],
    events: [changed(1, ago(45), "working", "idle")],
    history,
  });
  expect(segments).toEqual([
    { from: START, to: ago(45), kind: "working", startKnown: false },
    { from: ago(45), to: NOW, kind: "idle", startKnown: true, ongoing: true },
  ]);
});

test("a change found by the first poll after a break has no known start", () => {
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
  };
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle" })],
    events: [changed(1, ago(20), "working", "idle")],
    history,
  });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "working", startKnown: false },
    { from: ago(30), to: ago(20), kind: "unmeasured", startKnown: true },
    { from: ago(20), to: NOW, kind: "idle", startKnown: false, ongoing: true },
  ]);
});

test("polls up to eight seconds apart are one run, and further apart are a break", () => {
  const at = (seconds: number) => NOW - seconds * SECOND;
  const point = (seconds: number): HistoryPoint => ({
    at: at(seconds),
    needsYou: 0,
    working: 1,
    idle: 0,
    total: 1,
  });
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), at(60)), point(52), point(40), point(38), ...polls(at(36), NOW)],
  };
  const kinds = segmentsOf({ sessions: [session(1, { status: "working" })], history }).map(
    (segment) => [segment.kind, segment.from, segment.to],
  );
  expect(kinds).toEqual([
    ["working", START, at(52)],
    ["unmeasured", at(52), at(40)],
    ["working", at(40), NOW],
  ]);
});

test("with no history at all, only what a source vouches for is drawn", () => {
  const { rows } = timeline({
    sessions: [
      session(1, { status: "working", statusSince: ago(12) }),
      session(2, { status: "idle" }),
    ],
    history: null,
  });
  expect(rows.map((row) => row.segments)).toEqual([
    [
      { from: START, to: ago(12), kind: "unmeasured", startKnown: false },
      { from: ago(12), to: NOW, kind: "working", startKnown: true, ongoing: true },
    ],
    [{ from: START, to: NOW, kind: "unmeasured", startKnown: false, ongoing: true }],
  ]);
});

test("once the page stops getting answers, time after the last one is not measured", () => {
  const lastAnswer = ago(3);
  const history: HistoryResponse = { startedAt: ago(120), points: polls(ago(120), lastAnswer) };
  const { rows } = timeline({
    sessions: [
      session(1, { status: "working" }),
      session(2, { status: "needs-you", statusSince: ago(10) }),
    ],
    events: [changed(2, ago(10), "working", "needs-you")],
    history,
    asOf: lastAnswer,
  });
  expect(rows.find((row) => row.id === id(1))?.segments).toEqual([
    { from: START, to: lastAnswer, kind: "working", startKnown: false },
    { from: lastAnswer, to: NOW, kind: "unmeasured", startKnown: true, ongoing: true },
  ]);
  // Even a status its source vouched for is only known up to the last answer.
  // A wait cut there was not answered: as far as anyone knows it is still open.
  // But it is not ongoing: only the stretch after the last answer reaches now.
  expect(rows.find((row) => row.id === id(2))?.segments).toEqual([
    { from: START, to: ago(10), kind: "working", startKnown: false },
    { from: ago(10), to: lastAnswer, kind: "needs-you", startKnown: true, open: true },
    { from: lastAnswer, to: NOW, kind: "unmeasured", startKnown: true, ongoing: true },
  ]);
});

test("a full event list moves the start of what can be vouched for to its oldest event", () => {
  const events = [changed(1, ago(25), "working", "idle"), changed(2, ago(40), "idle", "working")];
  const sessions = [session(1, { status: "idle" }), session(2, { status: "working" })];

  const partial = segmentsOf({ sessions, events }, 1);
  expect(partial[0]).toEqual({ from: START, to: ago(25), kind: "working", startKnown: false });

  const full = segmentsOf({ sessions, events, eventsFull: true }, 1);
  expect(full).toEqual([
    { from: START, to: ago(40), kind: "unmeasured", startKnown: false },
    { from: ago(40), to: ago(25), kind: "working", startKnown: false },
    { from: ago(25), to: NOW, kind: "idle", startKnown: true, ongoing: true },
  ]);
});

test("a session that ended keeps a row that stops at its ending, named from its events", () => {
  const { rows } = timeline({
    sessions: [session(1)],
    events: [
      ended(2, ago(10), "idle", "old-project"),
      changed(2, ago(35), "working", "idle", "old-project"),
    ],
  });
  expect(rows.map((row) => [row.name, row.ended])).toEqual([
    ["project-1", false],
    ["old-project", true],
  ]);
  expect(rows[1]?.segments).toEqual([
    { from: START, to: ago(35), kind: "working", startKnown: false },
    { from: ago(35), to: ago(10), kind: "idle", startKnown: true },
  ]);
});

test("a session that ended before the window, or that is listed again, gets no ended row", () => {
  const { rows } = timeline({
    sessions: [session(1)],
    events: [ended(2, ago(70), "idle"), ended(1, ago(20), "idle"), appeared(1, ago(15), "idle")],
  });
  expect(rows.map((row) => row.id)).toEqual([id(1)]);
  // The time between its ending and its return is empty, not idle.
  expect(rows[0]?.segments).toEqual([
    { from: START, to: ago(20), kind: "idle", startKnown: false },
    { from: ago(15), to: NOW, kind: "idle", startKnown: true, ongoing: true },
  ]);
});

test("rows follow the Sessions list, then ended sessions, most recently ended first", () => {
  const { rows } = timeline({
    sessions: [
      session(1, { status: "idle", name: "idle-one" }),
      session(2, { status: "working", name: "working-one" }),
      session(3, { status: "needs-you", name: "blocked-one" }),
      session(4, { status: "failed", name: "failed-one" }),
      session(5, { status: "finished", name: "finished-one" }),
    ],
    events: [ended(6, ago(30), "idle", "ended-earlier"), ended(7, ago(5), "idle", "ended-later")],
  });
  expect(rows.map((row) => row.name)).toEqual([
    "blocked-one",
    "working-one",
    "idle-one",
    "failed-one",
    "finished-one",
    "ended-later",
    "ended-earlier",
  ]);
});

test("a status the source restarted the clock on is split where the source says, not redrawn", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "needs-you", statusSince: ago(5) })],
    events: [changed(1, ago(30), "working", "needs-you")],
  });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "working", startKnown: false },
    { from: ago(30), to: ago(5), kind: "needs-you", startKnown: true },
    { from: ago(5), to: NOW, kind: "needs-you", startKnown: true, ongoing: true, open: true },
  ]);
});

test("an event with no status in it is drawn as unknown, never guessed", () => {
  const event: SessionEvent = { ...changed(1, ago(20), "idle", "working"), from: undefined };
  const segments = segmentsOf({ sessions: [session(1, { status: "working" })], events: [event] });
  expect(segments.map((segment) => segment.kind)).toEqual(["unknown", "working"]);
});

test("segments are in time order and never overlap", () => {
  const { rows } = timeline({
    sessions: [session(1, { status: "working", statusSince: ago(2), startedAt: ago(50) })],
    events: [
      changed(1, ago(2), "idle", "working"),
      changed(1, ago(12), "working", "idle"),
      changed(1, ago(40), "idle", "working"),
    ],
    history: {
      startedAt: ago(45),
      points: [...polls(ago(45), ago(25)), ...polls(ago(18), NOW)],
    },
  });
  const segments = rows[0]?.segments ?? [];
  expect(segments.length).toBeGreaterThan(3);
  segments.forEach((segment, index) => {
    expect(segment.to).toBeGreaterThan(segment.from);
    const next = segments[index + 1];
    if (next) expect(next.from).toBeGreaterThanOrEqual(segment.to);
  });
  expect(segments[0]?.from).toBe(ago(50));
  expect(segments[segments.length - 1]?.to).toBe(NOW);
});

test("each row is not measured only where its own status is not known", () => {
  const { rows } = timeline({
    sessions: [
      session(1, { status: "working", statusSince: ago(40) }),
      session(2, { status: "working" }),
      session(3, { status: "idle", statusSince: ago(90) }),
    ],
    history: running(10),
  });
  // Watching began ten minutes ago. Over the fifty before, the one whose source
  // vouches for forty of them is not measured for ten, the one with no word is
  // not measured for all fifty, and the one vouched for since before the window
  // is not measured at all.
  const minutesOf = (n: number) =>
    minutesByKind(rows.find((row) => row.id === id(n))?.segments ?? []);
  expect(minutesOf(1)).toEqual({ unmeasured: 20, working: 40 });
  expect(minutesOf(2)).toEqual({ unmeasured: 50, working: 10 });
  expect(minutesOf(3)).toEqual({ idle: 60 });
});

test("a session that appeared with no start time is not measured before watching began, and absent while it was watched", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "working" })],
    events: [appeared(1, ago(10), "working")],
    history: running(30),
  });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "unmeasured", startKnown: false },
    { from: ago(10), to: NOW, kind: "working", startKnown: true, ongoing: true },
  ]);
});

test("a session that appeared after a break in the polls is not measured across the break", () => {
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
  };
  const segments = segmentsOf({
    sessions: [session(1, { status: "working" })],
    events: [appeared(1, ago(20), "working")],
    history,
  });
  // It may have started at any time in the break, so its start is not known
  // either. Before the break, polls saw that it was not there.
  expect(segments).toEqual([
    { from: ago(30), to: ago(20), kind: "unmeasured", startKnown: true },
    { from: ago(20), to: NOW, kind: "working", startKnown: false, ongoing: true },
  ]);
});

test("a session back after it ended is not measured across a break in between", () => {
  const history: HistoryResponse = {
    startedAt: ago(120),
    points: [...polls(ago(120), ago(30)), ...polls(ago(20), NOW)],
  };
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle" })],
    events: [appeared(1, ago(20), "idle"), ended(1, ago(35), "idle")],
    history,
  });
  expect(segments).toEqual([
    { from: START, to: ago(35), kind: "idle", startKnown: false },
    { from: ago(30), to: ago(20), kind: "unmeasured", startKnown: true },
    { from: ago(20), to: NOW, kind: "idle", startKnown: false, ongoing: true },
  ]);
});

test("a wait that was answered is neither open nor ongoing, and one still open is both", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "needs-you" })],
    events: [
      changed(1, ago(5), "working", "needs-you"),
      changed(1, ago(20), "needs-you", "working"),
      changed(1, ago(25), "working", "needs-you"),
    ],
  });
  const waits = segments.filter((segment) => segment.kind === "needs-you");
  expect(waits).toEqual([
    { from: ago(25), to: ago(20), kind: "needs-you", startKnown: true },
    { from: ago(5), to: NOW, kind: "needs-you", startKnown: true, ongoing: true, open: true },
  ]);
});

test("a stale session's idle stretch is idle until the stale threshold and stale after it", () => {
  // Idle since 24 hours and 30 minutes ago, so it turned stale 30 minutes ago.
  const since = NOW - 24.5 * 60 * MINUTE;
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle", statusSince: since, stale: true })],
  });
  expect(segments).toEqual([
    { from: START, to: ago(30), kind: "idle", startKnown: false },
    { from: ago(30), to: NOW, kind: "stale", startKnown: true, ongoing: true },
  ]);
});

test("a session stale since before the window is stale across all of it", () => {
  const segments = segmentsOf({
    sessions: [session(1, { status: "idle", statusSince: ago(3 * 24 * 60), stale: true })],
  });
  expect(segments).toEqual([
    { from: START, to: NOW, kind: "stale", startKnown: false, ongoing: true },
  ]);
});

test("a row says what a listed session is doing now, and nothing for one that ended", () => {
  const { rows } = timeline({
    sessions: [
      session(1, { status: "idle", stale: true, statusSince: ago(3 * 24 * 60) }),
      session(2, { status: "needs-you" }),
    ],
    events: [ended(3, ago(10), "idle", "old-project")],
  });
  expect(rows.map((row) => [row.name, row.status, row.stale])).toEqual([
    ["project-2", "needs-you", false],
    ["project-1", "idle", true],
    ["old-project", null, false],
  ]);
});
