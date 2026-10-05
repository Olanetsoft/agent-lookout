/**
 * The Last hour chart: how many sessions were waiting on the person, working or
 * idle, on average, in each five minutes of the hour that ends now. Built in the
 * page from the history it already holds, with the snapshot and the events to
 * tell a wait still open from one that was answered.
 *
 * The history has a point every poll with the counts of that moment. A count
 * holds from one point to the next, so a bucket's mean is the time-weighted
 * mean of those counts over the part of the bucket that was measured. Time
 * nobody measured is never averaged in and never drawn as zero: it is returned
 * as its own spans, and a bucket with nothing measured has no mean at all.
 */

import type { HistoryResponse } from "@core/api";
import type { Session, SessionEvent } from "@core/sessions/session";
import { countAxis, type CountAxis } from "@dashboard/lib/charts/historyChart";
import {
  intersect,
  lengthOf,
  measuredSpans,
  pollRuns,
  uncovered,
  type Span,
} from "@dashboard/lib/charts/measured";
import { DEFAULT_GAP_MS } from "@dashboard/lib/charts/sparkline";

const MINUTE = 60_000;

/** The chart covers the hour that ends now. */
export const LAST_HOUR_MS = 60 * MINUTE;
/** One bar for every five minutes on the clock. */
export const BUCKET_MS = 5 * MINUTE;

/** The mean number of sessions in each status over the measured part of a bucket. */
export interface LastHourMeans {
  /** Waiting on the person, in a wait still open. */
  open: number;
  /** Waiting on the person, in a wait that has since been answered. */
  answered: number;
  working: number;
  idle: number;
  /** The four together: how tall the bar is. */
  total: number;
}

export interface LastHourBucket {
  /** Where the bucket begins: a five-minute mark, or the window's left edge for the first. */
  from: number;
  /** Where it ends: the next mark, or the present for the last. */
  to: number;
  /** The parts of it that were measured, oldest first. Empty when none was. */
  measured: Span[];
  /** How long was measured, in milliseconds. */
  measuredMs: number;
  /** The means over the measured part, or null when nothing in it was measured. */
  means: LastHourMeans | null;
}

export interface LastHour {
  /** Left edge of the window. */
  start: number;
  /** Right edge: the present. */
  end: number;
  /** Oldest first. */
  buckets: LastHourBucket[];
  /** The stretches of the window nobody measured, oldest first. */
  unmeasured: Span[];
  /** How long sessions waited on the person inside the window, in all: each waiting session's time, added up. */
  waitedMs: number;
  /** Of that, the time inside waits still open. */
  openMs: number;
  /** The count axis the bars stand on. */
  axis: CountAxis;
}

export interface LastHourInput {
  /** The history the page holds, or null when it could not be read. */
  history: HistoryResponse | null;
  /** The sessions in the latest snapshot. They say which waits are still open. */
  sessions: readonly Pick<Session, "id" | "status" | "statusSince">[];
  /** Every event the page holds, in any order. */
  events: readonly Pick<SessionEvent, "sessionId" | "at" | "to">[];
  /** The present. The window ends here. */
  now: number;
  /** The last answer. Nothing after it was measured. */
  asOf?: number;
  /** Two polls further apart than this were not measuring in between. */
  gapMs?: number;
  windowMs?: number;
}

/**
 * The first five-minute mark at or before `at` on the local clock. Rounded on
 * the local clock, as the time axis is, so a zone at a half or three quarters of
 * an hour still gets bars that start at :00, :05 and so on.
 */
export function bucketMark(at: number): number {
  const offset = new Date(at).getTimezoneOffset() * MINUTE;
  return Math.floor((at - offset) / BUCKET_MS) * BUCKET_MS + offset;
}

/**
 * When each wait still open began, oldest first: the time its source reports,
 * or else the event that began it, or else as far back as anything goes. A
 * session that needs the person now is the only kind with an open wait.
 */
function openWaitStarts(
  sessions: LastHourInput["sessions"],
  events: LastHourInput["events"],
): number[] {
  const starts: number[] = [];
  for (const session of sessions) {
    if (session.status !== "needs-you") continue;
    if (session.statusSince !== null) {
      starts.push(session.statusSince);
      continue;
    }
    let began = -Infinity;
    for (const event of events) {
      if (event.sessionId === session.id && event.to === "needs-you" && event.at > began) {
        began = event.at;
      }
    }
    starts.push(began);
  }
  return starts.sort((a, b) => a - b);
}

/** A stretch with one set of counts: from one poll to the next. */
interface Step extends Span {
  needsYou: number;
  working: number;
  idle: number;
}

/**
 * The history as steps. A count holds from its poll to the next one, and the
 * newest holds up to `until` while polls are still arriving. The first count
 * also stands for the moment before it, where the oldest run is taken to reach
 * back to the window's edge; the measured spans say whether it does.
 */
function stepsOf(history: HistoryResponse, until: number, gapMs: number): Step[] {
  const points = [...history.points].sort((a, b) => a.at - b.at);
  const steps: Step[] = [];
  const first = points[0];
  if (first) steps.push({ ...first, from: -Infinity, to: first.at });
  points.forEach((point, index) => {
    const next = points[index + 1];
    let to = point.at;
    if (next && next.at - point.at <= gapMs) to = next.at;
    else if (!next && until > point.at && until - point.at <= gapMs) to = until;
    if (to > point.at) steps.push({ ...point, from: point.at, to });
  });
  return steps;
}

/**
 * The Last hour chart, from the history the page holds.
 *
 * Buckets sit on the clock's five-minute marks, so only the last one changes as
 * time passes. The first is cut by the window's left edge and the last ends at
 * the present, which gives thirteen whenever the present falls between marks.
 *
 * Needs you is split into waits still open and waits answered: at each moment,
 * as many of the waiting sessions as had begun the wait that is open now are
 * open, and the rest of the count were answered since.
 */
export function buildLastHour(input: LastHourInput): LastHour {
  const { history, now } = input;
  const gapMs = input.gapMs ?? DEFAULT_GAP_MS;
  const start = now - (input.windowMs ?? LAST_HOUR_MS);
  const window: Span = { from: start, to: now };
  const until = Math.min(input.asOf ?? now, now);

  const runs = pollRuns(history, until, gapMs);
  const measured = measuredSpans(runs, window, until, history?.startedAt ?? -Infinity, gapMs);

  const buckets: LastHourBucket[] = [];
  for (let mark = bucketMark(start); mark < now; mark += BUCKET_MS) {
    const from = Math.max(mark, start);
    const to = Math.min(mark + BUCKET_MS, now);
    if (to <= from) continue;
    const parts = intersect(measured, [{ from, to }]);
    buckets.push({ from, to, measured: parts, measuredMs: lengthOf(parts), means: null });
  }

  // Time-weighted sums of each count, bucket by bucket.
  const sums = buckets.map(() => ({ open: 0, answered: 0, working: 0, idle: 0 }));
  const starts = openWaitStarts(input.sessions, input.events);
  const openAt = (at: number) => starts.filter((began) => began <= at).length;
  let waitedMs = 0;
  let openMs = 0;

  if (history) {
    for (const step of stepsOf(history, until, gapMs)) {
      for (const part of intersect([step], measured)) {
        // Cut where an open wait began, so the split holds across each piece.
        const cuts = [part.from, ...starts.filter((at) => at > part.from && at < part.to), part.to];
        for (let index = 0; index < cuts.length - 1; index += 1) {
          const a = cuts[index] as number;
          const b = cuts[index + 1] as number;
          const open = Math.min(step.needsYou, openAt(a));
          const answered = step.needsYou - open;
          waitedMs += step.needsYou * (b - a);
          openMs += open * (b - a);
          buckets.forEach((bucket, at) => {
            const length = Math.min(b, bucket.to) - Math.max(a, bucket.from);
            if (length <= 0) return;
            const sum = sums[at] as (typeof sums)[number];
            sum.open += open * length;
            sum.answered += answered * length;
            sum.working += step.working * length;
            sum.idle += step.idle * length;
          });
        }
      }
    }
  }

  let highest = 0;
  buckets.forEach((bucket, index) => {
    if (bucket.measuredMs <= 0) return;
    const sum = sums[index] as (typeof sums)[number];
    const mean = (value: number) => value / bucket.measuredMs;
    const means = {
      open: mean(sum.open),
      answered: mean(sum.answered),
      working: mean(sum.working),
      idle: mean(sum.idle),
      total: 0,
    };
    means.total = means.open + means.answered + means.working + means.idle;
    bucket.means = means;
    if (means.total > highest) highest = means.total;
  });

  return {
    start,
    end: now,
    buckets,
    unmeasured: uncovered(measured, window),
    waitedMs,
    openMs,
    axis: countAxis(highest),
  };
}
