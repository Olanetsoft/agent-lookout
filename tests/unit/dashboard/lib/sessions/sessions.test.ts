import { expect, test } from "vitest";

import {
  countNeedingYou,
  countState,
  groupSessions,
  heroLight,
  summarizeSessions,
  tableGroups,
  waitingSessions,
} from "@dashboard/lib/sessions/sessions";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;
const MINUTE = 60_000;

function session(name: string, overrides: Parameters<typeof makeSession>[0] = {}) {
  return makeSession({ id: `claude-code:${name}`, name, ...overrides });
}

test("groups come in the order needs you, working, idle, finished and failed", () => {
  const groups = groupSessions([
    session("done", { status: "finished" }),
    session("resting", { status: "idle" }),
    session("busy", { status: "working" }),
    session("blocked", { status: "needs-you", waitingReason: "permission" }),
    session("broke", { status: "failed" }),
  ]);

  expect(groups.map((group) => group.id)).toEqual(["needs-you", "working", "idle", "ended"]);
  expect(groups.map((group) => group.label)).toEqual([
    "Needs you",
    "Working",
    "Idle",
    "Finished or failed",
  ]);
});

test("an empty group is left out, needs you included", () => {
  // That nothing is waiting is said by the hero. The list does not say it again.
  const groups = groupSessions([session("resting", { status: "idle" })]);

  expect(groups.map((group) => group.id)).toEqual(["idle"]);
  expect(groupSessions([])).toEqual([]);
});

test("a session with an unknown status is shown in its own group, never dropped", () => {
  const groups = groupSessions([session("odd", { status: "unknown" })]);

  expect(groups.map((group) => group.id)).toEqual(["unknown"]);
  expect(groups[0]?.sessions.map((s) => s.name)).toEqual(["odd"]);
});

test("under needs you, the longest wait comes first", () => {
  const [needsYou] = groupSessions([
    session("recent", { status: "needs-you", statusSince: T - MINUTE }),
    session("oldest", { status: "needs-you", statusSince: T - 30 * MINUTE }),
    session("unreported", { status: "needs-you", statusSince: null }),
    session("middle", { status: "needs-you", statusSince: T - 5 * MINUTE }),
  ]);

  expect(needsYou?.sessions.map((s) => s.name)).toEqual([
    "oldest",
    "middle",
    "recent",
    "unreported",
  ]);
});

test("idle sessions list the most recent first, so stale ones sink", () => {
  const groups = groupSessions([
    session("stale", { status: "idle", statusSince: T - 5_000 * MINUTE, stale: true }),
    session("fresh", { status: "idle", statusSince: T - MINUTE }),
    session("older", { status: "idle", statusSince: T - 90 * MINUTE }),
  ]);
  const idle = groups.find((group) => group.id === "idle");

  expect(idle?.sessions.map((s) => s.name)).toEqual(["fresh", "older", "stale"]);
});

test("a failure is listed before a clean finish", () => {
  const groups = groupSessions([
    session("finished-later", { status: "finished", statusSince: T }),
    session("failed-earlier", { status: "failed", statusSince: T - 60 * MINUTE }),
  ]);
  const ended = groups.find((group) => group.id === "ended");

  expect(ended?.sessions.map((s) => s.name)).toEqual(["failed-earlier", "finished-later"]);
});

test("the order does not depend on the order the sessions arrive in", () => {
  const a = session("alpha", { status: "working", statusSince: T });
  const b = session("beta", { status: "working", statusSince: T });

  const forward = groupSessions([a, b]).flatMap((group) => group.sessions.map((s) => s.name));
  const backward = groupSessions([b, a]).flatMap((group) => group.sessions.map((s) => s.name));

  expect(forward).toEqual(backward);
});

test("the summary counts each status, stale sessions apart from idle ones, and open and ended sessions", () => {
  const summary = summarizeSessions([
    session("a", { status: "needs-you", waitingReason: "permission", statusSince: T - MINUTE }),
    session("b", { status: "needs-you", waitingReason: "question", statusSince: T - 9 * MINUTE }),
    session("c", { status: "working", cwd: "/Users/example/code/other", project: "other" }),
    session("d", { status: "idle", stale: true }),
    session("e", { status: "idle" }),
    session("f", { status: "finished" }),
    session("g", { status: "failed" }),
    session("h", { status: "unknown" }),
  ]);

  expect(summary).toMatchObject({
    total: 8,
    needsYou: 2,
    working: 1,
    // The stale session is idle, but it is counted under stale and not here.
    idle: 1,
    stale: 1,
    open: 6,
    finished: 1,
    failed: 1,
  });
  // Every session is counted once, so the counts add up to the total.
  const unknown = 1;
  expect(
    summary.needsYou +
      summary.working +
      summary.idle +
      summary.stale +
      summary.finished +
      summary.failed +
      unknown,
  ).toBe(summary.total);
  // The longest wait belongs to the session that has needed the person longest.
  expect(summary.longestWait?.session.name).toBe("b");
  expect(summary.longestWait?.since).toBe(T - 9 * MINUTE);
});

test("the longest time working and idle belong to the session in that status longest", () => {
  const summary = summarizeSessions([
    session("busy-short", { status: "working", statusSince: T - 2 * MINUTE }),
    session("busy-long", { status: "working", statusSince: T - 34 * MINUTE }),
    session("busy-unreported", { status: "working", statusSince: null }),
    session("rest-short", { status: "idle", statusSince: T - 18 * MINUTE }),
    session("rest-long", { status: "idle", statusSince: T - 65 * MINUTE }),
  ]);

  expect(summary.longestWorking).toEqual({
    session: expect.objectContaining({ name: "busy-long" }),
    since: T - 34 * MINUTE,
  });
  expect(summary.longestIdle).toEqual({
    session: expect.objectContaining({ name: "rest-long" }),
    since: T - 65 * MINUTE,
  });
});

test("a stale session is not idle, so its days are never the longest time idle", () => {
  const summary = summarizeSessions([
    session("fresh", { status: "idle", statusSince: T - 5 * MINUTE }),
    session("stale", { status: "idle", statusSince: T - 3_000 * MINUTE, stale: true }),
  ]);

  expect(summary.idle).toBe(1);
  expect(summary.stale).toBe(1);
  expect(summary.longestIdle?.session.name).toBe("fresh");

  // With only stale sessions idle, there is no longest time idle at all.
  const allStale = summarizeSessions([
    session("stale", { status: "idle", statusSince: T - 3_000 * MINUTE, stale: true }),
  ]);
  expect(allStale.idle).toBe(0);
  expect(allStale.longestIdle).toBeNull();
});

test("only an idle session is counted as stale, whatever the flag says", () => {
  const summary = summarizeSessions([
    session("odd", { status: "working", stale: true, statusSince: T - MINUTE }),
  ]);

  expect(summary).toMatchObject({ working: 1, stale: 0, idle: 0 });
});

test("there is no longest time working or idle when none was reported", () => {
  const summary = summarizeSessions([
    session("a", { status: "working", statusSince: null }),
    session("b", { status: "idle", statusSince: null }),
  ]);

  expect(summary.longestWorking).toBeNull();
  expect(summary.longestIdle).toBeNull();
  expect(summarizeSessions([]).longestWorking).toBeNull();
});

test("the idle group holds its stale sessions but counts them apart, as the counts row does", () => {
  const groups = groupSessions([
    session("fresh", { status: "idle", statusSince: T - MINUTE }),
    session("stale", { status: "idle", statusSince: T - 3_000 * MINUTE, stale: true }),
    session("busy", { status: "working" }),
  ]);

  expect(
    groups.map((group) => [group.id, group.sessions.length, group.count, group.stale]),
  ).toEqual([
    ["working", 1, 1, 0],
    ["idle", 2, 1, 1],
  ]);
  // The counts agree with the counts row.
  const summary = summarizeSessions(groups.flatMap((group) => group.sessions));
  const idle = groups.find((group) => group.id === "idle");
  expect([idle?.count, idle?.stale]).toEqual([summary.idle, summary.stale]);
});

test("the ended group is named for what is in it", () => {
  const label = (...statuses: ("finished" | "failed")[]) =>
    groupSessions(statuses.map((status, index) => session(`s${index}`, { status })))[0]?.label;

  expect(label("finished")).toBe("Finished");
  expect(label("failed", "failed")).toBe("Failed");
  expect(label("finished", "failed")).toBe("Finished or failed");
});

test("there is no longest wait when nothing is waiting, or when no start was reported", () => {
  expect(summarizeSessions([session("a", { status: "idle" })]).longestWait).toBeNull();
  expect(
    summarizeSessions([session("a", { status: "needs-you", statusSince: null })]).longestWait,
  ).toBeNull();
});

test("the count that lights the lamp is the sessions that need the person now, and zero before any answer", () => {
  const sessions = [
    session("blocked", { status: "needs-you", waitingReason: "permission" }),
    session("asking", { status: "needs-you", waitingReason: "question" }),
    session("busy", { status: "working" }),
    session("resting", { status: "idle", stale: true }),
    session("done", { status: "finished" }),
  ];

  expect(countNeedingYou(sessions)).toBe(2);
  expect(countNeedingYou(sessions)).toBe(summarizeSessions(sessions).needsYou);
  expect(countNeedingYou(sessions.slice(2))).toBe(0);
  expect(countNeedingYou([])).toBe(0);
  expect(countNeedingYou(null)).toBe(0);
  expect(countNeedingYou(undefined)).toBe(0);
});

test("the sessions that need the person are the hero's, longest wait first, with an unreported start last", () => {
  const sessions = [
    session("busy", { status: "working", statusSince: T - 90 * MINUTE }),
    session("recent", { status: "needs-you", statusSince: T - MINUTE }),
    session("unreported", { status: "needs-you", statusSince: null }),
    session("oldest", { status: "needs-you", statusSince: T - 30 * MINUTE }),
    session("resting", { status: "idle", statusSince: T - 300 * MINUTE }),
  ];

  expect(waitingSessions(sessions).map((s) => s.name)).toEqual(["oldest", "recent", "unreported"]);
  expect(waitingSessions(sessions.filter((s) => s.status !== "needs-you"))).toEqual([]);
  expect(waitingSessions([])).toEqual([]);
});

test("the Sessions table has every group but needs you, which is the hero's", () => {
  const sessions = [
    session("blocked", { status: "needs-you", statusSince: T - MINUTE }),
    session("busy", { status: "working" }),
    session("resting", { status: "idle" }),
    session("done", { status: "finished" }),
  ];

  expect(tableGroups(sessions).map((group) => group.id)).toEqual(["working", "idle", "ended"]);
  // The groups it keeps are the groups as they are everywhere else.
  expect(tableGroups(sessions)).toEqual(groupSessions(sessions).slice(1));
  // With only waiting sessions, the table has no group at all.
  expect(tableGroups(sessions.slice(0, 1))).toEqual([]);
});

test("a count is a count once a source was read or a session found, and not before", () => {
  const ok = [{ state: "ok" as const }];

  // Before the first answer, nothing is claimed.
  expect(countState(null, ok)).toEqual({ summary: null, counted: false, searching: false });
  // A source read and nothing found: a real zero.
  expect(countState([], ok)).toMatchObject({ counted: true, searching: false });
  expect(countState([], ok).summary?.total).toBe(0);
  // Nothing read: nothing found is not nothing running.
  expect(countState([], [{ state: "error" }])).toMatchObject({ counted: false, searching: false });
  expect(countState([], [{ state: "unavailable" }])).toMatchObject({ counted: false });
  expect(countState([], [{ state: "searching" }])).toMatchObject({
    counted: false,
    searching: true,
  });
  // Sessions found through a source that then failed are still counted.
  expect(countState([session("busy", { status: "working" })], [{ state: "error" }])).toMatchObject({
    counted: true,
  });
});

test("the hero holds the lamp while a session needs the person, the rest light while none does, and neither before a count", () => {
  const ok = [{ state: "ok" as const }];
  const blocked = session("blocked", { status: "needs-you" });
  const busy = session("busy", { status: "working" });

  expect(heroLight(countState([blocked, busy], ok))).toBe("lamp");
  expect(heroLight(countState([busy], ok))).toBe("rest");
  expect(heroLight(countState([], ok))).toBe("rest");
  expect(heroLight(countState(null, ok))).toBeNull();
  expect(heroLight(countState([], [{ state: "searching" }]))).toBeNull();
  expect(heroLight(countState([], [{ state: "unavailable" }]))).toBeNull();
});
