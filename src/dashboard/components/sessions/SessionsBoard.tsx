import { useId } from "react";

import type { Session } from "@core/sessions/session";
import { BoardCard } from "@dashboard/components/sessions/BoardCard";
import { BOARD_COLUMN_CARDS, boardOf, type BoardColumn } from "@dashboard/lib/sessions/board";

interface SessionsBoardProps {
  sessions: readonly Session[];
  now: number;
  /** The tool each session belongs to, when the card names it. */
  agentOf?: (session: Session) => string;
}

/**
 * A count beside the name of a column of the board, or of a group of the list,
 * in the muted ink, with figures that keep their width.
 */
export function Count({ children }: { children: number }) {
  return (
    <span data-part='count' className='font-medium text-ink-muted tabular-nums'>
      {children}
    </span>
  );
}

/**
 * One column: its name and count in words, as a group of the list is headed,
 * then its sessions as a list named by that head. An empty column says so in
 * one quiet line. The column keeps its name whatever is in it, so Idle holding
 * only stale sessions reads "Idle 0, Stale 1".
 *
 * It shows its first few sessions, which in every column but Needs you are the
 * most recent to change, and counts the rest under them. The list has them all.
 * A column that scrolled on its own would put a scroll inside the page's
 * scroll, and four scrollbars side by side, on a screen left open all day.
 */
function Column({
  column,
  now,
  agentOf,
}: {
  column: BoardColumn;
  now: number;
  agentOf?: (session: Session) => string;
}) {
  const headId = useId();
  const shown = column.sessions.slice(0, BOARD_COLUMN_CARDS);
  const more = column.sessions.length - shown.length;
  return (
    <div data-slot='board-column' data-column={column.id} className='flex min-w-0 flex-col'>
      <h3
        id={headId}
        className='flex h-group items-end gap-3.5 px-3.5 pb-2 text-caption font-semibold text-ink-secondary'
      >
        <span className='inline-flex items-baseline gap-1.5'>
          {column.label}
          <Count>{column.count}</Count>
        </span>
        {column.stale > 0 && (
          <span data-part='stale' className='inline-flex items-baseline gap-1.5'>
            Stale
            <Count>{column.stale}</Count>
          </span>
        )}
      </h3>
      {shown.length > 0 ? (
        <ul aria-labelledby={headId} className='flex flex-col gap-2'>
          {shown.map((session) => (
            <BoardCard key={session.id} session={session} now={now} agent={agentOf?.(session)} />
          ))}
        </ul>
      ) : (
        <p data-part='empty' className='px-3.5 py-2.5 text-caption text-ink-muted'>
          {column.empty}
        </p>
      )}
      {more > 0 && (
        <p data-part='more' className='px-3.5 pt-2.5 text-caption text-ink-muted'>
          and <span className='tabular-nums'>{more}</span> more in the list
        </p>
      )}
    </div>
  );
}

/**
 * The sessions as a board: a column for each status, Needs you, Working, Idle,
 * and Finished or failed, always all four and in that order, so how many are in
 * each state, and which are waiting, can be read at a glance. Stale sessions
 * sit in Idle with their own mark, as the list groups them, and are counted
 * apart. Needs you has the longest wait first, as the hero does; every other
 * column has the most recent change first, as the list does.
 *
 * Agent Lookout reports the state of each session and does not set it, so a
 * card moves to its new column on its own, on the first answer after its
 * status changed, and cannot be dragged. It moves without travelling: the list
 * has no motion for a row changing group either.
 *
 * Four columns stand side by side when the card has room for each to hold its
 * cards whole, two by two in a narrower card, and one under another on a
 * phone, each with its head. Nothing ever scrolls sideways.
 *
 * A session whose status is not known has no column. One line under the board
 * says how many there are, and the list shows them.
 */
export function SessionsBoard({ sessions, now, agentOf }: SessionsBoardProps) {
  const { columns, unknown } = boardOf(sessions);
  return (
    <div data-slot='session-board' className='@container px-2.5 pb-2.5'>
      <div className='grid grid-cols-1 gap-x-2.5 gap-y-2 @min-[26rem]:grid-cols-2 @min-[47rem]:grid-cols-4'>
        {columns.map((column) => (
          <Column key={column.id} column={column} now={now} agentOf={agentOf} />
        ))}
      </div>
      {unknown.length > 0 && (
        <p data-part='unknown' className='px-3.5 pt-3 pb-1 text-caption text-ink-muted'>
          {unknown.length === 1
            ? "The status of 1 session is not known. The list shows it."
            : `The status of ${unknown.length} sessions is not known. The list shows them.`}
        </p>
      )}
    </div>
  );
}
