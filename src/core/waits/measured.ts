// When Agent Lookout was measuring, as stretches of time, for what reads
// further back than the charts: the totals of how long sessions waited, over a
// day and over seven. The collector works them out from the history points,
// one for each poll, as the dashboard does in `src/dashboard/lib/charts/measured.ts`.
//
// A poll adds a point only when every source it reads answered. Two points
// close enough together were measured in between; two further apart were not.
// A start of Agent Lookout ends a stretch however soon after it the polls came
// back: nothing was measured from the last poll before it to the first after.

/** A stretch of time, epoch milliseconds. */
export interface Span {
  from: number;
  to: number;
}

/**
 * Two polls further apart than this were not measuring in between: three
 * missed polls, with a little slack. The dashboard draws the same breaks.
 */
export const POLL_GAP_MS = 8_000;

/**
 * The unbroken stretches of polls, oldest first: `times` are when each poll
 * was made and `starts` when Agent Lookout started, both in any order. A
 * stretch of one poll is a moment, and covers no time.
 */
export function pollRuns(
  times: readonly number[],
  starts: readonly number[],
  gapMs: number = POLL_GAP_MS,
): Span[] {
  const ordered = [...times].sort((a, b) => a - b);
  const breaks = [...starts].sort((a, b) => a - b);
  const runs: Span[] = [];
  let next = 0;
  for (const at of ordered) {
    const run = runs[runs.length - 1];
    let restarted = false;
    while (next < breaks.length && (breaks[next] as number) <= at) {
      if (run && (breaks[next] as number) > run.to) restarted = true;
      next += 1;
    }
    if (run && !restarted && at - run.to <= gapMs) run.to = Math.max(run.to, at);
    else runs.push({ from: at, to: at });
  }
  return runs;
}

/**
 * The same stretches with one more poll: the newest goes on to it when it came
 * soon enough after, and a new one begins with it otherwise, or when `fresh`
 * says Agent Lookout started since. Changes `runs` in place.
 */
export function addPoll(runs: Span[], at: number, fresh = false, gapMs: number = POLL_GAP_MS) {
  const run = runs[runs.length - 1];
  if (run && !fresh && at >= run.to && at - run.to <= gapMs) {
    run.to = at;
  } else if (!run || fresh || at > run.to) {
    // A new stretch. A poll older than the newest held, by a clock that went back, adds none.
    runs.push({ from: at, to: at });
  }
}

/** Stretches in time order with none overlapping: those that touch or overlap are joined. */
export function joined(spans: readonly Span[]): Span[] {
  const ordered = spans.filter((span) => span.to >= span.from).sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const span of ordered) {
    const last = out[out.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
}

/**
 * How much of `from` to `to` the stretches cover. They must be in time order
 * with none overlapping, as `joined` leaves them.
 */
export function coveredWithin(spans: readonly Span[], from: number, to: number): number {
  if (to <= from) return 0;
  // The first stretch that ends after `from`.
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((spans[middle] as Span).to <= from) low = middle + 1;
    else high = middle;
  }
  let sum = 0;
  for (let index = low; index < spans.length; index += 1) {
    const span = spans[index] as Span;
    if (span.from >= to) break;
    sum += Math.min(span.to, to) - Math.max(span.from, from);
  }
  return sum;
}
