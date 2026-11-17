import { describe, expect, test } from "vitest";

import {
  guardUnrealAgentClock,
  startUnrealAgentClockGuard,
  unrealAgentLiveness,
  type UnrealAgentHeld,
  type UnrealAgentProcessFacts,
  type UnrealAgentPrograms,
} from "@core/mapping/unreal-agent/unrealAgentLiveness";

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

const programs = (...starts: number[]): UnrealAgentPrograms => ({
  ok: true,
  starts,
  unknownStart: false,
});

function facts(changes: Partial<UnrealAgentProcessFacts> = {}): UnrealAgentProcessFacts {
  return {
    programs: programs(NOW - 60 * MINUTE),
    processesAt: NOW,
    noUnrealAt: null,
    l3Floor: -Infinity,
    ...changes,
  };
}

const held = (writtenAt: number, key: number = writtenAt, ended = false): UnrealAgentHeld => ({
  writtenAt,
  key,
  ended,
});

const one = (f: UnrealAgentProcessFacts, session: UnrealAgentHeld) =>
  unrealAgentLiveness(f, [session])[0];

describe("each rule", () => {
  test("L0: with no answer from ps, or none asked, it cannot tell", () => {
    expect(one(facts({ programs: { ok: false } }), held(NOW))).toEqual({
      liveness: "cannot-tell",
      rule: "L0",
    });
    expect(one(facts({ programs: null }), held(NOW))?.rule).toBe("L0");
  });

  test("L1: with no Unreal Agent program, every session is closed", () => {
    const answers = unrealAgentLiveness(facts({ programs: programs() }), [
      held(NOW),
      held(NOW - MINUTE),
    ]);
    expect(answers).toEqual([
      { liveness: "closed", rule: "L1" },
      { liveness: "closed", rule: "L1" },
    ]);
    // A program whose start could not be read is a program.
    expect(
      one(facts({ programs: { ok: true, starts: [], unknownStart: true } }), held(NOW))?.rule,
    ).toBe("Lx");
  });

  test("L2: written more than 2 seconds before a ps that showed none, it is closed", () => {
    // A program that started 30 seconds after the write, which L3 alone would not close for.
    const f = facts({
      programs: programs(NOW - MINUTE + 30 * SECOND),
      noUnrealAt: NOW - 50 * SECOND,
    });
    expect(one(f, held(NOW - MINUTE))).toEqual({ liveness: "closed", rule: "L2" });
    expect(one(f, held(NOW - 50 * SECOND - SECOND))?.rule).toBe("L5");
    expect(one(f, held(NOW - 50 * SECOND - 3 * SECOND))?.rule).toBe("L2");
  });

  test("Lx: a program whose start cannot be read keeps a session L3 would close from being closed", () => {
    const f = facts({
      programs: { ok: true, starts: [NOW - 10 * SECOND], unknownStart: true },
    });
    expect(one(f, held(NOW - 5 * MINUTE))).toEqual({ liveness: "cannot-tell", rule: "Lx" });
  });

  test("L3: every program started more than 60 seconds after the last write closes it", () => {
    const write = NOW - 10 * MINUTE;
    expect(one(facts({ programs: programs(write + 2 * MINUTE) }), held(write))).toEqual({
      liveness: "closed",
      rule: "L3",
    });
    expect(one(facts({ programs: programs(write + 30 * SECOND) }), held(write))?.rule).toBe("L5");
    // One program that could hold it is enough.
    expect(
      one(facts({ programs: programs(write + 2 * MINUTE, write - MINUTE) }), held(write))?.rule,
    ).toBe("L5");
  });

  test("L3 closes no write made before the floor a clock step raised", () => {
    const write = NOW - 10 * MINUTE;
    const f = facts({ programs: programs(write + 2 * MINUTE), l3Floor: write + SECOND });
    // Not closed: the count rule then finds no program started by its run, so it cannot be told.
    expect(one(f, held(write))).toEqual({ liveness: "cannot-tell", rule: "L4" });
    expect(one(f, held(write + SECOND))?.rule).toBe("L3");
  });

  test("L4: two idle sessions and one older program both cannot be told; with two programs both may be open", () => {
    const sessions = [held(NOW - 5 * MINUTE), held(NOW - 3 * MINUTE)];
    const start = NOW - 20 * MINUTE;
    expect(unrealAgentLiveness(facts({ programs: programs(start) }), sessions)).toEqual([
      { liveness: "cannot-tell", rule: "L4" },
      { liveness: "cannot-tell", rule: "L4" },
    ]);
    expect(unrealAgentLiveness(facts({ programs: programs(start, start) }), sessions)).toEqual([
      { liveness: "may-be-open", rule: "L5" },
      { liveness: "may-be-open", rule: "L5" },
    ]);
  });

  test("L4: a program started between two runs counts only for the later one", () => {
    const earlier = held(NOW - 5 * MINUTE, NOW - 30 * MINUTE);
    const later = held(NOW - 4 * MINUTE, NOW - 10 * MINUTE);
    // One program started before both runs, one between them: each run can have one.
    const balanced = programs(NOW - 40 * MINUTE, NOW - 20 * MINUTE);
    expect(
      unrealAgentLiveness(facts({ programs: balanced }), [earlier, later]).map((a) => a.rule),
    ).toEqual(["L5", "L5"]);
    // Both started after the earlier run began: it has none, and which one has none cannot be told.
    const short = programs(NOW - 20 * MINUTE, NOW - 15 * MINUTE);
    expect(
      unrealAgentLiveness(facts({ programs: short }), [earlier, later]).map((a) => a.rule),
    ).toEqual(["L4", "L5"]);
  });

  test("L4 counts no session whose run began after ps was asked, and no session that ended", () => {
    const start = NOW - 20 * MINUTE;
    const asked = NOW - 2 * MINUTE;
    const sessions = [held(NOW - 5 * MINUTE), held(NOW - SECOND, NOW - SECOND)];
    expect(
      unrealAgentLiveness(facts({ programs: programs(start), processesAt: asked }), sessions).map(
        (a) => a.rule,
      ),
    ).toEqual(["L5", "L5"]);
    const ended = [held(NOW - 5 * MINUTE), held(NOW - 3 * MINUTE, NOW - 3 * MINUTE, true)];
    expect(
      unrealAgentLiveness(facts({ programs: programs(start) }), ended).map((a) => a.rule),
    ).toEqual(["L5", "L5"]);
  });
});

describe("the clock guard", () => {
  test("on Linux, a clock that moved more than a minute past the time that passed raises the floor", () => {
    let guard = startUnrealAgentClockGuard();
    guard = guardUnrealAgentClock(guard, { platform: "linux", wall: NOW, mono: 1_000 });
    expect(guard.l3Floor).toBe(-Infinity);
    guard = guardUnrealAgentClock(guard, {
      platform: "linux",
      wall: NOW + 2 * SECOND,
      mono: 3_000,
    });
    expect(guard.l3Floor).toBe(-Infinity);
    // Two seconds passed, but the clock moved five minutes.
    guard = guardUnrealAgentClock(guard, {
      platform: "linux",
      wall: NOW + 5 * MINUTE,
      mono: 5_000,
    });
    expect(guard.l3Floor).toBe(NOW + 5 * MINUTE);
    // A session written before the step is not closed by L3, and one written after is.
    const f = facts({ programs: programs(NOW + 10 * MINUTE), l3Floor: guard.l3Floor });
    expect(one(f, held(NOW + MINUTE))?.liveness).not.toBe("closed");
    expect(one(f, held(NOW + 6 * MINUTE))?.rule).toBe("L3");
  });

  test("on Linux, a clock set back changes nothing", () => {
    let guard = guardUnrealAgentClock(startUnrealAgentClockGuard(), {
      platform: "linux",
      wall: NOW,
      mono: 1_000,
    });
    guard = guardUnrealAgentClock(guard, {
      platform: "linux",
      wall: NOW - 10 * MINUTE,
      mono: 3_000,
    });
    expect(guard.l3Floor).toBe(-Infinity);
  });

  test("on macOS, a clock set back more than a minute below the latest time seen raises the floor to it", () => {
    let guard = guardUnrealAgentClock(startUnrealAgentClockGuard(), {
      platform: "darwin",
      wall: NOW,
      mono: 0,
    });
    guard = guardUnrealAgentClock(guard, { platform: "darwin", wall: NOW - 30 * SECOND, mono: 0 });
    expect(guard.l3Floor).toBe(-Infinity);
    guard = guardUnrealAgentClock(guard, { platform: "darwin", wall: NOW - 10 * MINUTE, mono: 0 });
    expect(guard.l3Floor).toBe(NOW);
    expect(guard.highWall).toBe(NOW);
    // A session written in the clock set back, before the latest time seen, is not closed.
    const f = facts({ programs: programs(NOW - 5 * MINUTE), l3Floor: guard.l3Floor });
    expect(one(f, held(NOW - 8 * MINUTE))?.liveness).toBe("cannot-tell");
    expect(one({ ...f, l3Floor: -Infinity }, held(NOW - 8 * MINUTE))?.rule).toBe("L3");
  });

  test("on macOS, a clock set forward changes nothing", () => {
    let guard = guardUnrealAgentClock(startUnrealAgentClockGuard(), {
      platform: "darwin",
      wall: NOW,
      mono: 0,
    });
    guard = guardUnrealAgentClock(guard, { platform: "darwin", wall: NOW + 60 * MINUTE, mono: 1 });
    expect(guard.l3Floor).toBe(-Infinity);
  });
});
