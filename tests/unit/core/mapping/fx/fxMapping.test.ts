import { describe, expect, test } from "vitest";

import { mapFxStatus, type FxPrograms, type FxTail } from "@core/mapping/fx/fxMapping";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;

const open: FxTail = { turn: "open" };
const ended: FxTail = { turn: "ended", failed: false, at: NOW - MINUTE };
const failed: FxTail = { turn: "ended", failed: true, at: NOW - MINUTE };
const none: FxTail = { turn: "none" };
const unknown: FxTail = { turn: "unknown" };

const status = (
  tail: FxTail,
  programs: FxPrograms,
  more: { writerGone?: boolean; writtenAt?: number } = {},
) =>
  mapFxStatus({
    tail,
    programs,
    writerGone: more.writerGone ?? false,
    writtenAt: more.writtenAt ?? NOW - MINUTE,
    now: NOW,
  });

describe("an fx session's status", () => {
  test("row 1: a log that cannot be read is unknown, whatever runs", () => {
    for (const programs of ["none", "some", "unknown"] as const) {
      expect(status(unknown, programs), programs).toBe("unknown");
      expect(status(unknown, programs, { writerGone: true }), programs).toBe("unknown");
    }
  });

  test("row 2: a failed turn is failed, whatever runs", () => {
    for (const programs of ["none", "some", "unknown"] as const) {
      expect(status(failed, programs), programs).toBe("failed");
    }
  });

  test("row 3: with no answer from ps, an open, ended or new session is unknown", () => {
    for (const tail of [open, ended, none])
      expect(status(tail, "unknown"), tail.turn).toBe("unknown");
  });

  test("row 4: with no fx program, an open, ended or new session is finished", () => {
    for (const tail of [open, ended, none])
      expect(status(tail, "none"), tail.turn).toBe("finished");
  });

  test("row 5: between turns, or before the first, while an fx runs, it is unknown", () => {
    expect(status(ended, "some")).toBe("unknown");
    expect(status(none, "some")).toBe("unknown");
    expect(status(ended, "some", { writerGone: true })).toBe("unknown");
  });

  test("row 6: an open turn whose writer is gone is finished", () => {
    expect(status(open, "some", { writerGone: true })).toBe("finished");
  });

  test("row 7: an open turn quiet for 30 minutes, or written ahead of the clock, is unknown", () => {
    expect(status(open, "some", { writtenAt: NOW - 30 * MINUTE + 1_000 })).toBe("working");
    expect(status(open, "some", { writtenAt: NOW - 30 * MINUTE })).toBe("unknown");
    expect(status(open, "some", { writtenAt: NOW + MINUTE })).toBe("working");
    expect(status(open, "some", { writtenAt: NOW + MINUTE + 1 })).toBe("unknown");
  });

  test("row 8: an open turn while an fx runs is working", () => {
    expect(status(open, "some")).toBe("working");
  });

  test("it is never idle or needs-you", () => {
    const seen = new Set<string>();
    for (const tail of [open, ended, failed, none, unknown]) {
      for (const programs of ["none", "some", "unknown"] as const) {
        for (const writerGone of [true, false]) {
          for (const writtenAt of [NOW, NOW - 40 * MINUTE, NOW + 2 * MINUTE]) {
            seen.add(status(tail, programs, { writerGone, writtenAt }));
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(["failed", "finished", "unknown", "working"]);
  });
});
