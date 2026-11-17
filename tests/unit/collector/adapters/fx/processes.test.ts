import { describe, expect, test } from "vitest";

import {
  createAbsenceTracker,
  createFxProcessReader,
  FX_TABLE_ARGS,
  fxInTable,
  programsOf,
} from "@collector/adapters/fx/processes";
import { WRITE_TIME_STEP_MS } from "@core/time";

const SECOND = 1_000;
/** The log's last write. */
const M = Date.UTC(2026, 9, 1, 12, 0, 0);

const ok = (...pids: number[]) => ({ ok: true as const, pids, unparsed: 0 });

describe("which fx programs ps lists", () => {
  test("a program named fx, or a path ending in /fx, counts by its ID", () => {
    expect(fxInTable(" 101 fx\n202 /Users/x/.local/bin/fx\n  303 /opt/my apps/fx\n")).toEqual({
      pids: [101, 202, 303],
      unparsed: 0,
    });
  });

  test("other programs do not, whatever is in their name", () => {
    expect(fxInTable("1 fx-helper\n2 jfx\n3 node\n4 exe\n5 /usr/bin/fxx\n6 fx/bin\n")).toEqual({
      pids: [],
      unparsed: 0,
    });
  });

  test("a line that names fx with no ID that can be read still counts", () => {
    expect(fxInTable("fx\n/bin/fx\n99999999999999999999 fx\n")).toEqual({ pids: [], unparsed: 3 });
  });

  test("whether one runs", () => {
    expect(programsOf({ ok: false })).toBe("unknown");
    expect(programsOf(ok())).toBe("none");
    expect(programsOf(ok(7))).toBe("some");
    expect(programsOf({ ok: true, pids: [], unparsed: 1 })).toBe("some");
  });
});

describe("the question to ps", () => {
  test("asks each process's ID and its program's name, and nothing else, on macOS and Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const asked: (readonly string[])[] = [];
      const reader = createFxProcessReader({
        platform,
        run: async (args) => {
          asked.push(args);
          return { ok: true, stdout: "12 fx\n13 node\n" };
        },
      });
      expect(await reader.read(), platform).toEqual(ok(12));
      expect(asked).toEqual([["-A", "-o", "pid=,comm="]]);
    }
    expect(FX_TABLE_ARGS.join(" ")).not.toContain("args");
  });

  test("is never run on Windows or another system, and a failure is an answer", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      let runs = 0;
      const reader = createFxProcessReader({
        platform,
        run: async () => {
          runs += 1;
          return { ok: true, stdout: "" };
        },
      });
      expect(await reader.read()).toEqual({ ok: false });
      expect(runs, platform).toBe(0);
    }
    const failing = createFxProcessReader({
      platform: "linux",
      run: async () => ({ ok: false, stdout: "12 fx\n" }),
    });
    expect(await failing.read()).toEqual({ ok: false });
    const throwing = createFxProcessReader({
      platform: "linux",
      run: async () => {
        throw new Error("no ps");
      },
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });
});

describe("whether the log's writer is gone", () => {
  /** The tracker after these answers, each at its time. */
  function after(...answers: [ReturnType<typeof ok> | { ok: false }, number][]) {
    const tracker = createAbsenceTracker();
    for (const [answer, at] of answers) tracker.note(answer, at);
    return tracker.writerGone(M);
  }

  test("an fx missing from an answer after the write did not make it", () => {
    expect(after([ok(), M + 5 * SECOND], [ok(200), M + 15 * SECOND])).toBe(true);
  });

  test("an fx listed before the write could have made it", () => {
    expect(after([ok(100), M - 5 * SECOND], [ok(100), M + 15 * SECOND])).toBe(false);
    expect(
      after([ok(100), M - 10 * SECOND], [ok(100), M + 5 * SECOND], [ok(100, 200), M + 15 * SECOND]),
    ).toBe(false);
  });

  test("an fx missing only from an answer within 2 seconds after the write's kept time could have made it", () => {
    // A disk that keeps whole seconds keeps a write at M + 900 ms as M.
    expect(after([ok(), M + 400], [ok(200), M + 10_400])).toBe(false);
    // One that keeps steps of 2 seconds keeps a write at M + 1950 ms as M.
    expect(after([ok(), M + 1_900], [ok(200), M + 11_900])).toBe(false);
    expect(after([ok(), M + WRITE_TIME_STEP_MS], [ok(200), M + 15 * SECOND])).toBe(false);
    expect(after([ok(), M + WRITE_TIME_STEP_MS + 1], [ok(200), M + 15 * SECOND])).toBe(true);
  });

  test("an fx in the first answer, or missing only from one before the write, could have made it", () => {
    expect(after([ok(200), M + 5 * SECOND])).toBe(false);
    expect(after([ok(), M - 5 * SECOND], [ok(200), M + 5 * SECOND])).toBe(false);
  });

  test("a line naming fx with no ID blocks it", () => {
    const tracker = createAbsenceTracker();
    tracker.note(ok(), M + 5 * SECOND);
    tracker.note({ ok: true, pids: [200], unparsed: 1 }, M + 15 * SECOND);
    expect(tracker.writerGone(M)).toBe(false);
  });

  test("no fx at all is not this rule's: the mapping finishes the session", () => {
    expect(after([ok(), M + 5 * SECOND], [ok(), M + 15 * SECOND])).toBe(false);
  });

  test("an answer that could not be had changes nothing", () => {
    expect(
      after([ok(), M + 5 * SECOND], [{ ok: false }, M + 10 * SECOND], [ok(200), M + 15 * SECOND]),
    ).toBe(true);
    expect(
      after([ok(), M + 5 * SECOND], [ok(200), M + 15 * SECOND], [{ ok: false }, M + 20 * SECOND]),
    ).toBe(true);
  });

  test("an answer whose time runs back drops every time kept", () => {
    expect(after([ok(), M + 20 * SECOND], [ok(200), M + 15 * SECOND])).toBe(false);
    expect(
      after([ok(), M + 5 * SECOND], [ok(200), M + 15 * SECOND], [ok(200), M + 10 * SECOND]),
    ).toBe(false);
  });

  test("an fx that went is forgotten, and one that comes back is new", () => {
    expect(
      after([ok(100), M - 5 * SECOND], [ok(), M + 5 * SECOND], [ok(100), M + 15 * SECOND]),
    ).toBe(true);
  });
});
