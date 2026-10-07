import type { HistoryKept, HistorySince, WaitsResponse } from "../../core/api.ts";
import type { HistoryPoint, SessionEvent, SessionsSnapshot } from "../../core/sessions/session.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";
import { addPoll, type Span } from "../../core/waits/measured.ts";
import { isWaitEvent, waitTotals } from "../../core/waits/waitTotals.ts";
import type { EventStore } from "../eventStore.ts";
import type { HistoryStore } from "../historyStore.ts";

/**
 * How far back the ledger holds: the seven days it answers for, and two more,
 * so a wait that began before them is still held from its start.
 */
export const LEDGER_KEPT_MS = 9 * 24 * 60 * 60 * 1000;

/** The most events held: far more moves into and out of needs-you than nine days bring. */
const MAX_EVENTS = 100_000;

/** The most stretches held: a stretch ends only at a restart, a sleep or a source that stopped answering. */
const MAX_SPANS = 50_000;

/** What the history kept on disk held, all of it, for the ledger: see `RestoredHistory` in `history/historyKeeper.ts`. */
export interface LedgerSeed {
  /** Every event into or out of needs-you, oldest first. */
  waitEvents: readonly SessionEvent[];
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
  /** When each run of Agent Lookout began, this one among them, in any order. */
  runStarts: readonly number[];
  where: HistoryKept["where"];
}

/**
 * Holds, compactly, what `GET /api/waits` is worked out from, further back than
 * the stores in memory hold: every event into or out of needs-you and the
 * stretches Agent Lookout measured, for nine days. The stores hold a thousand
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
  /** Says that Agent Lookout started watching: the next point begins a stretch of its own. */
  beginRun(): void;
  addEvents(events: readonly SessionEvent[]): void;
  addPoint(point: HistoryPoint): void;
  /** Lets everything go, as clearing the history does. */
  clear(): void;
  /** The answer of `GET /api/waits`. */
  answer(context: WaitsContext): WaitsResponse;
}

export function createWaitLedger(): WaitLedger {
  let events: SessionEvent[] = [];
  let spans: Span[] = [];
  let fresh = true;

  function prune(at: number): void {
    const cutoff = at - LEDGER_KEPT_MS;
    let firstEvent = 0;
    while (firstEvent < events.length && (events[firstEvent] as SessionEvent).at < cutoff) {
      firstEvent += 1;
    }
    firstEvent = Math.max(firstEvent, events.length - MAX_EVENTS);
    if (firstEvent > 0) events = events.slice(firstEvent);
    let firstSpan = 0;
    while (firstSpan < spans.length && (spans[firstSpan] as Span).to < cutoff) firstSpan += 1;
    firstSpan = Math.max(firstSpan, spans.length - MAX_SPANS);
    if (firstSpan > 0) spans = spans.slice(firstSpan);
  }

  return {
    restore(seed) {
      events = seed.waitEvents.filter(isWaitEvent).concat(events);
      spans = seed.measured.map((span) => ({ ...span })).concat(spans);
    },
    beginRun() {
      fresh = true;
    },
    addEvents(added) {
      for (const event of added) if (isWaitEvent(event)) events.push(event);
    },
    addPoint(point) {
      addPoll(spans, point.at, fresh);
      fresh = false;
      prune(point.at);
    },
    clear() {
      events = [];
      spans = [];
      fresh = true;
    },
    answer({ now, snapshot, since, runStarts, where }) {
      const totals = waitTotals({
        events,
        measured: spans,
        runStarts,
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
