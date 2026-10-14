import { describe, expect, test } from "vitest";

import { createFinishedSessions } from "@collector/adapters/qwen-code/finishedSessions";
import { FINISHED_RETENTION_MS } from "@core/sessions/retention";
import { makeSession } from "@tests/fixtures/session";
import { HOUR, NOW, sessionIdOf } from "@tests/fixtures/qwen-code/qwenCode";

const open = (n: number) =>
  makeSession({
    id: `qwen-code:${sessionIdOf(n)}`,
    source: "qwen-code",
    status: "working",
    statusSince: NOW - HOUR,
    pid: 41000 + n,
    alive: true,
  });

describe("createFinishedSessions", () => {
  test("a session found open and then not is finished from the poll that found it closed", () => {
    const tracker = createFinishedSessions();
    expect(tracker.update([open(1), open(2)], [], NOW)).toEqual([]);
    // Its record has gone, its process has gone, or /clear gave its record another session.
    expect(tracker.update([open(2)], [], NOW + 2_000)).toEqual([
      { ...open(1), status: "finished", statusSince: NOW + 2_000, alive: false, stale: false },
    ]);
    // It stays finished from that moment.
    expect(tracker.update([open(2)], [], NOW + 4_000)).toEqual([
      { ...open(1), status: "finished", statusSince: NOW + 2_000, alive: false, stale: false },
    ]);
  });

  test("keeps a closed session for 24 hours", () => {
    const tracker = createFinishedSessions();
    tracker.update([open(1)], [], NOW);
    tracker.update([], [], NOW + 2_000);
    expect(tracker.update([], [], NOW + 2_000 + FINISHED_RETENTION_MS - 1)).toHaveLength(1);
    expect(tracker.update([], [], NOW + 2_000 + FINISHED_RETENTION_MS)).toEqual([]);
  });

  test("a closed session open again leaves the list", () => {
    const tracker = createFinishedSessions();
    tracker.update([open(1)], [], NOW);
    expect(tracker.update([], [], NOW + 2_000)).toHaveLength(1);
    expect(tracker.update([open(1)], [], NOW + 4_000)).toEqual([]);
  });

  test("a record left behind is finished only at the first poll, and left out once a day old", () => {
    const tracker = createFinishedSessions();
    expect(tracker.first).toBe(true);
    const crashed = {
      ...open(5),
      status: "finished" as const,
      statusSince: NOW - HOUR,
      alive: false,
    };
    const old = {
      ...open(6),
      status: "finished" as const,
      statusSince: NOW - FINISHED_RETENTION_MS,
      alive: false,
    };
    expect(tracker.update([open(1)], [crashed, old], NOW)).toEqual([crashed]);
    expect(tracker.first).toBe(false);
    // Later, a record left behind is not news: it is a session that closed before Agent Lookout saw it.
    const later = { ...open(7), status: "finished" as const, statusSince: NOW, alive: false };
    expect(tracker.update([open(1)], [later], NOW + 2_000)).toEqual([crashed]);
  });

  test("a left-behind record whose session is open is not shown twice", () => {
    const tracker = createFinishedSessions();
    const crashed = {
      ...open(1),
      status: "finished" as const,
      statusSince: NOW - HOUR,
      alive: false,
    };
    expect(tracker.update([open(1)], [crashed], NOW)).toEqual([]);
  });

  test("a poll not given to it changes nothing", () => {
    const tracker = createFinishedSessions();
    tracker.update([open(1)], [], NOW);
    // The poll at NOW + 2_000 could not read the list, and was not given to it.
    expect(tracker.update([open(1)], [], NOW + 4_000)).toEqual([]);
  });
});
