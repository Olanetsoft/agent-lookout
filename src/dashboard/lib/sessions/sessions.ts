import type { Session, SessionStatus, SourceHealth } from "@core/sessions/session";
import { compareSessions } from "@core/sessions/sorting";
import { STATUS_LABEL } from "@dashboard/lib/sessions/status";

/** The sections of the sessions list, in the order they are shown. */
export type SessionGroupId = "needs-you" | "working" | "idle" | "ended" | "unknown";

export interface SessionGroup {
  id: SessionGroupId;
  label: string;
  sessions: Session[];
  /**
   * The number beside the label. It is every session in the group, except in the
   * idle group, where the stale ones are counted apart, as the counts row counts them.
   */
  count: number;
  /** How many of them are stale. The idle group's row says so beside its count. */
  stale: number;
}

/** Stale is an idle session left a day or more. Only an idle session can be stale. */
export function isStaleIdle(session: Pick<Session, "status" | "stale">): boolean {
  return session.stale && session.status === "idle";
}

/**
 * How a session's row reads, wherever one is drawn: in the list, on the board
 * and in the search. Its mark is its status, or stale. It is quiet, its name
 * at 500 in the secondary ink, when it is stale, has ended, or its process has
 * gone; and orphaned, with the "Process ended" badge, when its process has gone
 * while it still claims to run.
 */
export interface RowLook {
  mark: SessionStatus | "stale";
  /** "Stale", or the status in words. */
  word: string;
  ended: boolean;
  stale: boolean;
  quiet: boolean;
  orphaned: boolean;
}

export function rowLook(session: Pick<Session, "status" | "stale" | "alive">): RowLook {
  const ended = session.status === "finished" || session.status === "failed";
  const gone = session.alive === false;
  const stale = isStaleIdle(session);
  return {
    mark: stale ? "stale" : session.status,
    word: stale ? "Stale" : STATUS_LABEL[session.status],
    ended,
    stale,
    quiet: stale || ended || gone,
    // A session that finished or failed is expected to have no process.
    orphaned: gone && !ended,
  };
}

const GROUP_LABEL: Record<Exclude<SessionGroupId, "ended">, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  unknown: "Status unknown",
};

const GROUP_ORDER: readonly SessionGroupId[] = ["needs-you", "working", "idle", "ended", "unknown"];

/** The section a session is listed in, and the column of the board it is drawn in. */
export function groupOf(session: Pick<Session, "status">): SessionGroupId {
  switch (session.status) {
    case "needs-you":
      return "needs-you";
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "finished":
    case "failed":
      return "ended";
    default:
      return "unknown";
  }
}

/** The ended group is named for what is in it: "Finished", "Failed", or, holding both, "Finished or failed", as its column on the board is. */
function labelOf(id: SessionGroupId, members: readonly Session[]): string {
  if (id !== "ended") return GROUP_LABEL[id];
  const failed = members.some((session) => session.status === "failed");
  const finished = members.some((session) => session.status === "finished");
  if (failed && finished) return "Finished or failed";
  return failed ? "Failed" : "Finished";
}

/**
 * Order inside a section. The collector's own ordering does the work: the longest
 * wait first under "Needs you", the most recent change first everywhere else, so
 * stale sessions sink. The one addition is that a failure is listed before a
 * clean finish.
 */
function compareInGroup(a: Session, b: Session): number {
  const failedFirst = Number(b.status === "failed") - Number(a.status === "failed");
  return failedFirst || compareSessions(a, b);
}

/**
 * Sorts sessions into their sections. A section appears only when it has
 * sessions. That nothing is waiting is said once, by the hero, and not again by
 * an empty section anywhere else.
 */
export function groupSessions(sessions: readonly Session[]): SessionGroup[] {
  const buckets = new Map<SessionGroupId, Session[]>();
  for (const session of sessions) {
    const id = groupOf(session);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(session);
    else buckets.set(id, [session]);
  }

  const groups: SessionGroup[] = [];
  for (const id of GROUP_ORDER) {
    const members = buckets.get(id);
    if (!members) continue;
    const stale = members.filter(isStaleIdle).length;
    groups.push({
      id,
      label: labelOf(id, members),
      sessions: [...members].sort(compareInGroup),
      count: members.length - stale,
      stale,
    });
  }
  return groups;
}

/**
 * The groups of the Sessions table. The sessions that need the person are the
 * hero's, at the top of the Overview, so the table starts at Working.
 */
export function tableGroups(sessions: readonly Session[]): SessionGroup[] {
  return groupSessions(sessions).filter((group) => group.id !== "needs-you");
}

/**
 * The sessions that need the person now, longest wait first, as the hero lists
 * them. A wait whose start the source did not report comes after those whose
 * start it did, since how long it has lasted is not known.
 */
export function waitingSessions(sessions: readonly Session[]): Session[] {
  return groupSessions(sessions).find((group) => group.id === "needs-you")?.sessions ?? [];
}

/**
 * How many sessions need the person now, from the latest snapshot. It is the one
 * rule for the lamp's colour: the mark, the hero and the Needs you history are
 * lit while this is above zero, and hold no warm colour at zero. Before the first
 * answer there are no sessions, and it is zero.
 */
export function countNeedingYou(
  sessions: readonly Pick<Session, "status">[] | null | undefined,
): number {
  return sessions?.filter((session) => session.status === "needs-you").length ?? 0;
}

/** The session that has been in a status longest, and since when. */
export interface Longest {
  session: Session;
  since: number;
}

/**
 * The numbers behind the hero and its counts row. Every session is counted under
 * exactly one of needs you, working, idle, stale, finished, failed and unknown,
 * so the counts add up to the total.
 */
export interface SessionsSummary {
  total: number;
  needsYou: number;
  working: number;
  /** The idle sessions that are not stale. */
  idle: number;
  /** The idle sessions left a day or more. They are not counted as idle. */
  stale: number;
  /** Sessions that have not finished or failed. */
  open: number;
  finished: number;
  failed: number;
  /** The session that has needed the person longest, when its start is known. */
  longestWait: Longest | null;
  /** The session that has been working longest, when its start is known. */
  longestWorking: Longest | null;
  /** The session that has been idle longest, when its start is known. A stale one is not idle. */
  longestIdle: Longest | null;
}

/** Keeps whichever of the two has been in its status longer. A missing start is not a guess. */
function longer(current: Longest | null, session: Session): Longest | null {
  const since = session.statusSince;
  if (since === null) return current;
  return current === null || since < current.since ? { session, since } : current;
}

/** The numbers behind the hero and its counts. Everything here is counted, never estimated. */
export function summarizeSessions(sessions: readonly Session[]): SessionsSummary {
  const summary: SessionsSummary = {
    total: sessions.length,
    needsYou: 0,
    working: 0,
    idle: 0,
    stale: 0,
    open: 0,
    finished: 0,
    failed: 0,
    longestWait: null,
    longestWorking: null,
    longestIdle: null,
  };

  for (const session of sessions) {
    if (isStaleIdle(session)) {
      summary.stale += 1;
      continue;
    }

    switch (session.status) {
      case "needs-you":
        summary.needsYou += 1;
        summary.longestWait = longer(summary.longestWait, session);
        break;
      case "working":
        summary.working += 1;
        summary.longestWorking = longer(summary.longestWorking, session);
        break;
      case "idle":
        summary.idle += 1;
        summary.longestIdle = longer(summary.longestIdle, session);
        break;
      case "finished":
        summary.finished += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
    }
  }

  summary.open = summary.total - summary.finished - summary.failed;
  return summary;
}

/**
 * What the Overview can say about how many sessions there are.
 *
 *   summary    null before the first answer: nothing is claimed yet
 *   counted    whether the numbers are a count. A source has to have been read,
 *              or a session found, for a zero to be a real zero. When no
 *              source could be read, nothing was found, which is not the same
 *              as nothing running
 *   searching  a source is still being looked for, so a count is still to come
 */
export interface CountState {
  summary: SessionsSummary | null;
  counted: boolean;
  searching: boolean;
}

export function countState(
  sessions: readonly Session[] | null,
  sources: readonly Pick<SourceHealth, "state">[] = [],
): CountState {
  const summary = sessions ? summarizeSessions(sessions) : null;
  const counted =
    summary !== null && (summary.total > 0 || sources.some((source) => source.state === "ok"));
  return {
    summary,
    counted,
    searching: sources.some((source) => source.state === "searching"),
  };
}

/**
 * Which light holds the hero: the lamp while a session needs the person, the
 * rest light while none does, and neither while nothing has been counted, so no
 * light claims a zero that was never measured.
 */
export function heroLight(counts: CountState): "lamp" | "rest" | null {
  if (!counts.summary || !counts.counted) return null;
  return counts.summary.needsYou > 0 ? "lamp" : "rest";
}
