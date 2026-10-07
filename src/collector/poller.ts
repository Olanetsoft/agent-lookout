import { diffSessions, withoutRepeats, type ReportedStatuses } from "../core/sessions/diff.ts";
import { historyPointFor } from "../core/history.ts";
import {
  isStatusEvent,
  withoutWaitingText,
  type Session,
  type SessionEvent,
  type SessionsSnapshot,
  type SessionStatus,
  type SourceHealth,
  type SourceId,
  type SourceState,
} from "../core/sessions/session.ts";
import { sortSessions } from "../core/sessions/sorting.ts";
import { isStale } from "../core/sessions/staleness.ts";
import { isQuietAt } from "../core/time-rules/quietHours.ts";
import { staleAfterMs, type TimeRules } from "../core/time-rules/timeRules.ts";
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
  /**
   * Adds to each poll's sessions, from every source alike, what no source knows
   * itself: the collector gives each the git branch of its folder. It answers
   * quickly and never rejects. If it does anyway, the sessions go as they are.
   * Events are worked out from the sessions as their sources gave them.
   */
  annotate?: (sessions: readonly Session[]) => Promise<Session[]>;
  /**
   * The time rules in force, asked at each poll. The snapshot carries them,
   * and whether it was made in quiet hours, and its sessions are stale by the
   * idle rule's threshold while it is on. Left out, the snapshot carries
   * neither, and the built-in day stands.
   */
  timeRules?: () => TimeRules;
  /**
   * Of each poll's sessions, the ids of those still in a wait whose
   * permission request Agent Lookout answered, or that a permission rule is
   * answering, asked once as the poll's snapshot is made. The snapshot marks
   * them `answered`, and their wait is no news to the event log: see
   * `answeredWaits.ts` in the core. It answers at once and never throws. If
   * it does anyway, none is. Left out, none is.
   */
  answered?: (snapshot: Pick<SessionsSnapshot, "sources" | "sessions">) => ReadonlySet<string>;
}

/**
 * The sessions with `stale` worked out again, at the poll's moment, by the
 * threshold in force, whatever a source said: a session from another machine
 * comes with that machine's own answer. A session whose answer is the same is
 * the same object.
 */
function staleBy(sessions: readonly Session[], at: number, thresholdMs: number): Session[] {
  return sessions.map((session) => {
    const stale = isStale(session, at, thresholdMs);
    return stale === session.stale ? session : { ...session, stale };
  });
}

/**
 * A source's sessions as the event log compares them with the last poll read
 * the same way. One still in a wait Agent Lookout answered is taken as that
 * poll had it, so the log hears nothing new of it, or is left out when that
 * poll did not list it: a wait a rule answered before any poll saw it never
 * begins in the log, and so is never counted. Once its source says it has
 * moved on, it is taken as it is found.
 */
function forEvents(
  sessions: Session[],
  previous: readonly Session[],
  answered: ReadonlySet<string>,
): Session[] {
  if (answered.size === 0) return sessions;
  const before = new Map(previous.map((session) => [session.id, session]));
  const taken: Session[] = [];
  for (const session of sessions) {
    if (!answered.has(session.id)) {
      taken.push(session);
      continue;
    }
    const was = before.get(session.id);
    if (was) taken.push(was);
  }
  return taken;
}

/** The sessions with each still in a wait that was answered marked so. */
function markAnswered(sessions: Session[], answered: ReadonlySet<string>): Session[] {
  if (answered.size === 0) return sessions;
  return sessions.map((session) =>
    answered.has(session.id) ? { ...session, answered: true as const } : session,
  );
}

const NONE_ANSWERED: ReadonlySet<string> = new Set();

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
  /**
   * What each session was last seen doing before this run, from the history
   * kept on disk: its events, in any order. The first good poll of each
   * source is compared with what they say of that source's sessions, instead
   * of being taken as a baseline, so what changed while Agent Lookout was
   * stopped is an event of that poll, as what changed while the computer
   * slept is: a new status, a session that ended, or one back after it had
   * ended. A session they say nothing of is taken as it is found. Called
   * before `start`.
   */
  resume(events: readonly SessionEvent[]): void;
  /** When the collector began. History before this was not measured. */
  readonly startedAt: number;
}

/** What the adapter can report at all, to go with each health of its source. */
function declared(adapter: Adapter): Pick<SourceHealth, "capabilities"> {
  return adapter.capabilities === undefined ? {} : { capabilities: adapter.capabilities };
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

/** A session as the history kept from before this run last saw it. */
interface LastSeen {
  id: string;
  name: string;
  /** Null for one whose last event is that it ended. */
  status: SessionStatus | null;
}

/** What the poller remembers about one source between polls. */
interface SourceMemory {
  /**
   * The sessions each way of reading reported the last time it answered
   * properly, by `basis`. A poll is compared against the last poll read the
   * same way, not against the poll just before it. So a source that fails for
   * one poll does not "end" every session and bring them all back, and a
   * source that falls back to another way of reading for a while is, on its
   * return, compared with what it last saw itself. They are kept without what
   * a waiting session was asking.
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

  /**
   * The source a session's id names, of the ones polled: the longest id that,
   * with a colon after it, begins the session's. A machine's name holds no
   * colon, so `remote:dev:` never begins `remote:devbox:…`.
   */
  function sourceOf(sessionId: string): SourceId | null {
    let found: SourceId | null = null;
    for (const adapter of adapters) {
      if (!sessionId.startsWith(`${adapter.id}:`)) continue;
      if (found === null || adapter.id.length > found.length) found = adapter.id;
    }
    return found;
  }
  /**
   * What the history kept from before this run says of each source's
   * sessions, by the source a session's id begins with, until that source's
   * first good poll.
   */
  const resumed = new Map<string, LastSeen[]>();
  const overdue = new Map<Adapter, Overdue>();
  /**
   * Each source's last settled answer: "ok", or "unavailable" or "not-set-up"
   * when there is nothing to read. An error settles nothing, because it says
   * only that the sessions could not be read.
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
   * unavailable, or not set up, leaves a gap once, and after that is taken at
   * its word that it has no sessions. A source that has never answered holds
   * back no one.
   */
  function measuredEverySource(results: readonly AdapterResult[]): boolean {
    let anyOk = false;
    let missed = false;
    results.forEach((result, index) => {
      const id = (adapters[index] as Adapter).id;
      const { state } = result.health;
      if (state === "ok") anyOk = true;
      else if (settled.get(id) === "ok") missed = true;
      if (state === "ok" || state === "unavailable" || state === "not-set-up") {
        settled.set(id, state);
      }
    });
    return anyOk && !missed;
  }

  async function annotated(sessions: Session[]): Promise<Session[]> {
    if (!options.annotate) return sessions;
    try {
      return await options.annotate(sessions);
    } catch {
      return sessions;
    }
  }

  /** The sessions of this poll still in a wait that was answered. */
  function answeredIn(snapshot: Pick<SessionsSnapshot, "sources" | "sessions">) {
    if (!options.answered) return NONE_ANSWERED;
    try {
      return options.answered(snapshot);
    } catch {
      return NONE_ANSWERED;
    }
  }

  async function poll(): Promise<SessionsSnapshot> {
    const results = await Promise.all(adapters.map((adapter) => ask(adapter)));
    const found = await annotated(results.flatMap((result) => result.sessions));
    const at = now();
    // The way each was read goes with it, so what follows the snapshots
    // compares answers the way the event log does. So does what its agent
    // can report, whatever the answer was.
    const sources: SourceHealth[] = results.map((result, index) => ({
      ...result.health,
      ...(result.basis !== undefined && { basis: result.basis }),
      ...declared(adapters[index] as Adapter),
    }));
    // Asked now, after every source was read, so an answer given while this
    // poll read them counts for it.
    const answered = answeredIn({ sources, sessions: found });

    const changes: SessionEvent[] = [];
    results.forEach((result, index) => {
      // A source that is not set up was read as well, and holds no sessions. So
      // what it lists once it is set up has appeared, and is not a baseline.
      const { state } = result.health;
      if (state !== "ok" && state !== "not-set-up") return;
      const id = (adapters[index] as Adapter).id;
      let remembered = memory.get(id);
      let lastSeen: LastSeen[] | undefined;
      if (!remembered) {
        remembered = { baselines: new Map(), reported: new Map() };
        memory.set(id, remembered);
        lastSeen = resumed.get(id);
        resumed.delete(id);
      }
      const { baselines, reported } = remembered;
      const basis = result.basis ?? "";
      const previous = baselines.get(basis);
      // A baseline takes every session as it is found, as it always has.
      const sessions = previous ? forEvents(result.sessions, previous, answered) : result.sessions;

      if (previous) {
        // A change seen while another way of reading was in use shows up again
        // here, against this way's older poll. It is reported only once.
        changes.push(...withoutRepeats(diffSessions(previous, sessions, at), reported));
      } else {
        // The first good poll read this way is a baseline. The sessions in it
        // were already running; they did not appear at this moment, so it
        // produces no events. It is not compared with a poll read another way
        // either: an adapter's fallback does not see exactly what its main feed
        // sees, and the difference between the two views is not news.
        if (lastSeen) {
          // But the first of all this run is compared with what the history
          // kept from before it says, for the sessions it says anything of.
          const known = new Set(lastSeen.map((session) => session.id));
          const before = lastSeen.filter(
            (session): session is LastSeen & { status: SessionStatus } => session.status !== null,
          );
          const after = sessions.filter((session) => known.has(session.id));
          changes.push(...diffSessions(before, after, at));
        }
        for (const session of sessions) {
          if (!reported.has(session.id)) reported.set(session.id, session.status);
        }
      }
      // What a waiting session is asking belongs to its wait. A baseline can
      // outlive the wait, while the source is read another way, so it is kept
      // without it.
      baselines.set(basis, sessions.map(withoutWaitingText));
    });

    const rules = options.timeRules?.();
    const snapshot: SessionsSnapshot = {
      generatedAt: at,
      sources,
      sessions: sortSessions(staleBy(markAnswered(found, answered), at, staleAfterMs(rules))),
      ...(rules && { timeRules: rules, quiet: isQuietAt(rules.quietHours, at) }),
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
    resume(kept) {
      const newest = new Map<string, SessionEvent>();
      for (const event of kept) {
        // An event of what was done to a session, such as being stopped, says
        // nothing of its status. Its leaving the list is an event of its own.
        if (!isStatusEvent(event)) continue;
        const held = newest.get(event.sessionId);
        if (!held || event.at >= held.at) newest.set(event.sessionId, event);
      }
      resumed.clear();
      for (const event of newest.values()) {
        const status = event.kind === "ended" ? null : (event.to ?? null);
        if (event.kind !== "ended" && status === null) continue;
        // A session's id begins with its source's: `claude-code:…`, or
        // `remote:devbox:…` for one on another machine.
        const source = sourceOf(event.sessionId);
        if (source === null) continue;
        const list = resumed.get(source) ?? [];
        list.push({ id: event.sessionId, name: event.sessionName, status });
        resumed.set(source, list);
      }
    },
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
          ...declared(adapter),
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
