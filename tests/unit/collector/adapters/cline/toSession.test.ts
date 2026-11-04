import { describe, expect, test } from "vitest";

import { clineSession, type ClineSessionInput } from "@collector/adapters/cline/toSession";
import type { Manifest } from "@collector/adapters/cline/manifests";
import {
  DAY,
  HOUR,
  MINUTE,
  NOW,
  PID,
  PROJECT,
  sessionIdOf,
  STARTED_AT,
} from "@tests/fixtures/cline/cline";

const ID = sessionIdOf(1);

const manifest = (changes: Partial<Manifest> = {}): Manifest => ({
  sessionId: ID,
  pid: PID,
  status: "running",
  cwd: PROJECT,
  startedAt: STARTED_AT,
  endedAt: null,
  ...changes,
});

const session = (changes: Partial<ClineSessionInput> = {}, fields: Partial<Manifest> = {}) =>
  clineSession({
    manifest: manifest(fields),
    processRuns: true,
    statusWrittenAt: NOW - 10 * MINUTE,
    writtenAt: NOW - 2 * MINUTE,
    now: NOW,
    ...changes,
  });

test("a working session, with nothing but the kept fields", () => {
  expect(session()).toEqual({
    id: `cline:${ID}`,
    source: "cline",
    surface: "unknown",
    name: "demo-project",
    cwd: PROJECT,
    project: "demo-project",
    status: "working",
    startedAt: STARTED_AT,
    statusSince: NOW - 10 * MINUTE,
    lastWriteAt: NOW - 2 * MINUTE,
    pid: PID,
    alive: true,
    links: {},
    stale: false,
  });
});

test("a session waiting for a tool's approval needs you, for permission, with nothing it asks", () => {
  const waiting = session({}, { status: "pending" });
  expect(waiting).toMatchObject({
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - 10 * MINUTE,
  });
  expect(waiting).not.toHaveProperty("waitingText");
});

test("a session idle for a day is stale", () => {
  expect(
    session(
      { statusWrittenAt: NOW - DAY - 1, writtenAt: NOW - DAY - 1 },
      { status: "idle", startedAt: NOW - 2 * DAY },
    ),
  ).toMatchObject({ status: "idle", stale: true });
});

describe("a session that ended", () => {
  test.each([
    ["completed", "finished"],
    ["cancelled", "finished"],
    ["failed", "failed"],
  ])("%s is %s from its ended_at, with no process", (status, shown) => {
    const over = session({ processRuns: null }, { status, endedAt: NOW - 5 * MINUTE });
    expect(over).toMatchObject({ status: shown, statusSince: NOW - 5 * MINUTE, stale: false });
    expect(over).not.toHaveProperty("pid");
    expect(over).not.toHaveProperty("alive");
  });

  test("with no ended_at, from its last write", () => {
    expect(session({ processRuns: null }, { status: "completed" })).toMatchObject({
      status: "finished",
      statusSince: NOW - 2 * MINUTE,
    });
  });
});

describe("a session whose process has gone", () => {
  test.each(["running", "pending", "idle"])("%s is finished from its last write", (status) => {
    const gone = session({ processRuns: false }, { status });
    expect(gone).toMatchObject({
      status: "finished",
      statusSince: NOW - 2 * MINUTE,
      pid: PID,
      alive: false,
    });
    expect(gone).not.toHaveProperty("waitingReason");
  });
});

test("a status not known, and one with no process to ask about, have no time", () => {
  expect(session({}, { status: "archived" })).toMatchObject({
    status: "unknown",
    statusSince: null,
  });
  const noProcess = session({ processRuns: null }, { pid: null });
  expect(noProcess).toMatchObject({ status: "unknown", statusSince: null });
  expect(noProcess).not.toHaveProperty("pid");
});

describe("its name", () => {
  test("is its folder's name, else its id", () => {
    expect(session().name).toBe("demo-project");
    expect(session({}, { cwd: null })).toMatchObject({
      name: `cline:${ID}`,
      project: null,
      cwd: null,
    });
  });
});

describe("a time that cannot be right is none", () => {
  test.each([
    ["ahead of the clock", NOW + HOUR],
    ["before 2020", Date.UTC(2019, 0, 1)],
  ])("a start %s", (_case, startedAt) => {
    expect(session({}, { startedAt }).startedAt).toBeNull();
  });

  test("a start that is not there", () => {
    expect(session({}, { startedAt: null }).startedAt).toBeNull();
  });

  test("an end ahead of the clock falls back to the last write", () => {
    expect(
      session({ processRuns: null }, { status: "completed", endedAt: NOW + HOUR }).statusSince,
    ).toBe(NOW - 2 * MINUTE);
  });

  test("a status or a write ahead of the clock", () => {
    const ahead = session({ statusWrittenAt: NOW + HOUR, writtenAt: NOW + HOUR });
    expect(ahead.statusSince).toBeNull();
    expect(ahead).not.toHaveProperty("lastWriteAt");
  });

  test("a status or a write before the session began", () => {
    const before = session({ statusWrittenAt: STARTED_AT - HOUR, writtenAt: STARTED_AT - HOUR });
    expect(before.statusSince).toBeNull();
    expect(before).not.toHaveProperty("lastWriteAt");
  });

  test("a time with a fraction of a millisecond is made whole", () => {
    expect(session({ writtenAt: NOW - 1_000.5 }).lastWriteAt).toBe(NOW - 1_001);
  });

  test("a status time with a fraction of a millisecond is made whole", () => {
    expect(session({ statusWrittenAt: NOW - 1_000.5 }).statusSince).toBe(NOW - 1_001);
  });

  test("a write a moment before the start is the same moment", () => {
    expect(
      session({ statusWrittenAt: STARTED_AT - 500, writtenAt: STARTED_AT - 500 }),
    ).toMatchObject({ statusSince: STARTED_AT - 500, lastWriteAt: STARTED_AT - 500 });
  });

  test("an end before the start falls back to the last write", () => {
    expect(
      session({ processRuns: null }, { status: "completed", endedAt: STARTED_AT - HOUR })
        .statusSince,
    ).toBe(NOW - 2 * MINUTE);
  });
});
