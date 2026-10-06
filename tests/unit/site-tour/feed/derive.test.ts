import { describe, expect, test } from "vitest";

import { historyPointFor } from "@core/history";
import { readEvents, readHistory, readSnapshot, readWaits } from "@dashboard/lib/api/readApi";
import { countState } from "@dashboard/lib/sessions/sessions";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import { createFeed, HOLD_MS, POLL_MS, type Shown } from "@site-tour/feed/derive";
import {
  MACHINE,
  RESUMED_AT,
  SESSIONS,
  STOPPED_AT,
  WAIT_STARTS,
  WAITING_SESSION,
  WATCHING_SINCE,
} from "@site-tour/feed/hour";
import { weekBefore } from "@site-tour/feed/week";

const T0 = Date.UTC(2026, 9, 5, 8, 12, 0);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * HOUR;

/** The present a little after the tour loaded, as a visitor reaches each scene. */
const NOW = T0 + 37_000;
/** When the visitor moved on from the wait, before NOW. */
const LEFT = T0 + 22_000;

const SHOWN: readonly [string, Shown][] = [
  ["quiet", { moment: "quiet" }],
  ["waiting", { moment: "waiting" }],
  ["answered, never seen waiting", { moment: "answered" }],
  ["answered as the visitor moved on", { moment: "answered", answeredAt: LEFT }],
];

describe.each(SHOWN)("at the %s moment", (_name, shown) => {
  const feed = createFeed(T0);

  test("each answer is read by the dashboard exactly as it was sent", () => {
    const snapshot = feed.snapshot(shown, NOW);
    const events = feed.events(shown);
    const history = feed.history(shown, NOW, HOUR);
    expect(readSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(readEvents(JSON.parse(JSON.stringify({ events })))).toEqual(events);
    expect(readHistory(JSON.parse(JSON.stringify(history)))).toEqual(history);
  });

  test("the history goes on to the present with the counts the sessions have", () => {
    const snapshot = feed.snapshot(shown, NOW);
    const points = feed.history(shown, NOW, HOUR).points;
    const last = points.at(-1)!;
    expect(NOW - last.at).toBeLessThan(POLL_MS);
    expect({ ...last, at: 0 }).toEqual(historyPointFor(snapshot.sessions, 0));
    for (let i = 1; i < points.length; i++) expect(points[i].at).toBeGreaterThan(points[i - 1].at);
    // After the stop, a point at least every poll, through the end of the hour and on.
    const resumed = points.filter((point) => point.at >= T0 + RESUMED_AT);
    for (let i = 1; i < resumed.length; i++) {
      expect(resumed[i].at - resumed[i - 1].at).toBeLessThanOrEqual(POLL_MS);
    }
  });

  test("what a waiting session asks is in the snapshot alone", () => {
    const events = JSON.stringify(feed.events(shown));
    const history = JSON.stringify(feed.history(shown, NOW, HOUR));
    expect(events).not.toContain("waitingText");
    expect(history).not.toContain("waitingText");
  });

  test("showing it again, after other moments, shows it as it was", () => {
    const first = feed.snapshot(shown, NOW);
    const firstEvents = feed.events(shown);
    for (const [, other] of SHOWN) feed.snapshot(other, NOW + 5_000);
    expect(feed.snapshot(shown, NOW)).toEqual(first);
    expect(feed.events(shown)).toEqual(firstEvents);
    expect(createFeed(T0).snapshot(shown, NOW)).toEqual(first);
  });

  test("no Codex session needs you", () => {
    for (const session of feed.snapshot(shown, NOW).sessions) {
      if (session.source === "codex") expect(session.status).not.toBe("needs-you");
    }
  });
});

test("no Codex session ever needs you, at any moment of the hour", () => {
  for (const session of SESSIONS) {
    if (session.source !== "codex") continue;
    expect(session.steps.map((step) => step.status)).not.toContain("needs-you");
  }
});

test("with nothing waiting, ten sessions: six working, two idle, one stale and one finished", () => {
  const snapshot = createFeed(T0).snapshot({ moment: "quiet" }, NOW);
  const counts = countState(snapshot.sessions, snapshot.sources);
  expect(snapshot.sessions).toHaveLength(10);
  expect(snapshot.sessions.filter((session) => session.status === "needs-you")).toHaveLength(0);
  expect(counts.summary).toMatchObject({ total: 10, working: 6, idle: 2, stale: 1 });
  expect(snapshot.sessions.filter((session) => session.source === "status-files")).toHaveLength(1);
});

test("while one waits, it is checkout-flow, asking to run npm test, since the wait began", () => {
  const snapshot = createFeed(T0).snapshot({ moment: "waiting" }, NOW);
  const waiting = snapshot.sessions.filter((session) => session.status === "needs-you");
  expect(waiting).toHaveLength(1);
  expect(waiting[0]).toMatchObject({
    id: WAITING_SESSION,
    name: "checkout-flow",
    waitingReason: "permission",
    waitingText: "Run: npm test",
    statusSince: T0 + WAIT_STARTS,
    jump: { kind: "terminal", app: "Terminal" },
  });
});

test("with the plugin, the wait's whole command is held, with Allow offered, and it can be answered", () => {
  const snapshot = createFeed(T0).snapshot({ moment: "waiting" }, NOW);
  expect(snapshot.answering).toEqual({ state: "on", plugin: "seen", holdMs: HOLD_MS });
  const waiting = snapshot.sessions.find((session) => session.id === WAITING_SESSION)!;
  expect(waiting.ask).toMatchObject({ tool: "Bash", command: "npm test", allow: true });
  expect(waiting.ask!.until).toBeGreaterThan(NOW);
  // Nothing else holds a request: no other session waits, and a machine's never would here.
  const others = snapshot.sessions.filter((session) => session.id !== WAITING_SESSION);
  expect(others.every((session) => session.ask === undefined)).toBe(true);
});

test("a request is held only while its session waits, and is never in the log or the history", () => {
  const feed = createFeed(T0);
  for (const shown of [{ moment: "quiet" }, { moment: "answered", answeredAt: LEFT }] as const) {
    expect(feed.snapshot(shown, NOW).sessions.every((session) => session.ask === undefined)).toBe(
      true,
    );
  }
  const waiting: Shown = { moment: "waiting" };
  expect(JSON.stringify(feed.events(waiting))).not.toContain('"ask"');
  expect(JSON.stringify(feed.history(waiting, NOW, HOUR))).not.toContain('"ask"');
});

test("a wait answered from the dashboard is in the log as Agent Lookout's answer, with what was pressed", () => {
  const feed = createFeed(T0);
  for (const decision of ["allow", "deny"] as const) {
    const events = feed.events({ moment: "answered", answeredAt: LEFT, decision });
    expect(events[0]).toMatchObject({ kind: "status-changed", from: "needs-you", to: "working" });
    expect(events[1]).toMatchObject({
      kind: "answered",
      sessionId: WAITING_SESSION,
      at: LEFT,
      by: "agent-lookout",
      decision,
    });
    expect(readEvents(JSON.parse(JSON.stringify({ events })))).toEqual(events);
  }
  // Answered by moving on, nobody pressed anything.
  const moved = feed.events({ moment: "answered", answeredAt: LEFT });
  expect(moved.some((event) => event.kind === "answered")).toBe(false);
});

test("another machine is connected over SSH, and its one session carries its name and nothing that acts", () => {
  const snapshot = createFeed(T0).snapshot({ moment: "waiting" }, NOW);
  const machine = snapshot.sources.find((source) => source.id === `remote:${MACHINE.name}`)!;
  expect(machine).toMatchObject({ label: MACHINE.name, machine: MACHINE.name, state: "ok" });
  const there = snapshot.sessions.filter((session) => session.machine === MACHINE.name);
  expect(there).toHaveLength(1);
  expect(there[0]).toMatchObject({ source: machine.id, agent: "Claude Code", status: "working" });
  expect(there[0].id.startsWith(`${machine.id}:claude-code:`)).toBe(true);
  for (const acts of ["jump", "stop", "ask", "pid"] as const) {
    expect(there[0][acts]).toBeUndefined();
  }
});

test("the time rules are every rule off, as before anybody sets one, until the visitor sets them", () => {
  const feed = createFeed(T0);
  expect(feed.snapshot({ moment: "quiet" }, NOW)).toMatchObject({
    timeRules: DEFAULT_TIME_RULES,
    quiet: false,
  });
  // An idle rule of an hour makes the Codex session idle for over an hour stale.
  const rules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 1 } };
  const stale = feed
    .snapshot({ moment: "quiet", timeRules: rules }, NOW)
    .sessions.filter((session) => session.stale)
    .map((session) => session.name);
  expect(stale).toEqual(["mobile-onboarding", "infra-terraform"]);
});

test("the wait is answered when the visitor moves on, so the log says it waited as long as it was seen to", () => {
  const feed = createFeed(T0);
  const shown: Shown = { moment: "answered", answeredAt: LEFT };
  const events = feed.events(shown);
  expect(events[0]).toMatchObject({
    sessionName: "checkout-flow",
    kind: "status-changed",
    from: "needs-you",
    to: "working",
    at: LEFT,
  });
  const started = events.find(
    (event) => event.sessionId === WAITING_SESSION && event.to === "needs-you",
  );
  expect(events[0].at - started!.at).toBe(LEFT - (T0 + WAIT_STARTS));

  const session = feed.snapshot(shown, NOW).sessions.find((one) => one.id === WAITING_SESSION)!;
  expect(session).toMatchObject({ status: "working", statusSince: LEFT });
  expect(session.waitingText).toBeUndefined();

  // Until the answer the history counts it waiting, and from it on, working.
  const points = feed.history(shown, NOW, HOUR).points;
  const before = points.filter((point) => point.at > T0 && point.at < LEFT);
  const after = points.filter((point) => point.at >= LEFT);
  expect(before.length).toBeGreaterThan(0);
  expect(before.every((point) => point.needsYou === 1)).toBe(true);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((point) => point.needsYou === 0)).toBe(true);
});

test("a wait never seen was answered as the hour ended, and never before it", () => {
  const feed = createFeed(T0);
  for (const answeredAt of [undefined, null, T0 - 5 * MINUTE]) {
    const [answer] = feed.events({ moment: "answered", answeredAt });
    expect(answer).toMatchObject({ sessionName: "checkout-flow", to: "working", at: T0 });
  }
});

test("the events say what changed, newest first, as the collector's diff says it", () => {
  const events = createFeed(T0).events({ moment: "answered", answeredAt: LEFT });
  expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
  for (let i = 1; i < events.length; i++)
    expect(events[i].at).toBeLessThanOrEqual(events[i - 1].at);
  expect(
    events.filter((event) => event.at > T0 + STOPPED_AT && event.at < T0 + RESUMED_AT),
  ).toEqual([]);
});

test("a later moment holds every event of an earlier one", () => {
  const feed = createFeed(T0);
  const ids = (shown: Shown) => feed.events(shown).map((event) => event.id);
  const quiet = ids({ moment: "quiet" });
  const waiting = ids({ moment: "waiting" });
  const answered = ids({ moment: "answered", answeredAt: LEFT });
  expect(waiting).toEqual(expect.arrayContaining(quiet));
  expect(waiting.length).toBeGreaterThan(quiet.length);
  expect(answered).toEqual(expect.arrayContaining(waiting));
  expect(answered.length).toBe(waiting.length + 1);
});

test("the history says watching began days ago, stopped for four minutes in the hour and resumed, and is kept on disk", () => {
  const history = createFeed(T0).history({ moment: "answered" }, NOW, 6 * HOUR);
  const week = weekBefore(T0);
  expect(history.since).toEqual({ at: week.firstStart, by: "started" });
  expect(week.firstStart).toBeLessThan(T0 - 5 * DAY);
  expect(history.startedAt).toBe(T0 + RESUMED_AT);
  expect(history.restarts?.at(-2)).toEqual({
    at: T0 + WATCHING_SINCE,
    lastBefore: week.runs.at(-1)!.to,
  });
  expect(history.restarts?.at(-1)).toEqual({ at: T0 + RESUMED_AT, lastBefore: T0 + STOPPED_AT });
  for (let i = 1; i < history.restarts!.length; i++) {
    expect(history.restarts![i].lastBefore).toBeGreaterThan(history.restarts![i - 1].at);
  }
  expect(history.kept).toMatchObject({ where: "disk", canClear: true });
  expect(RESUMED_AT - STOPPED_AT).toBe(4 * MINUTE);
  const inGap = history.points.filter(
    (point) => point.at > T0 + STOPPED_AT && point.at < T0 + RESUMED_AT,
  );
  expect(inGap).toEqual([]);
});

test("once cleared, the history starts at the clearing and the log is empty", () => {
  const feed = createFeed(T0);
  const clearedAt = T0 + 10_000;
  const shown: Shown = { moment: "answered", answeredAt: T0 + 5_000 };
  const history = feed.history(shown, NOW, HOUR, clearedAt);
  expect(history.since).toEqual({ at: clearedAt, by: "cleared" });
  expect(history.points.every((point) => point.at >= clearedAt)).toBe(true);
  expect(feed.events(shown, clearedAt)).toEqual([]);
});

test("a window asks for only its own stretch of the history", () => {
  const points = createFeed(T0).history({ moment: "answered" }, NOW, 15 * MINUTE).points;
  expect(points[0].at).toBeGreaterThanOrEqual(NOW - 15 * MINUTE);
});

test("the six-hour charts hold the hour alone: the days before ended well before it", () => {
  const points = createFeed(T0).history({ moment: "answered" }, NOW, 6 * HOUR).points;
  expect(points[0].at).toBeGreaterThanOrEqual(T0 + WATCHING_SINCE);
  for (const run of weekBefore(T0).runs) expect(run.to).toBeLessThan(NOW - 6 * HOUR);
});

test("the log holds the waits of the days before, under the hour's", () => {
  const feed = createFeed(T0);
  const events = feed.events({ moment: "quiet" });
  const before = events.filter((event) => event.at <= T0 + WATCHING_SINCE);
  const waits = before.filter((event) => event.kind !== "ended");
  expect(waits.length).toBeGreaterThan(20);
  expect(waits.every((event) => event.from === "needs-you" || event.to === "needs-you")).toBe(true);
  // None of those sessions is still listed: each ended while Agent Lookout was not running.
  const listed = new Set(feed.snapshot({ moment: "quiet" }, NOW).sessions.map((one) => one.id));
  expect(before.some((event) => listed.has(event.sessionId))).toBe(false);
});

test("each session of the days before ended once, at the first poll after the last run it waited in", () => {
  const week = weekBefore(T0);
  const starts = [...week.runs.map((run) => run.from), T0 + WATCHING_SINCE];
  const sessions = new Set(week.events.map((event) => event.sessionId));
  expect(sessions.size).toBe(5);
  for (const id of sessions) {
    const own = week.events.filter((event) => event.sessionId === id);
    const ended = own.filter((event) => event.kind === "ended");
    expect(ended).toHaveLength(1);
    // Newest first: the ending is its last word, with the status it was last seen in.
    expect(own[0]).toBe(ended[0]);
    expect(ended[0]).toMatchObject({ from: "working", severity: "advisory" });
    const lastWait = own[1].at;
    const next = starts.find((start) => start > lastWait);
    expect(ended[0].at).toBe(next);
  }
  // Newest first throughout.
  for (let i = 1; i < week.events.length; i++) {
    expect(week.events[i].at).toBeLessThanOrEqual(week.events[i - 1].at);
  }
});

describe("the Waits card's answer", () => {
  const feed = createFeed(T0);

  test("is read by the dashboard as it was sent", () => {
    const waits = feed.waits({ moment: "waiting" }, NOW);
    expect(readWaits(JSON.parse(JSON.stringify(waits)))).toEqual(waits);
  });

  test("counts checkout-flow's wait as open while it waits, and answered once the visitor moves on", () => {
    const waiting = feed.waits({ moment: "waiting" }, NOW);
    const open = waiting.today.sessions.find((one) => one.sessionId === WAITING_SESSION);
    expect(open).toMatchObject({ name: "checkout-flow", open: true });
    expect(waiting.today.openMs).toBe(NOW - (T0 + WAIT_STARTS));

    const answered = feed.waits({ moment: "answered", answeredAt: LEFT }, NOW);
    expect(answered.today.openMs).toBe(0);
    const closed = answered.sevenDays.sessions.find((one) => one.sessionId === WAITING_SESSION);
    expect(closed).toMatchObject({ open: false, waitedMs: LEFT - (T0 + WAIT_STARTS) });
  });

  test("has seven days, one of them not measured, and more waits over them than today", () => {
    const { today, sevenDays, since } = feed.waits({ moment: "answered" }, NOW);
    expect(sevenDays.days).toHaveLength(7);
    expect(sevenDays.days.filter((day) => day.measuredMs === 0)).toHaveLength(1);
    expect(sevenDays.waits).toBeGreaterThan(today.waits + 15);
    expect(sevenDays.waitedMs).toBeGreaterThan(today.waitedMs);
    expect(since).toEqual(feed.history({ moment: "answered" }, NOW, HOUR).since);
  });

  test("never counts a Codex session", () => {
    const { sevenDays } = feed.waits({ moment: "waiting" }, NOW);
    expect(sevenDays.sessions.some((one) => one.sessionId.startsWith("codex:"))).toBe(false);
  });

  test("starts again from a clearing of the history", () => {
    const clearedAt = NOW - 1_000;
    const { sevenDays, since } = feed.waits({ moment: "answered" }, NOW, clearedAt);
    expect(since).toEqual({ at: clearedAt, by: "cleared" });
    expect(sevenDays.waits).toBe(0);
  });
});

test("the waiting session's branch has its pull request while pull requests are on, and none while off", () => {
  const feed = createFeed(T0);
  const on = feed.snapshot({ moment: "waiting" }, NOW).sessions;
  const withPullRequest = on.filter((one) => one.git?.pullRequest);
  expect(withPullRequest.map((one) => one.id)).toEqual([WAITING_SESSION]);
  expect(withPullRequest[0].git?.pullRequest).toMatchObject({
    state: "open",
    checks: { state: "failing", failing: 1, passing: 5, pending: 0 },
  });
  const off = feed.snapshot({ moment: "waiting", pullRequests: false }, NOW).sessions;
  expect(off.some((one) => one.git?.pullRequest)).toBe(false);
});

test("only Claude Code sessions in a terminal or in VS Code that still run something can be stopped", () => {
  const sessions = createFeed(T0).snapshot({ moment: "waiting" }, NOW).sessions;
  const stoppable = sessions.filter((one) => one.stop).map((one) => one.name);
  expect(stoppable.sort()).toEqual([
    "checkout-flow",
    "docs-site",
    "infra-terraform",
    "search-indexing",
  ]);
  for (const one of sessions.filter((session) => session.stop)) {
    expect(one.source).toBe("claude-code");
    expect(["terminal", "vscode"]).toContain(one.surface);
  }
});

test("a session stopped from the dashboard leaves the list, and the log says Agent Lookout stopped it", () => {
  const feed = createFeed(T0);
  const at = NOW - 2_000;
  const shown: Shown = {
    moment: "answered",
    stopped: [{ id: WAITING_SESSION, name: "checkout-flow", status: "working", at }],
  };
  expect(feed.snapshot(shown, NOW).sessions.some((one) => one.id === WAITING_SESSION)).toBe(false);
  const [ended, stopped] = feed.events(shown);
  expect(ended).toMatchObject({ kind: "ended", sessionId: WAITING_SESSION, at });
  expect(stopped).toMatchObject({ kind: "stopped", by: "agent-lookout", from: "working", at });
});
