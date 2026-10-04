/**
 * Geometry for a step line of counts over a time window. The chart in a history
 * dialog is drawn from it.
 *
 * Two rules come from the design system. The window ends at the present, not at
 * the newest sample. And time that was not measured is returned as its own span,
 * so the caller draws it as unmeasured instead of as a line at zero.
 *
 * Counts change in whole steps, so the line is a step line: a value holds until
 * the next sample says otherwise.
 */

/** A span narrower than this, in drawing units, is not worth drawing. */
const MIN_SPAN = 0.75;

export interface SparkSample {
  at: number;
  value: number;
}

export interface SparkWindow {
  /** Epoch milliseconds at the left edge. */
  start: number;
  /** Epoch milliseconds at the right edge: the present. */
  end: number;
  /** Two samples further apart than this were not measured in between. */
  gapMs?: number;
}

/** The box the line is drawn in, in the drawing's own units. */
export interface StepFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The value drawn at the top. Defaults to the highest value in the window, and at least 1. */
  ceiling?: number;
}

export interface SparkSpan {
  x: number;
  width: number;
}

/** A stretch of time that was measured without a break. */
export interface StepRun {
  /** Where the line for this run starts and ends, in epoch milliseconds. */
  from: number;
  to: number;
  /** In time order. */
  samples: SparkSample[];
}

export interface SparkGeometry {
  /** One open path per continuous run of samples. */
  lines: string[];
  /** The same runs closed down to the floor, for a faint fill. */
  areas: string[];
  /** Stretches of the window with no measurement. */
  unmeasured: SparkSpan[];
  /** Lowest and highest value in the window, or null when nothing was measured. */
  range: { min: number; max: number } | null;
  /** The measured stretches, for reading the value at a point in time. */
  runs: StepRun[];
}

/** Three missed polls, with a little slack. */
export const DEFAULT_GAP_MS = 8_000;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The step line of `samples` over `window`, drawn inside `frame`. */
export function buildSteps(
  samples: readonly SparkSample[],
  window: SparkWindow,
  frame: StepFrame,
): SparkGeometry {
  const { start, end } = window;
  const gapMs = window.gapMs ?? DEFAULT_GAP_MS;
  const span = end - start;
  const width = frame.right - frame.left;
  const inWindow = samples
    .filter((sample) => sample.at >= start && sample.at <= end && Number.isFinite(sample.value))
    .sort((a, b) => a.at - b.at);

  if (span <= 0 || inWindow.length === 0) {
    return {
      lines: [],
      areas: [],
      unmeasured: [{ x: frame.left, width }],
      range: null,
      runs: [],
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const sample of inWindow) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
  }
  // A flat line at zero sits on the floor. Anything above zero uses the full height.
  const ceiling = Math.max(1, frame.ceiling ?? max);
  const xOf = (at: number) => round(frame.left + ((at - start) / span) * width);
  const yOf = (value: number) =>
    round(frame.bottom - (Math.min(value, ceiling) / ceiling) * (frame.bottom - frame.top));

  // Split into runs wherever the gap between two samples is too long to bridge.
  const groups: SparkSample[][] = [];
  for (const sample of inWindow) {
    const group = groups[groups.length - 1];
    const previous = group?.[group.length - 1];
    if (group && previous && sample.at - previous.at <= gapMs) group.push(sample);
    else groups.push([sample]);
  }

  const lines: string[] = [];
  const areas: string[] = [];
  const covered: SparkSpan[] = [];
  const runs: StepRun[] = [];

  groups.forEach((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) return;

    // The first run reaches back to the left edge when it starts close to it, and
    // the last run reaches forward to the present when it ends close to it.
    const fromAt = index === 0 && first.at - start <= gapMs ? start : first.at;
    const toAt = index === groups.length - 1 && end - last.at <= gapMs ? end : last.at;
    const from = xOf(fromAt);
    const to = xOf(toAt);

    let path = `M${from} ${yOf(first.value)}`;
    let current = first.value;
    for (const sample of group) {
      if (sample.value === current) continue;
      path += `H${xOf(sample.at)}V${yOf(sample.value)}`;
      current = sample.value;
    }
    path += `H${to}`;

    lines.push(path);
    areas.push(`${path}V${frame.bottom}H${from}Z`);
    covered.push({ x: from, width: to - from });
    runs.push({ from: fromAt, to: toAt, samples: group });
  });

  // Everything the runs do not cover was not measured.
  const unmeasured: SparkSpan[] = [];
  let cursor = frame.left;
  for (const piece of covered) {
    if (piece.x - cursor >= MIN_SPAN) {
      unmeasured.push({ x: round(cursor), width: round(piece.x - cursor) });
    }
    cursor = Math.max(cursor, piece.x + piece.width);
  }
  if (frame.right - cursor >= MIN_SPAN) {
    unmeasured.push({ x: round(cursor), width: round(frame.right - cursor) });
  }

  return { lines, areas, unmeasured, range: { min, max }, runs };
}

/**
 * The count at a point in time: the latest sample at or before it, inside a
 * measured run. Null means that moment was not measured, which is not zero.
 */
export function readAt(runs: readonly StepRun[], at: number): SparkSample | null {
  for (const run of runs) {
    if (at < run.from || at > run.to) continue;
    // Binary search for the last sample at or before `at`.
    let low = 0;
    let high = run.samples.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((run.samples[middle] as SparkSample).at <= at) low = middle;
      else high = middle - 1;
    }
    // Before the run's first sample, in the stretch held back to the left edge,
    // the first sample is the nearest thing known.
    return run.samples[low] ?? null;
  }
  return null;
}
