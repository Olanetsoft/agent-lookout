import {
  withoutWaitingText,
  type Session,
  type SessionsSnapshot,
  type SourceId,
} from "../sessions/session.ts";

/**
 * What is remembered from one snapshot to the next: for each source that has
 * answered, its sessions that needed the person at its last answer that could
 * be read, by id. Each is kept with the latest status time its wait has been
 * seen with, or null while its source has given none. A source that has never
 * answered so is absent, which is how its first answer is told from a later one.
 */
export type WaitMemory = ReadonlyMap<SourceId, ReadonlyMap<string, number | null>>;

/** The memory to start from, before any snapshot has been seen. */
export const EMPTY_WAIT_MEMORY: WaitMemory = new Map();

export interface WaitChanges {
  /** What to hand back with the next snapshot. */
  memory: WaitMemory;
  /** The sessions that began waiting for the person, in the snapshot's order. */
  started: Session[];
  /**
   * The ids of the sessions whose wait ended. A session that has begun another
   * wait since is in `started` as well: what was shown for the wait that ended
   * is taken down first, and the new wait is announced after it.
   */
  stopped: string[];
}

/** The later of two status times. Null is a time nobody gave, and is never the later. */
function laterOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return b > a ? b : a;
}

/**
 * Compares a snapshot with what was remembered from the one before, and says
 * which sessions began waiting for the person and which stopped. It decides
 * which change of status deserves a notification and which notification to
 * clear, and nothing about how either is done.
 *
 * A wait is one stretch of "needs-you" that began at one time: the status time
 * its source gives it.
 *
 * - Only a source that could be read in this snapshot is compared: one that is
 *   "ok", or "not-set-up", which was read and holds no sessions. One that is
 *   searching, unavailable, in error or not listed could not be read, so what
 *   is remembered of it is kept as it is and nothing is said about its
 *   sessions. A source that fails for one poll does not end every wait and
 *   start them all again.
 * - A source's first answer that could be read is a baseline. The sessions
 *   waiting in it were already waiting; they did not begin at this moment, so
 *   none has started. A source that was not set up at first has a baseline of
 *   no sessions, so a wait in a folder of status files made later has started.
 * - After that, a session that needs the person and is not remembered has
 *   started. A remembered one that is now in any other status, or gone from
 *   the list, has stopped.
 * - A remembered session that still needs the person, with a status time later
 *   than any its wait has been seen with, has stopped and started. Sources are
 *   read every couple of seconds. A session that is answered, works for a
 *   moment and asks again inside that time is never seen in another status,
 *   and its status time is all that tells the second wait from the first.
 * - Any other session that goes on waiting is neither, whatever happens to its
 *   reason, its detail or its name. A status time that is missing, the same or
 *   earlier is not a later one. A source that cannot say when a status began
 *   gives null, which says nothing about the wait, so the last time that was
 *   given is the one kept.
 *
 * The fourth rule takes a source at its word that `statusSince` moves only when
 * a status begins, which is what the session model asks of it. Claude Code's
 * registry has been seen to keep one status time for as long as a status
 * stands; the field notes are in the adapter's `registry.ts`. Whether it gives
 * a new time when only the reason for waiting changes is not known. If it does,
 * that is announced as a new wait, with the new reason. A source added later
 * must not give a waiting session a time that moves while the session goes on
 * waiting, or every move would be announced.
 *
 * Neither argument is changed. Called again with the memory it returned and
 * the same snapshot, it reports nothing.
 */
export function waitChanges(memory: WaitMemory, snapshot: SessionsSnapshot): WaitChanges {
  const waitingNow = new Map<SourceId, Map<string, number | null>>();
  for (const source of snapshot.sources) {
    if (source.state === "ok" || source.state === "not-set-up") {
      waitingNow.set(source.id, new Map());
    }
  }

  const started: Session[] = [];
  const stopped: string[] = [];
  for (const session of snapshot.sessions) {
    if (session.status !== "needs-you") continue;
    const waiting = waitingNow.get(session.source);
    // No map means the source did not answer. An id already in it was counted.
    if (!waiting || waiting.has(session.id)) continue;

    const remembered = memory.get(session.source);
    if (!remembered?.has(session.id)) {
      // Not remembered. In a source's first answer that is the baseline, and
      // after it the session has started.
      if (remembered) started.push(session);
      waiting.set(session.id, session.statusSince);
      continue;
    }

    const seen = remembered.get(session.id) ?? null;
    const since = session.statusSince;
    if (seen !== null && since !== null && since > seen) {
      // The wait that was remembered ended and this one began, unseen.
      stopped.push(session.id);
      started.push(session);
    }
    waiting.set(session.id, laterOf(seen, since));
  }

  const next = new Map(memory);
  for (const [source, waiting] of waitingNow) {
    for (const id of memory.get(source)?.keys() ?? []) {
      if (!waiting.has(id)) stopped.push(id);
    }
    next.set(source, waiting);
  }

  return { memory: next, started, stopped };
}

/**
 * What can send a notification or an email.
 *
 * - `needs-you`: a session starts waiting for the person, by `waitChanges`.
 * - `finished`: a session's status becomes finished.
 * - `failed`: a session's status becomes failed.
 * - `ended`: a session that had not finished or failed is gone from the list,
 *   as when its process ends.
 */
export type NoticeEvent = "needs-you" | "finished" | "failed" | "ended";

/** Every event, in the order they are listed and written. */
export const NOTICE_EVENTS: readonly NoticeEvent[] = ["needs-you", "finished", "failed", "ended"];

/** The events announced until the person chooses others: a wait, as before there was a choice. */
export const DEFAULT_NOTICE_EVENTS: readonly NoticeEvent[] = ["needs-you"];

export function isNoticeEvent(value: string): value is NoticeEvent {
  return (NOTICE_EVENTS as readonly string[]).includes(value);
}

/**
 * A list of events as it is written in a header, in storage and in the
 * environment: names separated by commas, such as `needs-you,finished`. Spaces
 * and case do not matter, nor does the order or a name given twice. Nothing at
 * all is the empty list. Null when any name is not one of the four.
 */
export function readNoticeEvents(text: string): NoticeEvent[] | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "") return [];
  const names = trimmed.split(",").map((name) => name.trim());
  if (!names.every(isNoticeEvent)) return null;
  return NOTICE_EVENTS.filter((event) => names.includes(event));
}

/** A list of events as `readNoticeEvents` reads one, in the order of `NOTICE_EVENTS`. */
export function writeNoticeEvents(events: readonly NoticeEvent[]): string {
  return NOTICE_EVENTS.filter((event) => events.includes(event)).join(",");
}

/** What a session that is over was said, or seen, to have done. */
type OverEvent = Exclude<NoticeEvent, "needs-you">;

/** What `sessionChanges` remembers from one snapshot to the next. */
export interface ChangeMemory {
  /** The waits, as `waitChanges` keeps them. */
  waits: WaitMemory;
  /**
   * For each source that has answered, and each way it has been read (its
   * `basis`), every session at the last answer read that way, by id. A source,
   * or a way of reading, that has never answered so is absent. Each is kept
   * without what it was asking, which belongs to its wait alone.
   */
  seen: ReadonlyMap<SourceId, ReadonlyMap<string, ReadonlyMap<string, Session>>>;
  /**
   * For each source, the sessions known to be over, and how: listed as
   * finished or failed, or said to have ended. One listed in any other status
   * since is not over, and one that none of the source's lists holds any more
   * is forgotten. Each way of reading is compared with its own last answer,
   * which can be older than another's, so this is what keeps one end from
   * being told twice.
   */
  over: ReadonlyMap<SourceId, ReadonlyMap<string, OverEvent>>;
}

/** The memory to start from, before any snapshot has been seen. */
export const EMPTY_CHANGE_MEMORY: ChangeMemory = {
  waits: EMPTY_WAIT_MEMORY,
  seen: new Map(),
  over: new Map(),
};

/** One thing that happened to one session. */
export interface SessionChange {
  event: NoticeEvent;
  /** The session as it is now, or, when it has ended, as it was last seen. */
  session: Session;
}

export interface SessionChanges {
  /** What to hand back with the next snapshot. */
  memory: ChangeMemory;
  /**
   * What happened, one for each change: first the sessions in the snapshot,
   * in its order, then those that ended.
   */
  changes: SessionChange[];
  /** The ids of the sessions whose wait ended, as `waitChanges` gives them. */
  stopped: string[];
}

/** The statuses a session is over in. */
function isOverStatus(status: Session["status"]): status is "finished" | "failed" {
  return status === "finished" || status === "failed";
}

/**
 * Whether a session already known to be over in one way has nothing new to
 * tell by this event: an end after any end, or a finish or failure after an
 * end or after the same again.
 */
function toldAlready(event: OverEvent, known: OverEvent | undefined): boolean {
  if (known === undefined) return false;
  return event === "ended" || known === "ended" || known === event;
}

/**
 * Compares a snapshot with what was remembered from the one before, and says
 * what happened to each session that deserves a notification: it started
 * waiting, finished, failed or ended. It decides nothing about who is told or
 * how.
 *
 * A wait is decided by `waitChanges`. The rest follow the same rules, with
 * one more, which the poller follows for the event log: a source read in more
 * than one way is compared only with its last answer read the same way.
 *
 * - Only a source that could be read in this snapshot is compared. What is
 *   remembered of any other is kept, and nothing is said about its sessions,
 *   so a source that stops answering ends nothing.
 * - A source's first answer read one way is a baseline for that way. Whatever
 *   is true in it was already true, so nothing in it has happened. Claude
 *   Code's adapter reads its registry alone while the claude command fails,
 *   and the background jobs only the command knows are missing from that
 *   answer without having ended. Its first answer read so is a baseline, and
 *   when the command answers again it is compared with its own last answer.
 * - After that, a session remembered in another status that is now finished
 *   has finished, and one that is now failed has failed. A session first seen
 *   already over says nothing: nobody saw it change, and a source that lists
 *   the jobs of the last day all at once, as Claude Code's command does when
 *   it starts answering late, would otherwise announce every one.
 * - A remembered session that is gone from the list has ended, unless it was
 *   finished or failed. A session that is over and later leaves the list has
 *   said what happened already.
 * - A session known to be over is not told of again: an end seen in one way
 *   of reading shows up again when the other is next compared with its own,
 *   older, answer.
 *
 * One change is one event. A session can wait and then finish between two
 * snapshots, and only the finish is seen.
 *
 * Neither argument is changed. Called again with the memory it returned and
 * the same snapshot, it reports nothing.
 */
export function sessionChanges(memory: ChangeMemory, snapshot: SessionsSnapshot): SessionChanges {
  const waits = waitChanges(memory.waits, snapshot);
  const startedWaiting = new Set(waits.started);

  /** Each source that could be read, with the way it was read and its sessions by id. */
  const answers = new Map<SourceId, { basis: string; sessions: Map<string, Session> }>();
  for (const source of snapshot.sources) {
    if (source.state === "ok" || source.state === "not-set-up") {
      answers.set(source.id, { basis: source.basis ?? "", sessions: new Map() });
    }
  }

  const found: SessionChange[] = [];
  for (const session of snapshot.sessions) {
    const answer = answers.get(session.source);
    // No answer means the source did not answer. An id already in it was counted.
    if (!answer || answer.sessions.has(session.id)) continue;
    // What a waiting session is asking belongs to its wait, and is not remembered.
    answer.sessions.set(session.id, withoutWaitingText(session));

    if (startedWaiting.has(session)) {
      found.push({ event: "needs-you", session });
      continue;
    }
    const before = memory.seen.get(session.source)?.get(answer.basis)?.get(session.id);
    if (before && before.status !== session.status && isOverStatus(session.status)) {
      found.push({ event: session.status, session });
    }
  }

  for (const [source, { basis, sessions }] of answers) {
    for (const [id, before] of memory.seen.get(source)?.get(basis) ?? []) {
      if (!sessions.has(id) && !isOverStatus(before.status)) {
        found.push({ event: "ended", session: before });
      }
    }
  }

  // What is known to be over, less the sessions listed running again.
  const overNow = new Map<SourceId, Map<string, OverEvent>>();
  for (const [source, { sessions }] of answers) {
    const over = new Map(memory.over.get(source));
    for (const [id, session] of sessions) {
      if (!isOverStatus(session.status)) over.delete(id);
    }
    overNow.set(source, over);
  }

  const changes = found.filter(({ event, session }) => {
    const over = overNow.get(session.source);
    if (event === "needs-you" || !over) return true;
    if (toldAlready(event, over.get(session.id))) return false;
    over.set(session.id, event);
    return true;
  });

  const seen = new Map(memory.seen);
  const over = new Map(memory.over);
  for (const [source, { basis, sessions }] of answers) {
    const ways = new Map(memory.seen.get(source));
    ways.set(basis, sessions);
    seen.set(source, ways);

    const known = overNow.get(source) as Map<string, OverEvent>;
    for (const [id, session] of sessions) {
      if (isOverStatus(session.status) && !known.has(id)) known.set(id, session.status);
    }
    // Only a session some way of reading still lists can be told of again.
    for (const id of known.keys()) {
      if (![...ways.values()].some((listed) => listed.has(id))) known.delete(id);
    }
    over.set(source, known);
  }

  return { memory: { waits: waits.memory, seen, over }, changes, stopped: waits.stopped };
}
