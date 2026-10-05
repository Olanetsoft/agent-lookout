import type { Session } from "@core/sessions/session";
import { groupSessions, type SessionGroupId } from "@dashboard/lib/sessions/sessions";

/** The board's columns, in the order they are shown. */
export type BoardColumnId = Exclude<SessionGroupId, "unknown">;

export interface BoardColumn {
  id: BoardColumnId;
  /** The column's name, which never changes with what is in it. */
  label: string;
  /** The one line an empty column says. */
  empty: string;
  /** Every session in the column, in the list's order. */
  sessions: Session[];
  /** The number beside the name. In Idle the stale sessions are counted apart. */
  count: number;
  /** How many of them are stale. Only Idle has any. */
  stale: number;
}

export interface Board {
  columns: BoardColumn[];
  /** The sessions whose status is not known. No column is theirs; the list shows them. */
  unknown: Session[];
}

const COLUMNS: readonly Omit<BoardColumn, "sessions" | "count" | "stale">[] = [
  { id: "needs-you", label: "Needs you", empty: "Nothing waiting" },
  { id: "working", label: "Working", empty: "Nothing working" },
  { id: "idle", label: "Idle", empty: "Nothing idle" },
  { id: "ended", label: "Finished or failed", empty: "Nothing finished or failed" },
];

/** How many cards a column shows. The rest are counted under it, and the list has them all. */
export const BOARD_COLUMN_CARDS = 5;

/**
 * The sessions as the board lays them out: a column for each status, always all
 * four, in the order Needs you, Working, Idle, Finished or failed. Each holds
 * its sessions in the order the list gives them, so Needs you has the longest
 * wait first, as the hero does, and every other column the most recent change
 * first. Stale sessions sit in Idle, as the list groups them, and are counted
 * apart, as the counts row counts them.
 *
 * A session whose status is not known has no column. It is returned on its own,
 * so the board can say it is there rather than drop it.
 */
export function boardOf(sessions: readonly Session[]): Board {
  const groups = groupSessions(sessions);
  const columns = COLUMNS.map((column) => {
    const group = groups.find((candidate) => candidate.id === column.id);
    return {
      ...column,
      sessions: group?.sessions ?? [],
      count: group?.count ?? 0,
      stale: group?.stale ?? 0,
    };
  });
  return {
    columns,
    unknown: groups.find((group) => group.id === "unknown")?.sessions ?? [],
  };
}
