import type { ReactNode } from "react";

import type { Session } from "@core/sessions/session";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useJump } from "@dashboard/hooks/data/useJump";
import { formatShortDuration, formatSince, shortDurationInWords } from "@dashboard/lib/format";
import { isStaleIdle } from "@dashboard/lib/sessions/sessions";
import { STATUS_LABEL, SURFACE_LABEL } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";

interface SessionRowProps {
  session: Session;
  now: number;
  /** Whether the table has a Jump column. It is left out when no session can be jumped to. */
  jumpColumn: boolean;
  /**
   * A narrow window: the status and its time move under the name, in place of
   * their own column, so the name keeps its room.
   */
  narrow?: boolean;
  /**
   * The tool the session belongs to, in plain words, when the table has more
   * than one: "Claude Code", "Codex". It has a column of its own, and narrow it
   * leads the second line. Left out, the row does not name it.
   */
  agent?: string;
  /**
   * Whether the table has a Folder column. A card with too little room for
   * every column leaves it out after the App column, so the name keeps its room.
   */
  folderColumn?: boolean;
  /**
   * Whether the table has an App column. A card with too little room for every
   * column leaves it out first, so the name keeps its room.
   */
  appColumn?: boolean;
}

/** Every cell's padding. The first is 24px in from the card's edge, as the head is. */
const CELL = "px-3 first:pl-6 last:pr-4.5";

/**
 * One session, as a row of the Sessions table: mark and name, the tool when
 * more than one is found, the folder, the app, the status and how long it has
 * lasted read as one phrase, and Jump.
 *
 * Rows have no rules. Under the pointer the row lights as one rounded shape
 * 10px inside the card, drawn from its first cell and placed against the row,
 * so it never seams between cells; its Jump comes up with it.
 *
 * How long is said in the table's short form, "Working 34m": seconds only in
 * the first minute, and days alone. The exact start is in the tooltip. The
 * hero's timers keep their seconds.
 *
 * A stale row, and a row that has finished, failed or lost its process, is
 * quiet: its name and time are in the secondary ink.
 *
 * In a narrow window every row has two lines: the name, and under it the status
 * and its time, led by the tool when the table names one: "Codex · Working".
 * When that line is too short, it goes on to a third rather than cut a word.
 * The tool is never a logo or a colour.
 *
 * The sessions that need the person are the hero's, not the table's, so the
 * Jump here is always the quiet one. What a press of a tmux session's Jump
 * came to is said for a few seconds in a badge beside the name. Where the line
 * cannot hold both, the badge goes under the name, so the name is never cut
 * for it, and the row's height holds the two lines. In a narrow window it is
 * always under the name.
 */
export function SessionRow({
  session,
  now,
  jumpColumn,
  narrow = false,
  agent,
  folderColumn = true,
  appColumn = true,
}: SessionRowProps) {
  const ended = session.status === "finished" || session.status === "failed";
  const gone = session.alive === false;
  // A session that finished or failed is expected to have no process. The badge
  // is for one that still claims to be running when its process has gone.
  const orphaned = gone && !ended;
  const stale = isStaleIdle(session);
  const quiet = stale || ended || gone;
  const mark: MarkKind = stale ? "stale" : session.status;
  const statusWord = stale ? "Stale" : STATUS_LABEL[session.status];
  const jump = useJump(session.id);
  const since = session.statusSince;
  const surface = SURFACE_LABEL[session.surface];
  const lasted = since !== null ? now - since : null;

  const duration = (
    <Tooltip
      content={
        since !== null ? `Since ${formatSince(since, now)}` : "The source did not report a time"
      }
      mono={since !== null}
      align='end'
    >
      <span
        data-part='duration'
        className={cn(
          "shrink-0 rounded-bar whitespace-nowrap tabular-nums",
          quiet ? "text-ink-secondary" : "text-ink",
        )}
      >
        {lasted !== null ? (
          <>
            <span className='sr-only'>
              {ended
                ? `${shortDurationInWords(lasted)} ago`
                : `for ${shortDurationInWords(lasted)}`}
            </span>
            <span aria-hidden>
              {formatShortDuration(lasted)}
              {ended && " ago"}
            </span>
          </>
        ) : (
          <>
            <span className='sr-only'>time not reported</span>
            <span aria-hidden>–</span>
          </>
        )}
      </span>
    </Tooltip>
  );

  /**
   * Narrow, the line under the name: the tool when the table names one, then
   * the status and its time, "Codex · Working 12m". Nothing on it is cut while
   * a line can hold it: when the line is too short for all of it, the status
   * and its time go to a line of their own under the tool, and when that line
   * is too short as well, the time goes under the status. Only a tool's name
   * wider than the whole line is cut, and it stays a hover or a Tab away.
   *
   * The dot that sets the tool apart belongs to the status. It sits in the gap
   * before it, and the line clips it once the status starts a line of its own.
   */
  const statusUnder = (status: ReactNode) => (
    <p
      data-part='status-under'
      className='flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-px overflow-x-clip leading-tight'
    >
      {agent !== undefined && (
        <>
          <Truncated data-part='agent' className='min-w-0'>
            {agent}
          </Truncated>
          {/* Read as "tool, status". On screen the two are set apart by a dot. */}
          <span className='sr-only'>, </span>
        </>
      )}
      <span
        data-part='status-time'
        className='relative flex min-w-0 grow flex-wrap items-baseline justify-between gap-x-3 gap-y-px'
      >
        {agent !== undefined && (
          <span aria-hidden data-part='dot' className='absolute right-full mr-1'>
            ·
          </span>
        )}
        {status}
        {duration}
      </span>
    </p>
  );

  return (
    <tr
      data-slot='session-row'
      data-session={session.id}
      data-status={session.status}
      data-stale={stale || undefined}
      className='group relative text-body text-ink-secondary'
    >
      <td
        className={cn(
          CELL,
          "h-row",
          narrow && "py-2",
          // The row's one rounded shape under the pointer, 10px inside the card.
          "before:pointer-events-none before:absolute before:inset-x-2.5 before:inset-y-px before:-z-10 before:rounded-inner before:transition-colors before:duration-120 group-hover:before:bg-fill-hover",
        )}
      >
        <div className='flex min-w-0 items-center gap-3'>
          <StatusMark kind={mark} />
          <div className='grid min-w-0 flex-1 gap-px'>
            {/* What Jump came to goes under the name when the line cannot hold both. */}
            <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-px'>
              <div className='flex max-w-full min-w-0 items-center gap-2'>
                <Truncated
                  data-part='name'
                  className={cn(
                    "text-row",
                    quiet ? "font-medium text-ink-secondary" : "font-semibold text-ink",
                  )}
                >
                  {session.name}
                </Truncated>
                {orphaned && <Badge tone='outline'>Process ended</Badge>}
              </div>
              {!narrow && <JumpNote session={session} jump={jump} />}
            </div>
            {/* Narrow, there is no room beside the name, so it has a line of its own. */}
            {narrow && <JumpNote session={session} jump={jump} className='justify-self-start' />}
            {narrow &&
              statusUnder(
                <span data-part='status' className='whitespace-nowrap'>
                  {statusWord}
                </span>,
              )}
          </div>
        </div>
      </td>

      {agent !== undefined && !narrow && (
        <td data-part='agent' className={cn(CELL, "truncate")}>
          {agent}
        </td>
      )}

      {folderColumn && (
        <td className={cn(CELL, "max-mid:hidden")}>
          {/* The folder's name is shown; the whole path is one Tab or one hover away. */}
          <Tooltip content={session.cwd} mono>
            <span
              data-part='project'
              tabIndex={session.cwd ? 0 : undefined}
              className='block truncate rounded-bar text-ink-secondary'
            >
              {session.project ?? "–"}
            </span>
          </Tooltip>
        </td>
      )}

      {appColumn && (
        <td data-part='app' className={cn(CELL, "truncate max-mid:hidden")}>
          {surface}
        </td>
      )}

      {!narrow && (
        <td className={CELL}>
          {/* Read as one phrase: "Working 8m". */}
          <div className='flex items-baseline justify-between gap-2 whitespace-nowrap'>
            <span data-part='status'>{statusWord}</span>
            {duration}
          </div>
        </td>
      )}

      {jumpColumn && (
        <td className={cn(CELL, "overflow-visible text-right")}>
          <Jump
            session={session}
            jump={jump}
            className='group-hover:bg-fill-selected group-hover:text-ink'
          />
        </td>
      )}
    </tr>
  );
}
