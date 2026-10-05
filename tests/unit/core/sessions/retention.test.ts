import { describe, expect, test } from "vitest";

import { FINISHED_RETENTION_MS, isOver, isWithinRetention } from "@core/sessions/retention";

const now = 1_700_000_100_000;

describe("isOver", () => {
  test("a finished or failed session with no process is over", () => {
    expect(isOver({ status: "finished" })).toBe(true);
    expect(isOver({ status: "failed" })).toBe(true);
    expect(isOver({ status: "failed", alive: false })).toBe(true);
  });

  test("one whose process is still there is not", () => {
    expect(isOver({ status: "finished", alive: true })).toBe(false);
    expect(isOver({ status: "failed", alive: true })).toBe(false);
  });

  test("no other status is over, with a process or without", () => {
    for (const status of ["needs-you", "working", "idle", "unknown"] as const) {
      expect(isOver({ status })).toBe(false);
      expect(isOver({ status, alive: false })).toBe(false);
    }
  });
});

describe("isWithinRetention", () => {
  test("the retention is 24 hours", () => {
    expect(FINISHED_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("a session is kept until it has been over for the whole retention", () => {
    expect(isWithinRetention(now, now)).toBe(true);
    expect(isWithinRetention(now - FINISHED_RETENTION_MS + 1, now)).toBe(true);
    expect(isWithinRetention(now - FINISHED_RETENTION_MS, now)).toBe(false);
    expect(isWithinRetention(now - 3 * FINISHED_RETENTION_MS, now)).toBe(false);
  });

  test("a clock that stepped backwards hides nothing", () => {
    expect(isWithinRetention(now + 60_000, now)).toBe(true);
  });
});
