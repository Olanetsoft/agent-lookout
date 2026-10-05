import { diffSessions, withoutRepeats, type ReportedStatuses } from "../core/sessions/diff.ts";
import { historyPointFor } from "../core/history.ts";
import type {
  Session,
  SessionEvent,
  SessionsSnapshot,
  SourceId,
  SourceState,
} from "../core/sessions/session.ts";
import { sortSessions } from "../core/sessions/sorting.ts";
import type { Adapter, AdapterResult } from "./adapters/adapter.ts";
import type { EventStore } from "./eventStore.ts";
import type { HistoryStore } from "./historyStore.ts";

/** How often every source is asked for its sessions. */
export const POLL_INTERVAL_MS = 2_000;

/**
 * How long a source gets to answer one poll. An adapter bounds its own slow
 * steps, and its slowest honest answer takes well under this. Past it something
 * is stuck, such as a home directory on a network drive that has gone away.
 */
export const POLL_DEADLINE_MS = 15_000;

export interface PollerOptions {
  adapters: readonly Adapter[];
  events: EventStore;
  history: HistoryStore;
  intervalMs?: number;
  /** Defaults to `POLL_DEADLINE_MS`. */
  deadlineMs?: number;
  now?: () => number;
  /**
   * Hears each snapshot as soon as it is the latest. The collector's own
   * notifications listen here. Whatever it throws is dropped, so a listener
   * can never stop a poll.
   */
  onSnapshot?: (snapshot: SessionsSnapshot) => void;
}

export interface Poller {
  /** Polls now and then on every interval. Calling it twice changes nothing. */
  start(): void;
  /** Stops the interval. A poll already under way finishes on its own. */
  stop(): void;
  /**
   * Polls every source once. If a poll is already under way, this returns that
   * poll's result and does not start another.
   */
  pollOnce(): Promise<SessionsSnapshot>;
  /** The latest poll, or a "searching" snapshot before the first one has finished. */
  getSnapshot(): SessionsSnapshot;
  /** When the collector began. History before this was not measured. */
  readonly startedAt: number;
}

async function pollSafely(adapter: Adapter, now: () => number): Promise<AdapterResult> {
  try {
    return await adapter.poll();
  } catch {
    // An adapter promises not to throw. This holds the line if one does anyway.
    return {
      health: {
        id: adapter.id,
        label: adapter.label,
        state: "error",
        detail: `Something unexpected went wrong while reading ${adapter.label} sessions.`,
        checkedAt: now(),
      },
      sessions: [],
    };
  }
}

/** A poll of one source that ran past the deadline and has not been given up on. */
interface Overdue {
  /** When the adapter was asked. */
  since: number;
  /** The adapter's answer, once it finally arrives. */
  late?: AdapterResult;
}

/** What the poller remembers about one source between polls. */
interface SourceMemory {
  /**
   * The sessions each way of reading reported the last time it answered
   * properly, by `basis`. A poll is compared against the last poll read the
   * same way, not against the poll just before it. So a source that fails for
   * one poll does not "end" every session and bring them all back, and a
   * source that falls back to another way of reading for a while is, on its
   * return, compared with what it last saw itself.
   */
  baselines: Map<string, Session[]>;
  /** What the event log has said about this source's sessions so far. */
  reported: ReportedStatuses;
}

export function createPoller(options: PollerOptions): Poller {
  const { adapters, events, history } = options;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const deadlineMs = options.deadlineMs ?? POLL_DEADLINE_MS;
  const now = options.now ?? Date.now;

  let startedAt = now();
  let latest: SessionsSnapshot | null = null;
  let inFlight: Promise<SessionsSnapshot> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const memory = new Map<SourceId, SourceMemory>();
  const overdue = new Map<Adapter, Overdue>();
  /**
   * Each source's last settled answer: "ok", or "unavailable" when the tool is
   * not there. An error settles nothing, because it says only that the
   * sessions could not be read.
   */
  const settled = new Map<SourceId, SourceState>();

  function stillWaiting(adapter: Adapter, since: number): AdapterResult {
    const seconds = Math.max(1, Math.round((now() - since) / 1000));
    return {
      health: {
        id: adapter.id,
        label: adapter.label,
        state: "error",
        detail: `${adapter.label} has not answered for ${seconds} seconds. Agent Lookout is still waiting for it and will show its sessions when it answers.`,
        checkedAt: now(),
      },
      sessions: [],
    };
  }

  /**
   * Asks one adapter, and comes back by the deadline whatever the adapter does.
   *
   * An adapter that has not answered is never asked a second time while the
   * first question is open: a stuck read asked again every two seconds would
   * pile up without end. Until it answers the source is reported as an error,
   * so a stuck source can neither hold up the polls after it nor pass for a
   * healthy one. When the answer does arrive it is used by the next poll.
   */
  function ask(adapter: Adapter): Promise<AdapterResult> {
    const open = overdue.get(adapter);
    if (open) {
      if (open.late === undefined) return Promise.resolve(stillWaiting(adapter, open.since));
      overdue.delete(adapter);
      return Promise.resolve(open.late);
    }

    const since = now();
    return new Promise((resolve) => {
      let waiting = true;
      const record: Overdue = { since };
      const deadline = setTimeout(() => {
        waiting = false;
        overdue.set(adapter, record);
        resolve(stillWaiting(adapter, since));
      }, deadlineMs);
      // Like the interval, this alone should not keep a process alive.
      deadline.unref?.();

      void pollSafely(adapter, now).then((result) => {
        if (waiting) {
          clearTimeout(deadline);
          resolve(result);
        } else {
          record.late = result;
        }
      });
    });
  }

  /**
   * Whether this poll counted every session it could have counted, so its
   * history point is a true total.
   *
   * A poll in which no source answered measured nothing. Recording zeros for it
   * would draw a dip that never happened, so it leaves a gap. The same holds
   * for one source: a source that answered before and does not answer now has
   * sessions that went uncounted, so the point is left out, for as long as it
   * keeps failing, rather than drawn without them. A source that turns
   * unavailable leaves a gap once, and after that is taken at its word that it
   * has no sessions. A source that has never answered holds back no one.
   */
  function measuredEverySource(results: readonly AdapterResult[]): boolean {
    let anyOk = false;
    let missed = false;
    results.forEach((result, index) => {
      const id = (adapters[index] as Adapter).id;
      const { state } = result.health;
      if (state === "ok") anyOk = true;
      else if (settled.get(id) === "ok") missed = true;
      if (state === "ok" || state === "unavailable") settled.set(id, state);
    });
    return anyOk && !missed;
  }

  async function poll(): Promise<SessionsSnapshot> {
    const results = await Promise.all(adapters.map((adapter) => ask(adapter)));
    const at = now();

    const changes: SessionEvent[] = [];
    results.forEach((result, index) => {
      if (result.health.state !== "ok") return;
      const id = (adapters[index] as Adapter).id;
      let remembered = memory.get(id);
      if (!remembered) {
        remembered = { baselines: new Map(), reported: new Map() };
        memory.set(id, remembered);
      }
      const { baselines, reported } = remembered;
      const basis = result.basis ?? "";
      const previous = baselines.get(basis);

      if (previous) {
        // A change seen while another way of reading was in use shows up again
        // here, against this way's older poll. It is reported only once.
        changes.push(...withoutRepeats(diffSessions(previous, result.sessions, at), reported));
      } else {
        // The first good poll read this way is a baseline. The sessions in it
        // were already running; they did not appear at this moment, so it
        // produces no events. It is not compared with a poll read another way
        // either: an adapter's fallback does not see exactly what its main feed
        // sees, and the difference between the two views is not news.
        for (const session of result.sessions) {
          if (!reported.has(session.id)) reported.set(session.id, session.status);
        }
      }
      baselines.set(basis, result.sessions);
    });

    const snapshot: SessionsSnapshot = {
      generatedAt: at,
      sources: results.map((result) => result.health),
      sessions: sortSessions(results.flatMap((result) => result.sessions)),
    };

    latest = snapshot;
    events.add(changes);
    if (measuredEverySource(results)) history.add(historyPointFor(snapshot.sessions, at));
    try {
      options.onSnapshot?.(snapshot);
    } catch {
      // A listener's failure is its own. The poll is done and its answer stands.
    }
    return snapshot;
  }

  function pollOnce(): Promise<SessionsSnapshot> {
    if (inFlight) return inFlight;
    const current = poll().finally(() => {
      inFlight = null;
    });
    inFlight = current;
    return current;
  }

  return {
    start() {
      if (timer) return;
      startedAt = now();
      const tick = () => {
        // While a slow poll is under way this is a no-op, so polls never overlap.
        pollOnce().catch(() => {});
      };
      tick();
      timer = setInterval(tick, intervalMs);
      // The poller alone should not keep a process alive.
      timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    pollOnce,
    getSnapshot() {
      if (latest) return latest;
      const at = now();
      return {
        generatedAt: at,
        sources: adapters.map((adapter) => ({
          id: adapter.id,
          label: adapter.label,
          state: "searching" as const,
          detail: adapter.lookingIn,
          checkedAt: at,
        })),
        sessions: [],
      };
    },
    get startedAt() {
      return startedAt;
    },
  };
}
