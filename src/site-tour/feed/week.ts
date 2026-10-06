import type { HistoryRestart } from "@core/api";
import { diffSessions } from "@core/sessions/diff";
import type { SessionEvent, SourceId } from "@core/sessions/session";
import type { Span } from "@core/waits/measured";
import { WATCHING_SINCE } from "@site-tour/feed/hour";

/**
 * The six days before the hour, as the history kept on disk holds them: when
 * Agent Lookout ran on each, and which sessions waited on you then, and for how
 * long. Each of those sessions ended while Agent Lookout was not running,
 * after the last run it waited in. The collector keeps what each session was
 * last doing, and the first poll of the next run finds it gone and writes
 * that it ended then: at the start of the next day's run, or of the hour's.
 *
 * The days are local days before the one the hour ends on, so the Waits card
 * draws them as days, wherever the visitor is. A day's run ends at least six
 * hours before the hour begins, so nothing of it is in the charts' six hours,
 * which hold the hour alone.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Nothing of a day's run comes this close to the hour, so the six-hour charts hold the hour alone. */
const CLEAR_OF_HOUR_MS = 6 * HOUR + 5 * MINUTE;

interface PastSession {
  id: string;
  name: string;
  source: SourceId;
}

const PAST: Record<string, PastSession> = {
  cart: {
    id: "claude-code:4d2e9b71-0c58-4a3f-8e16-b7a05c3d92e4",
    name: "cart-totals",
    source: "claude-code",
  },
  signing: {
    id: "claude-code:b18f6c03-7e24-4d95-a1c7-3f9e2d08b5a6",
    name: "webhook-signing",
    source: "claude-code",
  },
  reference: {
    id: "claude-code:e5a03d94-62bf-4c18-9d7e-0a4c81f6e27b",
    name: "api-reference",
    source: "claude-code",
  },
  push: {
    id: "claude-code:7c96a1e8-3d05-4b72-b4f9-58e2c07a3d16",
    name: "push-notifications",
    source: "claude-code",
  },
  changelog: {
    id: "status-files:changelog.json",
    name: "changelog",
    source: "status-files",
  },
};

/** One wait: who, from how long after the day's midnight, and for how long. */
type PastWait = readonly [session: keyof typeof PAST, from: number, lasted: number];

/** One day: how many days before the hour's, when Agent Lookout ran, from its midnight, and the waits. */
interface PastDay {
  daysBefore: number;
  run: { from: number; to: number } | null;
  waits: readonly PastWait[];
}

const at = (hours: number, minutes = 0) => hours * HOUR + minutes * MINUTE;
const lasting = (minutes: number, seconds = 0) => minutes * MINUTE + seconds * 1000;

/** Oldest first. The fourth day before, Agent Lookout did not run at all. */
export const PAST_DAYS: readonly PastDay[] = [
  {
    daysBefore: 6,
    run: { from: at(9, 12), to: at(17, 48) },
    waits: [
      ["cart", at(9, 41), lasting(2, 10)],
      ["cart", at(11, 5), lasting(6, 40)],
      ["reference", at(14, 22), lasting(1, 15)],
      ["cart", at(16, 3), lasting(3, 5)],
    ],
  },
  {
    daysBefore: 5,
    run: { from: at(8, 55), to: at(18, 20) },
    waits: [
      ["signing", at(9, 30), lasting(4, 30)],
      ["cart", at(10, 48), lasting(1, 50)],
      ["signing", at(13, 15), lasting(12, 5)],
      ["changelog", at(15, 2), lasting(0, 45)],
      ["signing", at(16, 40), lasting(2, 20)],
    ],
  },
  {
    daysBefore: 4,
    run: null,
    waits: [],
  },
  {
    daysBefore: 3,
    run: { from: at(9, 34), to: at(17, 15) },
    waits: [
      ["push", at(10, 2), lasting(3, 40)],
      ["signing", at(11, 27), lasting(1, 5)],
      ["push", at(14, 51), lasting(9, 30)],
    ],
  },
  {
    daysBefore: 2,
    run: { from: at(9, 3), to: at(18, 42) },
    waits: [
      ["push", at(9, 20), lasting(2, 15)],
      ["reference", at(10, 37), lasting(5, 10)],
      ["push", at(12, 9), lasting(1, 30)],
      ["changelog", at(14, 44), lasting(0, 55)],
      ["reference", at(16, 18), lasting(7, 25)],
      ["push", at(17, 56), lasting(2, 40)],
    ],
  },
  {
    daysBefore: 1,
    run: { from: at(9, 18), to: at(17, 57) },
    waits: [
      ["reference", at(9, 52), lasting(3, 20)],
      ["cart", at(11, 34), lasting(1, 45)],
      ["changelog", at(13, 6), lasting(1, 10)],
      ["cart", at(15, 29), lasting(4, 55)],
    ],
  },
];

/** The local midnight `days` days before the day of `moment`. */
function midnightBefore(moment: number, days: number): number {
  const date = new Date(moment);
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export interface Week {
  /** The runs of Agent Lookout before the hour, oldest first, in epoch milliseconds. */
  runs: Span[];
  /**
   * Each wait's two events, and each session's ending at the first poll after
   * it was last seen, newest first, as the collector's diff wrote them.
   */
  events: SessionEvent[];
  /** Each start after the first, with the newest moment held before it: the hour's own start among them. */
  restarts: HistoryRestart[];
  /** When Agent Lookout first started watching. */
  firstStart: number;
}

/** The days before the hour that ends at `t0`. */
export function weekBefore(t0: number): Week {
  const limit = t0 + WATCHING_SINCE - CLEAR_OF_HOUR_MS;
  const hourStart = t0 + WATCHING_SINCE;

  // Each day's run, and the waits that fall inside it, oldest first.
  const kept: { run: Span; waits: { who: keyof typeof PAST; begins: number; ends: number }[] }[] =
    [];
  for (const day of PAST_DAYS) {
    if (day.run === null) continue;
    const midnight = midnightBefore(t0, day.daysBefore);
    const run = { from: midnight + day.run.from, to: Math.min(midnight + day.run.to, limit) };
    if (run.to <= run.from) continue;
    const waits = day.waits
      .map(([who, from, lasted]) => ({
        who,
        begins: midnight + from,
        ends: midnight + from + lasted,
      }))
      .filter((wait) => wait.begins > run.from && wait.ends < run.to);
    kept.push({ run, waits });
  }
  const allWaits = kept.flatMap((day) => day.waits);

  const runs: Span[] = [];
  const events: SessionEvent[] = [];
  /** The sessions the log has seen, with when each was last seen, until each is found gone. */
  const lastSeen = new Map<keyof typeof PAST, number>();

  /**
   * The first poll of a run, at `at`, compared with what each session was last
   * seen doing: a session that waits in no run from here on is not found, and
   * has ended. One that waits again later was open all along.
   */
  function firstPoll(at: number): void {
    const gone = [...lastSeen]
      .filter(([who]) => !allWaits.some((wait) => wait.who === who && wait.begins > at))
      .sort((a, b) => a[1] - b[1]);
    for (const [who] of gone) {
      lastSeen.delete(who);
      const { id, name } = PAST[who];
      events.push(...diffSessions([{ id, name, status: "working" }], [], at));
    }
  }

  for (const { run, waits } of kept) {
    runs.push(run);
    firstPoll(run.from);
    for (const { who, begins, ends } of waits) {
      const { id, name } = PAST[who];
      events.push(
        ...diffSessions(
          [{ id, name, status: "working" }],
          [{ id, name, status: "needs-you" }],
          begins,
        ),
        ...diffSessions(
          [{ id, name, status: "needs-you" }],
          [{ id, name, status: "working" }],
          ends,
        ),
      );
      lastSeen.set(who, ends);
    }
  }
  // The hour's first poll finds none of those still open.
  firstPoll(hourStart);
  events.reverse();
  const restarts: HistoryRestart[] = runs.slice(1).map((run, index) => ({
    at: run.from,
    lastBefore: runs[index].to,
  }));
  const last = runs.at(-1);
  if (last) restarts.push({ at: hourStart, lastBefore: last.to });
  return { runs, events, restarts, firstStart: runs[0]?.from ?? hourStart };
}

/** Whether a session is one of the days before, which have all ended. */
export function isPastSession(sessionId: string): boolean {
  return Object.values(PAST).some((session) => session.id === sessionId);
}
