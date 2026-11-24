import type { HistoryKept, HistorySince, WaitsResponse } from "../../core/api.ts";
import type { HistoryPoint, SessionEvent, SessionsSnapshot } from "../../core/sessions/session.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";
import { addPoll, type Span } from "../../core/waits/measured.ts";
import type { WaitSighting } from "../../core/waits/waitSightings.ts";
import { isWaitEvent, waitTotals, type WaitMark } from "../../core/waits/waitTotals.ts";
import type { EventStore } from "../eventStore.ts";
import type { HistoryStore } from "../historyStore.ts";

/**
 * How far back the ledger holds: the seven days it answers for, and two more,
 * so a wait that began before them is still held from its start.
 */
export const LEDGER_KEPT_MS = 9 * 24 * 60 * 60 * 1000;

/** The most marks held: far more than nine days bring of moves into and out of needs-you, sightings and starts. */
const MAX_MARKS = 100_000;

/** The most stretches held: a stretch ends only at a restart, a sleep or a source that stopped answering. */
const MAX_SPANS = 50_000;

/** What the history kept on disk held, all of it, for the ledger: see `RestoredHistory` in `history/historyKeeper.ts`. */
export interface LedgerSeed {
  /** Every start, every event into or out of needs-you and how the sessions in a wait were seen, as they were added. */
  marks: readonly WaitMark[];
  /** The stretches its points cover, oldest first. */
  measured: readonly Span[];
}

/** What the answer is worked out from, besides what the ledger holds. */
export interface WaitsContext {
  now: number;
  /** The latest poll: which sessions need the person now. */
  snapshot: Pick<SessionsSnapshot, "sessions">;
  /** Where the history held begins. */
  since: HistorySince;
  where: HistoryKept["where"];
}

/**
 * Holds, compactly, what `GET /api/waits` is worked out from, further back than
 * the stores in memory hold: every event into or out of needs-you, the
 * stretches Agent Lookout measured and how the sessions in a wait were seen,
 * for nine days. The stores hold a thousand
 * events and six hours of points, which the charts need; a week of waits needs
 * a few thousand events and a few hundred stretches.
 *
 * It starts from what the history kept on disk held, all of it, and takes
 * every event and point the poller hands the stores from then on. With
 * `AGENT_LOOKOUT_HISTORY=off` it starts empty, so it covers only the time since
 * Agent Lookout started. It holds nothing a session is asking, and writes
 * nothing anywhere.
 */
export interface WaitLedger {
  /** Takes what the history kept held, before the first poll. */
  restore(seed: LedgerSeed): void;
  /** Says that Agent Lookout started watching, at `at`: the next point begins a stretch of its own. */
  beginRun(at: number): void;
  addEvents(events: readonly SessionEvent[]): void;
  addPoint(point: HistoryPoint): void;
  addSightings(sightings: readonly WaitSighting[]): void;
  /** Lets everything go, as clearing the history does. */
  clear(): void;
  /** The answer of `GET /api/waits`. */
  answer(context: WaitsContext): WaitsResponse;
}

export function createWaitLedger(): WaitLedger {
  // In the order they were added.
  let marks: WaitMark[] = [];
  let spans: Span[] = [];
  let fresh = true;

  function prune(at: number): void {
    const cutoff = at - LEDGER_KEPT_MS;
    let firstMark = 0;
    while (firstMark < marks.length && (marks[firstMark] as WaitMark).at < cutoff) firstMark += 1;
    firstMark = Math.max(firstMark, marks.length - MAX_MARKS);
    if (firstMark > 0) marks = marks.slice(firstMark);
    let firstSpan = 0;
    while (firstSpan < spans.length && (spans[firstSpan] as Span).to < cutoff) firstSpan += 1;
    firstSpan = Math.max(firstSpan, spans.length - MAX_SPANS);
    if (firstSpan > 0) spans = spans.slice(firstSpan);
  }

  return {
    restore(seed) {
      marks = [...seed.marks, ...marks];
      spans = seed.measured.map((span) => ({ ...span })).concat(spans);
    },
    beginRun(at) {
      fresh = true;
      marks.push({ kind: "start", at });
    },
    addEvents(added) {
      for (const event of added) if (isWaitEvent(event)) marks.push(event);
    },
    addPoint(point) {
      addPoll(spans, point.at, fresh);
      fresh = false;
      prune(point.at);
    },
    addSightings(added) {
      marks.push(...added);
    },
    clear() {
      marks = [];
      spans = [];
      fresh = true;
    },
    answer({ now, snapshot, since, where }) {
      const totals = waitTotals({
        marks,
        measured: spans,
        // Not a session in a wait Agent Lookout answered, whatever its source still says.
        waitingNow: snapshot.sessions
          .filter(needsYou)
          .map((session) => ({ id: session.id, name: session.name })),
        names: new Map(snapshot.sessions.map((session) => [session.id, session.name])),
        since: since.at,
        now,
      });
      return { at: now, ...totals, since, where };
    },
  };
}

/** The event store, with every event added to it also handed to the ledger. What is read is the store's own. */
export function ledgerEventStore(store: EventStore, ledger: WaitLedger): EventStore {
  return {
    add(added) {
      store.add(added);
      ledger.addEvents(added);
    },
    list: (options) => store.list(options),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}

/** The history store, with every point added to it also handed to the ledger. */
export function ledgerHistoryStore(store: HistoryStore, ledger: WaitLedger): HistoryStore {
  return {
    add(point) {
      store.add(point);
      ledger.addPoint(point);
    },
    list: (windowMs, at) => store.list(windowMs, at),
    clear: () => store.clear(),
    get size() {
      return store.size;
    },
  };
}
