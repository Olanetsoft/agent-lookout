import {
  diffSessions,
  waitMoves,
  withoutRepeats,
  type ReportedStatuses,
} from "../core/sessions/diff.ts";
import { historyPointFor } from "../core/history.ts";
import {
  isStatusEvent,
  readWays,
  withoutWaitingText,
  type ReadWays,
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
import { sightingsBySession, type WaitSighting } from "../core/waits/waitSightings.ts";
import type { Adapter, AdapterResult } from "./adapters/adapter.ts";
import type { EventStore } from "./eventStore.ts";
import type { HistoryStore } from "./historyStore.ts";
import { LEDGER_KEPT_MS } from "./waits/waitLedger.ts";

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
  /**
   * Hears each change in how a session in a wait is seen. The collector keeps
   * these with the history, for the waits. None of it goes to the event log.
   */
  onSightings?: (sightings: readonly WaitSighting[]) => void;
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

/**
 * The sessions answered here, with every session on another machine that its
 * own Agent Lookout marked answered. Only the other machine knows of an answer
 * given there, so its mark is the one word on it.
 */
function withAnsweredThere(answered: ReadonlySet<string>, sessions: readonly Session[]) {
  const there = sessions.filter(
    (session) => session.machine !== undefined && session.answered === true,
  );
  if (there.length === 0) return answered;
  return new Set([...answered, ...there.map((session) => session.id)]);
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
  /**
   * What each session was last seen doing before this run, from the history
   * kept on disk: its events, in any order. The first good poll of each
   * source is compared with what they say of that source's sessions, instead
   * of being taken as a baseline, so what changed while Agent Lookout was
   * stopped is an event of that poll, as what changed while the computer
   * slept is: a new status, a session that ended, or one back after it had
   * ended. A session they say nothing of is taken as it is found. Called
   * before `start`.
   *
   * `sightings` say how the sessions in a wait were last seen, in any order.
   * A session whose wait the history leaves open, that the first good poll
   * leaves out, is not taken to have ended unless the way that last listed it
   * is the way that poll was read. Nor is a session of a part that poll could
   * not look at (`notLookedAt`), which that part's first read takes as it is
   * found.
   */
  resume(events: readonly SessionEvent[], sightings?: readonly WaitSighting[]): void;
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
  /** For one in a wait: how it was last seen, when the history says. */
  sighting?: WaitSighting;
}

/** A session in a wait, as the poller follows it from one poll to the next. */
interface FollowedWait {
  name: string;
  /** The way of reading that last listed it, as `readWays` keys it. */
  way: string;
  /** The last poll that listed it, or for one the last run still listed, when this run began. */
  lastListed: number;
  /** Whether a poll has left it out since. */
  unseen: boolean;
}

/** What the poller remembers about one source between polls. */
interface SourceMemory {
  /**
   * The sessions each way of reading reported the last time it answered
   * properly, by `basis`, and for another machine's source by the way that
   * machine read each of its own (`readWays`). A poll is compared against the
   * last poll read the same way, not against the poll just before it. So a
   * source that fails for one poll does not "end" every session and bring
   * them all back, and a source that falls back to another way of reading for
   * a while is, on its return, compared with what it last saw itself. They
   * are kept without what a waiting session was asking.
   */
  baselines: Map<string, Session[]>;
  /** What the event log has said about this source's sessions so far. */
  reported: ReportedStatuses;
  /** Each session the log has in a wait. */
  waits: Map<string, FollowedWait>;
}

/**
 * Follows the sessions the log has in a wait through one poll, and says what
 * changed in how they are seen.
 *
 * Absence is no proof that a wait ended. A fallback can leave out a session
 * that still waits: Claude Code's registry alone has no background jobs, and
 * the Antigravity CLI without `ps` lists only what was written lately. So only
 * the way that last listed a session can end its wait by leaving it out
 * (`endsWaitUnseen`). Until a way does, or shows it moved on, the wait stays
 * open in the log, which says nothing of it. Told as ended, a wait that goes on
 * would be a false line in the log, and `sessionChanges` holds its message back
 * by the same rule. So a session left out only stops the count, at the last
 * poll that listed it (`waitsOf`), and if it is seen waiting again it carries
 * on as one wait, unless a status time later than that poll shows a new wait
 * began unseen. A session listed in any status is followed as seen.
 *
 * What is held is a subset of `reported`, and a wait out of sight is let go
 * once the ledger would have dropped it.
 */
function followWaits(
  memory: SourceMemory,
  sessions: readonly Session[],
  ways: ReadWays,
  at: number,
): WaitSighting[] {
  const { reported, waits } = memory;
  const sightings: WaitSighting[] = [];
  const listed = new Set<string>();
  for (const session of sessions) {
    listed.add(session.id);
    if (reported.get(session.id) !== "needs-you") continue;
    const way = ways.keyOf(session.id);
    const wait = waits.get(session.id);
    if (!wait || wait.unseen || wait.way !== way) {
      const began = wait?.unseen ? beganOutOfSight(session, wait.lastListed) : null;
      sightings.push({
        sessionId: session.id,
        sessionName: session.name,
        at,
        way,
        ...(began !== null && { began }),
      });
    }
    waits.set(session.id, { name: session.name, way, lastListed: at, unseen: false });
  }
  for (const [id, wait] of waits) {
    if (reported.get(id) !== "needs-you" || at - wait.lastListed > LEDGER_KEPT_MS) {
      waits.delete(id);
    } else if (!listed.has(id) && !wait.unseen) {
      wait.unseen = true;
      const { name: sessionName, way, lastListed: lastSeen } = wait;
      sightings.push({ sessionId: id, sessionName, at, way, lastSeen });
    }
  }
  return sightings;
}

/**
 * The status time of a session listed waiting again, when it is later than the
 * last poll that listed it, or null. That time shows the wait it was lost in
 * ended unseen and this one began then. It takes a source at its word that a
 * status time moves only when a status begins, as `waitChanges` does. A source
 * that gives none leaves it one wait.
 */
function beganOutOfSight(session: Session, lastListed: number): number | null {
  const since = session.statusSince;
  return session.status === "needs-you" && since !== null && since > lastListed ? since : null;
}

/**
 * Whether an `ended` this way of reading shows is of a session in a wait that
 * another way last listed (`followWaits`). Its leaving the session out proves
 * nothing, whatever its older poll held: that poll can be hours old, or from an
 * earlier wait.
 */
function endsWaitUnseen(
  event: SessionEvent,
  way: string,
  waits: ReadonlyMap<string, FollowedWait>,
): boolean {
  const wait = waits.get(event.sessionId);
  return event.kind === "ended" && wait !== undefined && wait.way !== way;
}

/** A move out of a wait, marked with where sight of its session was lost, when it was. */
function withLastSeen(event: SessionEvent, lastSeen: number | undefined): SessionEvent {
  if (lastSeen === undefined || event.from !== "needs-you" || event.to === "needs-you") {
    return event;
  }
  return { ...event, lastSeen };
}

/**
 * Takes up a wait the history leaves open, of a session whose first good poll
 * of this run says nothing of it. Left out by a way other than the one that
 * last listed it, it goes on unseen until that way is read. One listed as the
 * last run stopped has not been seen by this run, so its count stops where this
 * run began. A session this poll lists is seen again, as `followWaits` says.
 */
function takeUpWait(
  memory: SourceMemory,
  session: Pick<LastSeen, "id" | "name">,
  sighting: WaitSighting,
  runStart: number,
  at: number,
  listed: boolean,
): WaitSighting[] {
  const lastListed = sighting.lastSeen ?? runStart;
  memory.reported.set(session.id, "needs-you");
  memory.waits.set(session.id, {
    name: session.name,
    way: sighting.way,
    lastListed,
    unseen: true,
  });
  return listed || sighting.lastSeen !== undefined
    ? []
    : [{ ...sighting, at, lastSeen: lastListed }];
}

/** The sessions in a wait a way last listed, as a poll read that way would hold them. */
function waitsLastListedBy(way: string, waits: ReadonlyMap<string, FollowedWait>) {
  return [...waits]
    .filter(([, wait]) => wait.way === way)
    .map(([id, wait]) => ({ id, name: wait.name, status: "needs-you" as const }));
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
    // poll read them counts for it. A session on another machine comes marked
    // when Agent Lookout there answered its wait, and is taken the same way.
    const answered = withAnsweredThere(answeredIn({ sources, sessions: found }), found);

    const changes: SessionEvent[] = [];
    const sightings: WaitSighting[] = [];
    results.forEach((result, index) => {
      // Each way this poll was read, with its sessions: one, or for another
      // machine one for each of its sources that says how it was read.
      const ways = readWays({ basis: result.basis, parts: result.health.parts });
      const { state } = result.health;
      const id = (adapters[index] as Adapter).id;
      // A source that is gone says nothing of its sessions, and is measured
      // without them, so a wait there is out of sight as any other is.
      if (state === "unavailable") {
        const known = memory.get(id);
        if (known) sightings.push(...followWaits(known, result.sessions, ways, at));
        return;
      }
      // A source that is not set up was read as well, and holds no sessions. So
      // what it lists once it is set up has appeared, and is not a baseline.
      if (state !== "ok" && state !== "not-set-up") return;
      let remembered = memory.get(id);
      let lastSeen: LastSeen[] | undefined;
      if (!remembered) {
        remembered = { baselines: new Map(), reported: new Map(), waits: new Map() };
        memory.set(id, remembered);
        lastSeen = resumed.get(id);
        resumed.delete(id);
      }
      const { baselines, reported, waits } = remembered;
      if (lastSeen) {
        // The first good poll of all this run is compared with what the history
        // kept from before it says, for the sessions it says anything of.
        const known = new Set(lastSeen.map((session) => session.id));
        const listed = new Map(result.sessions.map((session) => [session.id, session.status]));
        const before = lastSeen.filter(
          (session): session is LastSeen & { status: SessionStatus } => session.status !== null,
        );
        for (const session of before) {
          const { sighting } = session;
          if (!sighting) continue;
          const status = listed.get(session.id);
          // Still waiting, or left out by a way that has no say in its wait.
          const goesOn = status === undefined && !ways.keys.includes(sighting.way);
          if (status === "needs-you" || goesOn) {
            const seen = status !== undefined;
            sightings.push(...takeUpWait(remembered, session, sighting, startedAt, at, seen));
          }
        }
        const after = result.sessions.filter(
          (session) => known.has(session.id) && !waits.has(session.id),
        );
        // A part this poll could not look at says nothing of its sessions.
        const notLookedAt = result.notLookedAt ?? [];
        const compared = before.filter(
          (session) =>
            !waits.has(session.id) && !notLookedAt.some((start) => session.id.startsWith(start)),
        );
        const sighted = new Map(before.map((session) => [session.id, session.sighting]));
        changes.push(
          ...diffSessions(compared, after, at).map((event) =>
            withLastSeen(event, sighted.get(event.sessionId)?.lastSeen),
          ),
        );
      }
      const moves: SessionEvent[] = [];
      const read = new Map<string, Session[]>(ways.keys.map((key) => [key, []]));
      for (const session of result.sessions) read.get(ways.keyOf(session.id))?.push(session);
      for (const [way, found] of read) {
        const previous = baselines.get(way);
        // A baseline takes every session as it is found, as it always has.
        const sessions = previous ? forEvents(found, previous, answered) : found;
        if (previous) {
          // A change seen while another way of reading was in use shows up again
          // here, against this way's older poll. It is reported only once.
          const diff = diffSessions(previous, sessions, at).filter(
            (event) => !endsWaitUnseen(event, way, waits),
          );
          moves.push(...withoutRepeats(diff, reported));
        } else {
          // The first good poll read this way is a baseline. The sessions in it
          // were already running; they did not appear at this moment, so it
          // produces no events. It is not compared with a poll read another way
          // either: an adapter's fallback does not see exactly what its main
          // feed sees, and the difference between the two views is not news.
          for (const session of sessions) {
            if (!reported.has(session.id)) reported.set(session.id, session.status);
          }
          // But a wait this way last listed, before this run, is its to end.
          const held = waitsLastListedBy(way, waits);
          const ids = new Set(held.map((session) => session.id));
          const listed = sessions.filter((session) => ids.has(session.id));
          moves.push(...withoutRepeats(diffSessions(held, listed, at), reported));
        }
        // Whichever branch that was, a wait begins and ends in the log. A way
        // that lists every session as finished, as when an agent is closed,
        // shows no change on its baseline or against its own older poll. A
        // wait that was answered is no news here either.
        moves.push(
          ...waitMoves(
            sessions.filter((session) => !answered.has(session.id)),
            reported,
            at,
          ),
        );
        // What a waiting session is asking belongs to its wait. A baseline can
        // outlive the wait, while the source is read another way, so it is kept
        // without it.
        baselines.set(way, sessions.map(withoutWaitingText));
      }
      for (const event of moves) {
        const wait = waits.get(event.sessionId);
        changes.push(withLastSeen(event, wait?.unseen ? wait.lastListed : undefined));
      }
      sightings.push(...followWaits(remembered, result.sessions, ways, at));
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
    if (sightings.length > 0) options.onSightings?.(sightings);
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
    resume(kept, sightings = []) {
      const sighted = sightingsBySession(sightings);
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
        const own = sighted.get(event.sessionId);
        const sighting = own?.[own.length - 1];
        // A sighting from before this wait's own event is of an earlier wait,
        // and says nothing of this one.
        const followed = status === "needs-you" && sighting && sighting.at >= event.at;
        const list = resumed.get(source) ?? [];
        list.push({
          id: event.sessionId,
          name: event.sessionName,
          status,
          ...(followed && { sighting }),
        });
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
