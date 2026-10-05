import { expect, test } from "vitest";

import { compareSessions, sortSessions, STATUS_ORDER } from "@core/sessions/sorting";
import { makeSession } from "@tests/fixtures/session";

test("statuses are listed with the ones that need a person first", () => {
  expect(STATUS_ORDER).toEqual(["needs-you", "working", "idle", "finished", "failed", "unknown"]);
});

test("sessions sort by status first", () => {
  const sessions = [
    makeSession({ id: "claude-code:u", status: "unknown" }),
    makeSession({ id: "claude-code:f", status: "failed" }),
    makeSession({ id: "claude-code:i", status: "idle" }),
    makeSession({ id: "claude-code:d", status: "finished" }),
    makeSession({ id: "claude-code:w", status: "working" }),
    makeSession({ id: "claude-code:n", status: "needs-you" }),
  ];
  expect(sortSessions(sessions).map((session) => session.status)).toEqual(STATUS_ORDER);
});

test("among sessions that need you, the longest wait comes first", () => {
  const sessions = [
    makeSession({ id: "claude-code:new", status: "needs-you", statusSince: 3_000 }),
    makeSession({ id: "claude-code:old", status: "needs-you", statusSince: 1_000 }),
    makeSession({ id: "claude-code:mid", status: "needs-you", statusSince: 2_000 }),
  ];
  expect(sortSessions(sessions).map((session) => session.id)).toEqual([
    "claude-code:old",
    "claude-code:mid",
    "claude-code:new",
  ]);
});

test("among other statuses, the most recent change comes first", () => {
  const sessions = [
    makeSession({ id: "claude-code:old", status: "idle", statusSince: 1_000 }),
    makeSession({ id: "claude-code:new", status: "idle", statusSince: 3_000 }),
    makeSession({ id: "claude-code:mid", status: "idle", statusSince: 2_000 }),
  ];
  expect(sortSessions(sessions).map((session) => session.id)).toEqual([
    "claude-code:new",
    "claude-code:mid",
    "claude-code:old",
  ]);
});

test("a session with no status time comes after those that have one", () => {
  for (const status of ["needs-you", "idle"] as const) {
    const sessions = [
      makeSession({ id: "claude-code:none", status, statusSince: null }),
      makeSession({ id: "claude-code:some", status, statusSince: 1_000 }),
    ];
    expect(sortSessions(sessions).map((session) => session.id)).toEqual([
      "claude-code:some",
      "claude-code:none",
    ]);
  }
});

test("ties break by name without regard to case, then by id", () => {
  const sessions = [
    makeSession({ id: "claude-code:3", name: "zeta" }),
    makeSession({ id: "claude-code:2", name: "Alpha" }),
    makeSession({ id: "claude-code:1", name: "alpha" }),
  ];
  expect(sortSessions(sessions).map((session) => session.id)).toEqual([
    "claude-code:1",
    "claude-code:2",
    "claude-code:3",
  ]);
});

test("the order does not depend on the order the source listed them in", () => {
  const sessions = [
    makeSession({ id: "claude-code:a", name: "a", status: "working", statusSince: 5 }),
    makeSession({ id: "claude-code:b", name: "b", status: "needs-you", statusSince: 9 }),
    makeSession({ id: "claude-code:c", name: "c", status: "idle", statusSince: null }),
    makeSession({ id: "claude-code:d", name: "d", status: "idle", statusSince: 7 }),
  ];
  const forwards = sortSessions(sessions).map((session) => session.id);
  const backwards = sortSessions([...sessions].reverse()).map((session) => session.id);
  expect(backwards).toEqual(forwards);
  expect(forwards).toEqual(["claude-code:b", "claude-code:a", "claude-code:d", "claude-code:c"]);
});

test("sorting returns a copy and leaves the input alone", () => {
  const sessions = [
    makeSession({ id: "claude-code:i", status: "idle" }),
    makeSession({ id: "claude-code:n", status: "needs-you" }),
  ];
  const sorted = sortSessions(sessions);
  expect(sorted).not.toBe(sessions);
  expect(sessions.map((session) => session.id)).toEqual(["claude-code:i", "claude-code:n"]);
});

test("a session compares equal to itself", () => {
  const session = makeSession();
  expect(compareSessions(session, session)).toBe(0);
});
