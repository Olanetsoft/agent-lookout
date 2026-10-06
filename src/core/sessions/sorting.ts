import type { Session, SessionStatus } from "./session.ts";

/** The fields a session is ordered by. */
type Ordered = Pick<Session, "id" | "name" | "status" | "statusSince">;

/** The order statuses are listed in: the ones that need a person come first. */
export const STATUS_ORDER: readonly SessionStatus[] = [
  "needs-you",
  "working",
  "idle",
  "finished",
  "failed",
  "unknown",
];

const RANK = new Map<SessionStatus, number>(STATUS_ORDER.map((status, index) => [status, index]));

function rank(status: SessionStatus): number {
  return RANK.get(status) ?? STATUS_ORDER.length;
}

function compareText(a: string, b: string): number {
  // Code-unit order, so the result does not depend on the machine's locale.
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Orders two sessions for display.
 *
 * 1. By status, in `STATUS_ORDER`.
 * 2. Within "needs-you", the longest wait first. Within every other status, the
 *    most recent change first, so old idle sessions sink to the bottom.
 *    Sessions with no status time come after those that have one.
 * 3. By name, then by id, so the order never flickers between polls.
 */
export function compareSessions(a: Ordered, b: Ordered): number {
  const byStatus = rank(a.status) - rank(b.status);
  if (byStatus !== 0) return byStatus;

  if (a.statusSince !== b.statusSince) {
    if (a.statusSince === null) return 1;
    if (b.statusSince === null) return -1;
    const oldestFirst = a.statusSince - b.statusSince;
    return a.status === "needs-you" ? oldestFirst : -oldestFirst;
  }

  return compareText(a.name, b.name) || compareText(a.id, b.id);
}

/** Returns a sorted copy. The input is not changed. */
export function sortSessions<T extends Ordered>(sessions: readonly T[]): T[] {
  return [...sessions].sort(compareSessions);
}
