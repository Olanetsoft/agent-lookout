import { describe, expect, test } from "vitest";

import { createFinishedTracker } from "@collector/adapters/claude-code/finishedJobs";
import { FINISHED_RETENTION_MS } from "@core/retention";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;
const hour = 60 * 60 * 1000;

const job = (overrides: Parameters<typeof makeSession>[0] = {}) =>
  makeSession({
    id: "claude-code:job",
    name: "nightly-report",
    startedAt: T0 - hour,
    ...overrides,
  });

const ids = (sessions: { id: string }[]) => sessions.map((session) => session.id);

describe("createFinishedTracker", () => {
  test("sessions that are not over always pass through", () => {
    const tracker = createFinishedTracker();
    const sessions = [
      makeSession({ id: "claude-code:a", status: "working" }),
      makeSession({ id: "claude-code:b", status: "idle", startedAt: T0 - 90 * 24 * hour }),
      // Finished, but its process is still there: it is a live session.
      makeSession({ id: "claude-code:c", status: "finished", pid: 4242, alive: true }),
    ];
    expect(tracker.keepRecent(sessions, T0)).toEqual(sessions);
    expect(tracker.keepRecent(sessions, T0 + 10 * FINISHED_RETENTION_MS)).toEqual(sessions);
  });

  test("a job seen to fail stays for 24 hours from that moment, however long it ran", () => {
    const tracker = createFinishedTracker();
    const started = T0 - 30 * hour;
    tracker.keepRecent([job({ status: "working", startedAt: started })], T0);

    const failed = job({ status: "failed", startedAt: started });
    expect(ids(tracker.keepRecent([failed], T0 + 2_000))).toEqual(["claude-code:job"]);
    expect(ids(tracker.keepRecent([failed], T0 + 2_000 + FINISHED_RETENTION_MS - 1))).toEqual([
      "claude-code:job",
    ]);
    expect(tracker.keepRecent([failed], T0 + 2_000 + FINISHED_RETENTION_MS)).toEqual([]);
  });

  test("a job that first appears already over, after the first poll, counts from then", () => {
    const tracker = createFinishedTracker();
    tracker.keepRecent([], T0);
    const done = job({ status: "finished", startedAt: T0 - 48 * hour });
    expect(tracker.keepRecent([done], T0 + 2_000)).toHaveLength(1);
    expect(tracker.keepRecent([done], T0 + 2_000 + FINISHED_RETENTION_MS)).toHaveLength(0);
  });

  test("a job already over when the collector started is counted from its start time", () => {
    const recent = job({ id: "claude-code:recent", status: "finished", startedAt: T0 - 2 * hour });
    const old = job({ id: "claude-code:old", status: "failed", startedAt: T0 - 25 * hour });
    const tracker = createFinishedTracker();

    expect(ids(tracker.keepRecent([recent, old], T0))).toEqual(["claude-code:recent"]);
    // 22 hours later the recent one has been over, as far as anyone can tell, for 24.
    expect(ids(tracker.keepRecent([recent, old], T0 + 22 * hour - 1))).toEqual([
      "claude-code:recent",
    ]);
    expect(tracker.keepRecent([recent, old], T0 + 22 * hour)).toEqual([]);
  });

  test("with no start time either, a job over at the first poll counts from that poll", () => {
    const tracker = createFinishedTracker();
    const done = job({ status: "finished", startedAt: null });
    expect(tracker.keepRecent([done], T0)).toHaveLength(1);
    expect(tracker.keepRecent([done], T0 + FINISHED_RETENTION_MS)).toHaveLength(0);
  });

  test("a job whose process outlived its ending counts from when the process went", () => {
    const tracker = createFinishedTracker();
    const lingering = job({ status: "failed", pid: 4242, alive: true });
    tracker.keepRecent([lingering], T0);
    tracker.keepRecent([lingering], T0 + 30 * hour);

    const gone = job({ status: "failed" });
    expect(tracker.keepRecent([gone], T0 + 30 * hour + 2_000)).toHaveLength(1);
    expect(tracker.keepRecent([gone], T0 + 54 * hour + 1_999)).toHaveLength(1);
    expect(tracker.keepRecent([gone], T0 + 54 * hour + 2_000)).toHaveLength(0);
  });

  test("a job that runs again and ends again starts a new count", () => {
    const tracker = createFinishedTracker();
    tracker.keepRecent([job({ status: "working" })], T0);
    tracker.keepRecent([job({ status: "finished" })], T0 + 2_000);
    tracker.keepRecent([job({ status: "working" })], T0 + 23 * hour);

    const again = job({ status: "finished" });
    expect(tracker.keepRecent([again], T0 + 23 * hour + 2_000)).toHaveLength(1);
    expect(tracker.keepRecent([again], T0 + 40 * hour)).toHaveLength(1);
    expect(tracker.keepRecent([again], T0 + 47 * hour + 2_000)).toHaveLength(0);
  });

  test("the order of the sessions it keeps is the order it was given", () => {
    const tracker = createFinishedTracker();
    const sessions = [
      job({ id: "claude-code:1", status: "finished" }),
      makeSession({ id: "claude-code:2", status: "working" }),
      job({ id: "claude-code:3", status: "failed", startedAt: T0 - 100 * hour }),
      makeSession({ id: "claude-code:4", status: "idle" }),
    ];
    expect(ids(tracker.keepRecent(sessions, T0))).toEqual([
      "claude-code:1",
      "claude-code:2",
      "claude-code:4",
    ]);
  });
});
