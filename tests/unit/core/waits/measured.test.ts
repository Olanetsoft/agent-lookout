import { describe, expect, test } from "vitest";

import {
  addPoll,
  coveredWithin,
  joined,
  POLL_GAP_MS,
  pollRuns,
  type Span,
} from "@core/waits/measured";

const T0 = 1_791_204_000_000;
const SECOND = 1_000;

/** One poll every two seconds from `from` to `to`, both included. */
function polls(from: number, to: number): number[] {
  const times: number[] = [];
  for (let at = from; at <= to; at += 2 * SECOND) times.push(at);
  return times;
}

describe("pollRuns", () => {
  test("polls close together are one stretch, and a gap of more than a few polls ends it", () => {
    const times = [...polls(T0, T0 + 20 * SECOND), ...polls(T0 + 40 * SECOND, T0 + 50 * SECOND)];
    expect(pollRuns(times, [])).toEqual([
      { from: T0, to: T0 + 20 * SECOND },
      { from: T0 + 40 * SECOND, to: T0 + 50 * SECOND },
    ]);
    // Exactly the gap allowed is still one stretch.
    expect(pollRuns([T0, T0 + POLL_GAP_MS], [])).toEqual([{ from: T0, to: T0 + POLL_GAP_MS }]);
  });

  test("a start of Agent Lookout ends a stretch however soon the polls came back, in any order", () => {
    const times = [T0 + 6 * SECOND, T0, T0 + 2 * SECOND];
    expect(pollRuns(times, [T0 + 5 * SECOND, T0 - SECOND])).toEqual([
      { from: T0, to: T0 + 2 * SECOND },
      { from: T0 + 6 * SECOND, to: T0 + 6 * SECOND },
    ]);
  });
});

describe("addPoll", () => {
  test("goes on with the newest stretch, starts another after a gap or a start, and passes over a poll from the past", () => {
    const runs: Span[] = [];
    addPoll(runs, T0);
    addPoll(runs, T0 + 2 * SECOND);
    addPoll(runs, T0 + 20 * SECOND);
    addPoll(runs, T0 + 22 * SECOND, true);
    addPoll(runs, T0 + 10 * SECOND);
    expect(runs).toEqual([
      { from: T0, to: T0 + 2 * SECOND },
      { from: T0 + 20 * SECOND, to: T0 + 20 * SECOND },
      { from: T0 + 22 * SECOND, to: T0 + 22 * SECOND },
    ]);
  });
});

describe("joined and coveredWithin", () => {
  test("stretches that overlap are joined, and the time covered between two moments is added up", () => {
    const spans = joined([
      { from: T0 + 30, to: T0 + 40 },
      { from: T0, to: T0 + 10 },
      { from: T0 + 5, to: T0 + 15 },
    ]);
    expect(spans).toEqual([
      { from: T0, to: T0 + 15 },
      { from: T0 + 30, to: T0 + 40 },
    ]);
    expect(coveredWithin(spans, T0 + 10, T0 + 35)).toBe(10);
    expect(coveredWithin(spans, T0 - 100, T0 + 100)).toBe(25);
    expect(coveredWithin(spans, T0 + 16, T0 + 29)).toBe(0);
    expect(coveredWithin(spans, T0 + 20, T0 + 10)).toBe(0);
  });
});
