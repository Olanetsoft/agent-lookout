/**
 * When the collector was measuring, worked out from the history the page holds.
 * The timeline, the Last hour chart and the bars of waits all ask the same
 * question, so they share one answer.
 *
 * The collector adds a history point every poll. Two points close enough
 * together were measured in between; two further apart than `gapMs` were not.
 */

import type { HistoryResponse } from "@core/api";
import { formatClockMinutes } from "@dashboard/lib/format";

/** A stretch of time, epoch milliseconds. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The moments Agent Lookout started again, oldest first: each restart the
 * history lists, and the start of the run that answered.
 */
export function restartTimes(history: Pick<HistoryResponse, "startedAt" | "restarts">): number[] {
  const times = new Set((history.restarts ?? []).map((restart) => restart.at));
  times.add(history.startedAt);
  return [...times].sort((a, b) => a - b);
}

/**
 * The unbroken runs of polls, oldest first. A value holds from one poll to the
 * next, so the newest run reaches `until` while polls are still arriving. A
 * restart of Agent Lookout ends a run, however soon after it the polls came
 * back: nothing was measured from the last poll before it to the first after.
 */
export function pollRuns(history: HistoryResponse | null, until: number, gapMs: number): Span[] {
  const runs: Span[] = [];
  if (!history) return runs;
  const times = history.points.map((point) => point.at).sort((a, b) => a - b);
  const restarts = restartTimes(history);
  let next = 0;
  let run: Span | null = null;
  for (const at of times) {
    let restarted = false;
    while (next < restarts.length && (restarts[next] as number) <= at) {
      if (run && (restarts[next] as number) > run.to) restarted = true;
      next += 1;
    }
    if (run && !restarted && at - run.to <= gapMs) run.to = at;
    else runs.push((run = { from: at, to: at }));
  }
  if (run && until > run.to && until - run.to <= gapMs) run.to = until;
  return runs;
}

/**
 * The time the page can vouch for inside the window: the runs of polls, from the
 * collector's start or the oldest event held, up to the last answer.
 */
export function measuredSpans(
  runs: readonly Span[],
  window: Span,
  until: number,
  vouchFrom: number,
  gapMs: number,
): Span[] {
  const spans: Span[] = [];
  runs.forEach((run, index) => {
    // The oldest run held is taken to cover the edge of the window when it
    // starts just inside it: the poll before it is simply not held any more.
    const bridged =
      index === 0 && run.from > window.from && run.from - window.from <= gapMs
        ? window.from
        : run.from;
    const from = Math.max(bridged, window.from, vouchFrom);
    const to = Math.min(run.to, window.to, until);
    if (to > from) spans.push({ from, to });
  });
  return spans;
}

/** The parts of `window` that no span covers, oldest first. */
export function uncovered(spans: readonly Span[], window: Span): Span[] {
  const gaps: Span[] = [];
  let cursor = window.from;
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    if (span.to <= cursor) continue;
    if (span.from > cursor) gaps.push({ from: cursor, to: Math.min(span.from, window.to) });
    cursor = Math.max(cursor, span.to);
    if (cursor >= window.to) break;
  }
  if (cursor < window.to) gaps.push({ from: cursor, to: window.to });
  return gaps.filter((gap) => gap.to > gap.from);
}

/** The parts two lists of spans have in common, oldest first. */
export function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const shared: Span[] = [];
  for (const left of a) {
    for (const right of b) {
      const from = Math.max(left.from, right.from);
      const to = Math.min(left.to, right.to);
      if (to > from) shared.push({ from, to });
    }
  }
  return shared.sort((x, y) => x.from - y.from);
}

/** How long a list of spans lasts in all. */
export function lengthOf(spans: readonly Span[]): number {
  return spans.reduce((sum, span) => sum + (span.to - span.from), 0);
}

/**
 * How to say that no session ran in a window, given the parts of it nobody
 * measured, so time nobody measured is never called empty:
 *
 *   every part measured         "in the last hour"
 *   only its start not measured "since 13:28", from when measuring began
 *   a break, or its end missing "in the time measured"
 *   nothing measured            null: there is nothing to say it of
 */
export function quietPhrase(
  window: Span,
  unmeasured: readonly Span[],
  whole = "in the last hour",
): string | null {
  if (unmeasured.length === 0) return whole;
  const first = unmeasured[0] as Span;
  if (lengthOf(unmeasured) >= window.to - window.from) return null;
  if (unmeasured.length === 1 && first.from <= window.from) {
    return `since ${formatClockMinutes(first.to)}`;
  }
  return "in the time measured";
}
