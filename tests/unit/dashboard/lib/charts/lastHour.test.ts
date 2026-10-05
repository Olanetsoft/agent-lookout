import { describe, expect, test, vi } from "vitest";

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint, Session, SessionEvent } from "@core/sessions/session";
import { countAxis, timeTicks } from "@dashboard/lib/charts/historyChart";
import {
  BUCKET_MS,
  buildLastHour,
  LAST_HOUR_MS,
  type LastHourBucket,
  type LastHourInput,
} from "@dashboard/lib/charts/lastHour";
import { makeSession } from "@tests/fixtures/session";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * The environment of the process the unit tests run in. They run in Node, but
 * the dashboard's tests are checked as browser code, with no Node types.
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } })
  .process.env;

/** Runs `run` with the clock in this time zone, and puts the zone back afterwards. */
function inTimeZone(zone: string, run: () => void): void {
  const before = env.TZ;
  env.TZ = zone;
  try {
    run();
  } finally {
    if (before === undefined) delete env.TZ;
    else env.TZ = before;
  }
}

/** A moment on the local clock, on one ordinary winter day. */
const at = (hours: number, minutes: number, seconds = 0) =>
  new Date(2026, 0, 5, hours, minutes, seconds).getTime();

/** The present, between two five-minute marks. */
const NOW = at(14, 32, 30);

type Counts = Pick<HistoryPoint, "needsYou" | "working" | "idle">;

/** One point every two seconds, the way the collector polls, from `from` up to and including `to`. */
function polls(from: number, to: number, counts: Partial<Counts> = {}): HistoryPoint[] {
  const { needsYou = 0, working = 0, idle = 1 } = counts;
  const points: HistoryPoint[] = [];
  for (let moment = from; moment <= to; moment += 2 * SECOND) {
    points.push({ at: moment, needsYou, working, idle, total: needsYou + working + idle });
  }
  return points;
}

/** History made of stretches of polls, each with its counts. */
function history(startedAt: number, ...stretches: HistoryPoint[][]): HistoryResponse {
  return { startedAt, points: stretches.flat().sort((a, b) => a.at - b.at) };
}

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function waiting(n: number, statusSince: number | null): Session {
  return makeSession({ id: id(n), name: `project-${n}`, status: "needs-you", statusSince });
}

function waitBegan(n: number, moment: number): SessionEvent {
  return {
    id: `event-${n}-${moment}`,
    at: moment,
    sessionId: id(n),
    sessionName: `project-${n}`,
    kind: "status-changed",
    from: "working",
    to: "needs-you",
    severity: "warning",
  };
}

function lastHour(input: Partial<LastHourInput>) {
  return buildLastHour({ history: null, sessions: [], events: [], now: NOW, ...input });
}

/** The bucket that starts at this moment. */
function bucketAt(buckets: readonly LastHourBucket[], from: number): LastHourBucket {
  const bucket = buckets.find((candidate) => candidate.from === from);
  if (!bucket) throw new Error(`No bucket starts at ${new Date(from).toString()}`);
  return bucket;
}

/** A whole hour of steady polls up to the present. */
const steadyHour = (counts: Partial<Counts>) =>
  history(NOW - 2 * LAST_HOUR_MS, polls(NOW - 2 * LAST_HOUR_MS, NOW, counts));

describe("buckets", () => {
  test("sit on the local clock's five-minute marks: the first is cut by the window and the last ends at now", () => {
    const { start, end, buckets } = lastHour({ history: steadyHour({ working: 1 }) });

    expect(start).toBe(NOW - LAST_HOUR_MS);
    expect(end).toBe(NOW);
    // 13:32:30 to 14:32:30: a sliver from 13:32:30 to 13:35, eleven whole buckets,
    // and 14:30 to now. Thirteen in all, whenever the present is between marks.
    expect(buckets).toHaveLength(13);
    expect(buckets[0]).toMatchObject({ from: at(13, 32, 30), to: at(13, 35) });
    expect(buckets[1]).toMatchObject({ from: at(13, 35), to: at(13, 40) });
    expect(buckets[12]).toMatchObject({ from: at(14, 30), to: NOW });
    // Side by side, with nothing between them.
    buckets.slice(1).forEach((bucket, index) => {
      expect(bucket.from).toBe(buckets[index]?.to);
    });
  });

  test("are twelve whole buckets when the present falls on a mark", () => {
    const now = at(14, 35);
    const { buckets } = lastHour({ now, history: steadyHour({ working: 1 }) });

    expect(buckets).toHaveLength(12);
    expect(buckets[0]).toMatchObject({ from: at(13, 35), to: at(13, 40) });
    expect(buckets[11]).toMatchObject({ from: at(14, 30), to: now });
    for (const bucket of buckets) expect(bucket.to - bucket.from).toBe(BUCKET_MS);
  });

  test.each(["UTC", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham", "America/St_Johns"])(
    "fall on five-minute marks of the local clock in %s, a half or three quarters of an hour off included",
    (zone) => {
      inTimeZone(zone, () => {
        const now = Date.UTC(2026, 0, 5, 14, 32, 30);
        const { buckets } = buildLastHour({
          history: {
            startedAt: now - 2 * LAST_HOUR_MS,
            points: polls(now - 2 * LAST_HOUR_MS, now),
          },
          sessions: [],
          events: [],
          now,
        });

        expect(buckets).toHaveLength(13);
        // Every edge but the window's own two is a mark on this zone's clock.
        for (const bucket of buckets.slice(1)) {
          const local = new Date(bucket.from);
          expect(local.getMinutes() % 5, local.toString()).toBe(0);
          expect(local.getSeconds(), local.toString()).toBe(0);
        }
        expect(buckets[0]?.from).toBe(now - LAST_HOUR_MS);
        expect(buckets[12]?.to).toBe(now);
      });
    },
  );
});

test("edges fall on the marks the time axis draws, whatever the zone's offset", () => {
  // No zone today sits off the five-minute grid, so one is made up: five hours
  // and 37 minutes ahead. Rounding on UTC would put every edge two minutes off
  // the axis's marks.
  const offset = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-337);
  try {
    const now = Date.UTC(2026, 0, 5, 14, 32, 30);
    const { buckets, start } = buildLastHour({
      history: { startedAt: now - 2 * LAST_HOUR_MS, points: polls(now - 2 * LAST_HOUR_MS, now) },
      sessions: [],
      events: [],
      now,
    });
    const marks = new Set(timeTicks(start, now, 12));

    expect(marks.size).toBe(12);
    for (const bucket of buckets.slice(1)) {
      expect(marks.has(bucket.from), new Date(bucket.from).toISOString()).toBe(true);
    }
    expect((buckets[1]!.from - Date.UTC(2026, 0, 5)) % BUCKET_MS).not.toBe(0);
  } finally {
    offset.mockRestore();
  }
});

describe("means", () => {
  test("are weighted by time: a count holds from its poll to the next", () => {
    // From 14:20 to 14:25, every ten seconds: four working at the poll, then none
    // at a poll eight seconds on. Four for eight seconds in ten is a mean of 3.2.
    // Taking each poll alike would say 2.
    const uneven: HistoryPoint[] = [];
    for (let moment = at(14, 20); moment < at(14, 25); moment += 10 * SECOND) {
      uneven.push({ at: moment, needsYou: 0, working: 4, idle: 0, total: 4 });
      uneven.push({ at: moment + 8 * SECOND, needsYou: 0, working: 0, idle: 0, total: 0 });
    }
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 19, 58), { working: 0, idle: 0 }),
        uneven,
        polls(at(14, 25), NOW, { working: 0, idle: 0 }),
      ),
    });

    const bucket = bucketAt(hour.buckets, at(14, 20));
    expect(bucket.measuredMs).toBe(5 * MINUTE);
    expect(bucket.means?.working).toBeCloseTo(3.2, 10);
    expect(bucket.means?.total).toBeCloseTo(3.2, 10);
  });

  test("of a partly watched bucket are over the part that was measured, and its bar spans only that part", () => {
    // Watching began at 14:07: two working for a minute, then four for two.
    const hour = lastHour({
      history: history(
        at(14, 7),
        polls(at(14, 7), at(14, 7, 58), { working: 2, idle: 0 }),
        polls(at(14, 8), NOW, { working: 4, idle: 0 }),
      ),
    });

    const bucket = bucketAt(hour.buckets, at(14, 5));
    expect(bucket.measured).toEqual([{ from: at(14, 7), to: at(14, 10) }]);
    expect(bucket.measuredMs).toBe(3 * MINUTE);
    // (2 x 1 minute + 4 x 2 minutes) over 3 minutes, not over the bucket's 5.
    expect(bucket.means?.working).toBeCloseTo(10 / 3, 10);
    // The rest of the bucket is unmeasured, back to the window's edge.
    expect(hour.unmeasured).toEqual([{ from: NOW - LAST_HOUR_MS, to: at(14, 7) }]);
  });

  test("leave out a break that straddles a bucket's edge, on both sides of it", () => {
    // Polls stopped at 14:13 and began again at 14:17.
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 13), { working: 2, idle: 0 }),
        polls(at(14, 17), NOW, { working: 0, idle: 3 }),
      ),
    });

    const before = bucketAt(hour.buckets, at(14, 10));
    const after = bucketAt(hour.buckets, at(14, 15));
    expect(before.measured).toEqual([{ from: at(14, 10), to: at(14, 13) }]);
    expect(after.measured).toEqual([{ from: at(14, 17), to: at(14, 20) }]);
    // Each bucket's mean is of what was seen in it: nothing of the other side,
    // and no zero for the break.
    expect(before.means).toMatchObject({ working: 2, idle: 0, total: 2 });
    expect(after.means).toMatchObject({ working: 0, idle: 3, total: 3 });
    expect(hour.unmeasured).toEqual([{ from: at(14, 13), to: at(14, 17) }]);
  });

  test("a bucket with nothing measured in it has no means at all, and is unmeasured from edge to edge", () => {
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 0), { working: 1 }),
        polls(at(14, 11), NOW, { working: 1 }),
      ),
    });

    const empty = bucketAt(hour.buckets, at(14, 5));
    expect(empty.means).toBeNull();
    expect(empty.measured).toEqual([]);
    expect(empty.measuredMs).toBe(0);
    expect(hour.unmeasured).toEqual([{ from: at(14, 0), to: at(14, 11) }]);
  });

  test("time before Agent Lookout started is unmeasured, whatever the points say", () => {
    // Points from before the start belong to no measurement this run vouches for.
    const hour = lastHour({
      history: history(
        at(14, 7),
        polls(at(13, 0), at(14, 6, 58), { working: 9, idle: 0 }),
        polls(at(14, 7), NOW, { working: 1, idle: 0 }),
      ),
    });

    expect(bucketAt(hour.buckets, at(13, 55)).means).toBeNull();
    const first = bucketAt(hour.buckets, at(14, 5));
    expect(first.measured).toEqual([{ from: at(14, 7), to: at(14, 10) }]);
    expect(first.means?.working).toBe(1);
    expect(hour.unmeasured[0]).toEqual({ from: NOW - LAST_HOUR_MS, to: at(14, 7) });
  });

  test("once answers stop, the time after the last one is unmeasured, though the clock goes on", () => {
    const asOf = at(14, 28);
    const hour = lastHour({ asOf, history: steadyHour({ working: 2, idle: 0 }) });

    expect(bucketAt(hour.buckets, at(14, 25)).measured).toEqual([{ from: at(14, 25), to: asOf }]);
    expect(bucketAt(hour.buckets, at(14, 30)).means).toBeNull();
    expect(hour.unmeasured).toEqual([{ from: asOf, to: NOW }]);
    // The bars still end at the present.
    expect(hour.end).toBe(NOW);
  });

  test("zero sessions, measured, are a mean of zero, and not unmeasured", () => {
    const hour = lastHour({
      history: history(at(14, 0), polls(at(14, 0), NOW, { working: 0, idle: 0 })),
    });

    const quiet = bucketAt(hour.buckets, at(14, 10));
    expect(quiet.means).toEqual({ open: 0, answered: 0, working: 0, idle: 0, total: 0 });
    expect(quiet.measuredMs).toBe(5 * MINUTE);
    expect(bucketAt(hour.buckets, at(13, 55)).means).toBeNull();
    expect(hour.unmeasured).toEqual([{ from: NOW - LAST_HOUR_MS, to: at(14, 0) }]);
  });

  test("without the history nothing was measured: every bucket is empty and the whole hour unmeasured", () => {
    const hour = lastHour({ history: null });

    expect(hour.buckets).toHaveLength(13);
    expect(hour.buckets.every((bucket) => bucket.means === null)).toBe(true);
    expect(hour.unmeasured).toEqual([{ from: NOW - LAST_HOUR_MS, to: NOW }]);
    expect(hour.waitedMs).toBe(0);
  });

  test("the count axis stands on the tallest bar", () => {
    const hour = lastHour({ history: steadyHour({ working: 4, idle: 3 }) });

    expect(hour.axis).toEqual(countAxis(7));
    expect(hour.axis.ceiling).toBeGreaterThanOrEqual(7);
  });
});

describe("waits", () => {
  /** An answered wait from 14:10 to 14:15, then a wait from 14:25 that is still on. */
  const twoWaits = () =>
    history(
      at(13, 0),
      polls(at(13, 0), at(14, 9, 58), { working: 1, idle: 0 }),
      polls(at(14, 10), at(14, 14, 58), { needsYou: 1, idle: 0 }),
      polls(at(14, 15), at(14, 24, 58), { working: 1, idle: 0 }),
      polls(at(14, 25), NOW, { needsYou: 1, idle: 0 }),
    );

  test("a wait still open is open from when its source says it began, and an earlier one is answered", () => {
    const hour = lastHour({ history: twoWaits(), sessions: [waiting(1, at(14, 25))] });

    expect(bucketAt(hour.buckets, at(14, 10)).means).toMatchObject({ open: 0, answered: 1 });
    expect(bucketAt(hour.buckets, at(14, 25)).means).toMatchObject({ open: 1, answered: 0 });
    expect(hour.openMs).toBe(NOW - at(14, 25));
  });

  test("without a reported start, a wait still open is open from the event that began it", () => {
    const hour = lastHour({
      history: twoWaits(),
      sessions: [waiting(1, null)],
      // The older event began the answered wait; the newest one the open wait.
      events: [waitBegan(1, at(14, 10)), waitBegan(1, at(14, 25))],
    });

    expect(bucketAt(hour.buckets, at(14, 10)).means).toMatchObject({ open: 0, answered: 1 });
    expect(bucketAt(hour.buckets, at(14, 25)).means).toMatchObject({ open: 1, answered: 0 });
  });

  test("a wait still open whose start nothing gives is open as far back as anything goes", () => {
    const hour = lastHour({ history: twoWaits(), sessions: [waiting(1, null)] });

    // Nothing says when it began, so nothing says the earlier wait was answered.
    expect(bucketAt(hour.buckets, at(14, 10)).means).toMatchObject({ open: 1, answered: 0 });
    expect(bucketAt(hour.buckets, at(14, 25)).means).toMatchObject({ open: 1, answered: 0 });
  });

  test("a wait is answered when no session is waiting now, and another session's event does not open it", () => {
    const hour = lastHour({
      history: twoWaits(),
      sessions: [makeSession({ id: id(1), status: "working" })],
      events: [waitBegan(2, at(14, 25))],
    });

    expect(bucketAt(hour.buckets, at(14, 25)).means).toMatchObject({ open: 0, answered: 1 });
    expect(hour.openMs).toBe(0);
  });

  test("no more of the count is open than the waits still open that had begun by then", () => {
    // Two waited from 14:20, but only one of the waits open now had begun.
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 19, 58), { working: 2, idle: 0 }),
        polls(at(14, 20), at(14, 27, 58), { needsYou: 2, idle: 0 }),
        polls(at(14, 28), NOW, { needsYou: 2, idle: 0 }),
      ),
      sessions: [waiting(1, at(14, 20)), waiting(2, at(14, 28))],
    });

    expect(bucketAt(hour.buckets, at(14, 20)).means).toMatchObject({ open: 1, answered: 1 });
    // The second began at 14:28, three of the five minutes into its bucket.
    const latest = bucketAt(hour.buckets, at(14, 25)).means;
    expect(latest?.open).toBeCloseTo((1 * 3 + 2 * 2) / 5, 10);
    expect(latest?.answered).toBeCloseTo((1 * 3 + 0 * 2) / 5, 10);
    expect(bucketAt(hour.buckets, at(14, 30)).means).toMatchObject({ open: 2, answered: 0 });
  });

  test("the time waited in all is the length of every wait in the hour, added up", () => {
    // One waited from 14:10 to 14:13, then two from 14:25 to now: 3 minutes, and
    // twice 7 minutes 30 seconds.
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 9, 58), { working: 1, idle: 0 }),
        polls(at(14, 10), at(14, 12, 58), { needsYou: 1, idle: 0 }),
        polls(at(14, 13), at(14, 24, 58), { working: 1, idle: 0 }),
        polls(at(14, 25), NOW, { needsYou: 2, idle: 0 }),
      ),
      sessions: [waiting(1, at(14, 25)), waiting(2, at(14, 25))],
    });

    expect(hour.waitedMs).toBe(3 * MINUTE + 2 * (7 * MINUTE + 30 * SECOND));
    expect(hour.openMs).toBe(2 * (7 * MINUTE + 30 * SECOND));
  });

  test("time not measured adds nothing to the time waited", () => {
    const hour = lastHour({
      history: history(
        at(13, 0),
        polls(at(13, 0), at(14, 10), { needsYou: 1, idle: 0 }),
        polls(at(14, 20), NOW, { needsYou: 1, idle: 0 }),
      ),
      sessions: [waiting(1, at(13, 0))],
    });

    expect(hour.waitedMs).toBe(LAST_HOUR_MS - 10 * MINUTE);
  });
});
