import { expect, test } from "vitest";

import { buildSteps, readAt, type SparkSample, type SparkWindow } from "@dashboard/lib/sparkline";

/** A drawing 120 by 30, with 3 units of room above and below the line. */
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 30;
const buildSparkline = (samples: readonly SparkSample[], window: SparkWindow) =>
  buildSteps(samples, window, { left: 0, right: SPARK_WIDTH, top: 3, bottom: SPARK_HEIGHT - 3 });

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const END = START + 15 * MINUTE;
const WINDOW = { start: START, end: END };

/** One sample every two seconds, as the collector records them. */
function polls(from: number, to: number, value: (at: number) => number) {
  const samples = [];
  for (let at = from; at <= to; at += 2_000) samples.push({ at, value: value(at) });
  return samples;
}

test("with no samples the whole window is unmeasured and no line is drawn", () => {
  const geometry = buildSparkline([], WINDOW);

  expect(geometry.lines).toEqual([]);
  expect(geometry.unmeasured).toEqual([{ x: 0, width: SPARK_WIDTH }]);
  expect(geometry.range).toBeNull();
});

test("time before the first sample is unmeasured, not a line at zero", () => {
  // The collector started 5 minutes ago: the first 10 of 15 minutes have no data.
  const geometry = buildSparkline(
    polls(START + 10 * MINUTE, END, () => 2),
    WINDOW,
  );

  expect(geometry.unmeasured).toEqual([{ x: 0, width: 80 }]);
  expect(geometry.lines).toHaveLength(1);
  // The line begins where measurement begins, two thirds of the way across.
  expect(geometry.lines[0]).toMatch(/^M80 /);
});

test("a full window has no unmeasured span and the line runs edge to edge", () => {
  const geometry = buildSparkline(
    polls(START, END, () => 1),
    WINDOW,
  );

  expect(geometry.unmeasured).toEqual([]);
  expect(geometry.lines).toHaveLength(1);
  expect(geometry.lines[0]).toMatch(/^M0 /);
  expect(geometry.lines[0]).toMatch(new RegExp(`H${SPARK_WIDTH}$`));
});

test("the window ends at the present: a recent last sample is held up to the right edge", () => {
  const geometry = buildSparkline(
    polls(START, END - 3_000, () => 1),
    WINDOW,
  );

  expect(geometry.lines[0]).toMatch(new RegExp(`H${SPARK_WIDTH}$`));
  expect(geometry.unmeasured).toEqual([]);
});

test("when samples stop well before the present, the tail is unmeasured", () => {
  // Data for the first 10 minutes, then nothing: the collector stopped answering.
  const geometry = buildSparkline(
    polls(START, START + 10 * MINUTE, () => 1),
    WINDOW,
  );

  expect(geometry.lines).toHaveLength(1);
  expect(geometry.unmeasured).toEqual([{ x: 80, width: 40 }]);
});

test("a long gap between samples splits the line and is marked unmeasured", () => {
  const geometry = buildSparkline(
    [...polls(START, START + 5 * MINUTE, () => 1), ...polls(START + 10 * MINUTE, END, () => 1)],
    WINDOW,
  );

  expect(geometry.lines).toHaveLength(2);
  expect(geometry.unmeasured).toEqual([{ x: 40, width: 40 }]);
});

test("a count of zero sits on the floor and a higher count rises above it", () => {
  const floor = buildSparkline(
    polls(START, END, () => 0),
    WINDOW,
  );
  const stepped = buildSparkline(
    polls(START, END, (at) => (at < START + 5 * MINUTE ? 0 : 3)),
    WINDOW,
  );

  const yOf = (path: string) => Number(/^M[\d.]+ ([\d.]+)/.exec(path)?.[1]);
  const floorY = yOf(floor.lines[0] ?? "");
  expect(floorY).toBeGreaterThan(SPARK_HEIGHT / 2);
  expect(floorY).toBeLessThan(SPARK_HEIGHT);
  // The stepped line starts on the same floor and then steps up to a smaller y.
  expect(yOf(stepped.lines[0] ?? "")).toBe(floorY);
  expect(stepped.lines[0]).toMatch(/H40V3H120$/);
  expect(stepped.range).toEqual({ min: 0, max: 3 });
});

test("a value only adds to the path when it changes", () => {
  const geometry = buildSparkline(
    polls(START, END, () => 4),
    WINDOW,
  );

  // 451 samples of one value make one move and one horizontal line.
  expect(geometry.lines[0]).toMatch(/^M0 [\d.]+H120$/);
});

test("samples outside the window are ignored", () => {
  const geometry = buildSparkline(
    [
      { at: START - MINUTE, value: 9 },
      ...polls(START, END, () => 1),
      { at: END + MINUTE, value: 9 },
    ],
    WINDOW,
  );

  expect(geometry.range).toEqual({ min: 1, max: 1 });
});

test("the same line can be drawn in any frame, against a ceiling of the caller's choosing", () => {
  // A chart: 30px of axis on the left, a plot 600 wide and 200 tall, topping out at 4.
  const frame = { left: 30, right: 630, top: 10, bottom: 210, ceiling: 4 };
  const geometry = buildSteps(
    polls(START + 5 * MINUTE, END, (at) => (at < START + 10 * MINUTE ? 1 : 2)),
    WINDOW,
    frame,
  );

  // Unmeasured for the first third, from the frame's own left edge.
  expect(geometry.unmeasured).toEqual([{ x: 30, width: 200 }]);
  // 1 of 4 is a quarter of the way up; 2 of 4 is half way. The line ends at the right edge.
  expect(geometry.lines).toEqual(["M230 160H430V110H630"]);
  expect(geometry.areas).toEqual(["M230 160H430V110H630V210H230Z"]);
  expect(geometry.range).toEqual({ min: 1, max: 2 });
});

test("without a ceiling, a steady count is drawn at the top whatever its size", () => {
  const frame = { left: 0, right: 100, top: 0, bottom: 100 };
  const one = buildSteps(
    polls(START, END, () => 1),
    WINDOW,
    frame,
  );
  const five = buildSteps(
    polls(START, END, () => 5),
    WINDOW,
    frame,
  );

  expect(one.lines).toEqual(five.lines);
  // With a shared ceiling the two are told apart.
  const shared = { ...frame, ceiling: 5 };
  expect(
    buildSteps(
      polls(START, END, () => 1),
      WINDOW,
      shared,
    ).lines,
  ).toEqual(["M0 80H100"]);
  expect(
    buildSteps(
      polls(START, END, () => 5),
      WINDOW,
      shared,
    ).lines,
  ).toEqual(["M0 0H100"]);
});

test("the count at a moment is the latest sample at or before it", () => {
  const { runs } = buildSparkline(
    polls(START, END, (at) => (at < START + 5 * MINUTE ? 0 : 3)),
    WINDOW,
  );

  expect(readAt(runs, START + MINUTE)?.value).toBe(0);
  expect(readAt(runs, START + 5 * MINUTE - 1)?.value).toBe(0);
  expect(readAt(runs, START + 5 * MINUTE)?.value).toBe(3);
  expect(readAt(runs, START + 5 * MINUTE + 1_999)).toEqual({ at: START + 5 * MINUTE, value: 3 });
  expect(readAt(runs, END)?.value).toBe(3);
});

test("a moment that was not measured reads as null, never as zero", () => {
  const { runs } = buildSparkline(
    [
      ...polls(START + 2 * MINUTE, START + 5 * MINUTE, () => 2),
      ...polls(START + 10 * MINUTE, END - MINUTE, () => 1),
    ],
    WINDOW,
  );

  // Before the collector started, in the gap, and after it stopped answering.
  expect(readAt(runs, START + MINUTE)).toBeNull();
  expect(readAt(runs, START + 7 * MINUTE)).toBeNull();
  expect(readAt(runs, END - 10_000)).toBeNull();
  // Inside each measured stretch there is a reading.
  expect(readAt(runs, START + 3 * MINUTE)?.value).toBe(2);
  expect(readAt(runs, START + 12 * MINUTE)?.value).toBe(1);
  expect(readAt([], START)).toBeNull();
});

test("a reading in the stretch held to an edge is the nearest sample", () => {
  // The first sample is 3 seconds in and the last is 3 seconds from the end: both
  // are close enough for the line to reach the edges.
  const { runs } = buildSparkline(
    polls(START + 3_000, END - 3_000, () => 2),
    WINDOW,
  );

  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ from: START, to: END });
  expect(readAt(runs, START)?.value).toBe(2);
  expect(readAt(runs, END)?.value).toBe(2);
});
