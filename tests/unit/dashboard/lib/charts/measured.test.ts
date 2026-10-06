import { expect, test } from "vitest";

import {
  pollRuns,
  quietPhrase,
  restartTimes,
  uncovered,
  type Span,
} from "@dashboard/lib/charts/measured";

const MINUTE = 60_000;

/** A moment on the local clock, on one ordinary winter day. */
const at = (hours: number, minutes: number) => new Date(2026, 0, 5, hours, minutes).getTime();

const HOUR: Span = { from: at(13, 30), to: at(14, 30) };

test("an hour measured from end to end is the last hour", () => {
  expect(quietPhrase(HOUR, [])).toBe("in the last hour");
  expect(quietPhrase(HOUR, [], "in the last fifteen minutes")).toBe("in the last fifteen minutes");
});

test("an hour measured only since a moment inside it is said from that moment", () => {
  // Agent Lookout started at 14:28, two minutes before the present.
  const gaps = uncovered([{ from: at(14, 28), to: at(14, 30) }], HOUR);
  expect(quietPhrase(HOUR, gaps)).toBe("since 14:28");
});

test("an hour with a break in it, or with its end not measured, is said of the time measured", () => {
  const broken = uncovered(
    [
      { from: at(13, 30), to: at(13, 50) },
      { from: at(14, 0), to: at(14, 30) },
    ],
    HOUR,
  );
  expect(quietPhrase(HOUR, broken)).toBe("in the time measured");

  const stopped = uncovered([{ from: at(13, 30), to: at(14, 10) }], HOUR);
  expect(quietPhrase(HOUR, stopped)).toBe("in the time measured");

  const late = uncovered([{ from: at(13, 45), to: at(14, 20) }], HOUR);
  expect(quietPhrase(HOUR, late)).toBe("in the time measured");
});

test("an hour nobody measured has nothing to be said of", () => {
  expect(quietPhrase(HOUR, [HOUR])).toBeNull();
  expect(quietPhrase(HOUR, uncovered([], HOUR))).toBeNull();
  // A minute short of the whole is still something measured.
  expect(quietPhrase(HOUR, [{ from: HOUR.from, to: HOUR.to - MINUTE }])).toBe("since 14:29");
});

/** Polls every two seconds from `from` up to and including `to`. */
function polls(from: number, to: number) {
  const points = [];
  for (let moment = from; moment <= to; moment += 2_000) {
    points.push({ at: moment, needsYou: 0, working: 1, idle: 0, total: 1 });
  }
  return points;
}

test("polls close together are one run, and a break longer than the gap ends it", () => {
  const T = at(14, 0);
  const history = {
    startedAt: T,
    points: [...polls(T, T + 10_000), ...polls(T + 30_000, T + 40_000)],
  };
  expect(pollRuns(history, T + 41_000, 8_000)).toEqual([
    { from: T, to: T + 10_000 },
    { from: T + 30_000, to: T + 41_000 },
  ]);
});

test("a restart ends a run however soon the polls came back, and so does this run's start", () => {
  const T = at(14, 0);
  // Stopped for three seconds at T + 10 s, and again at T + 24 s, when this run began.
  const history = {
    startedAt: T + 26_000,
    points: [
      ...polls(T, T + 10_000),
      ...polls(T + 13_000, T + 23_000),
      ...polls(T + 26_500, T + 40_500),
    ],
    restarts: [{ at: T + 12_500, lastBefore: T + 10_000 }],
  };
  expect(pollRuns(history, T + 41_000, 8_000)).toEqual([
    { from: T, to: T + 10_000 },
    { from: T + 13_000, to: T + 23_000 },
    { from: T + 26_500, to: T + 41_000 },
  ]);
  expect(restartTimes(history)).toEqual([T + 12_500, T + 26_000]);
  // Without restarts, the start of this run alone ends the run before it.
  expect(pollRuns({ ...history, restarts: [] }, T + 41_000, 8_000)).toEqual([
    { from: T, to: T + 23_000 },
    { from: T + 26_500, to: T + 41_000 },
  ]);
});
