import type { Session } from "@core/sessions/session";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { Branch } from "@dashboard/components/sessions/Branch";
import { Duration, QuietFor } from "@dashboard/components/sessions/StatusTime";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useJump } from "@dashboard/hooks/data/useJump";
import { isStaleIdle } from "@dashboard/lib/sessions/sessions";
import { STATUS_LABEL, surfaceLabel } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";

interface BoardCardProps {
  session: Session;
  now: number;
  /** The tool the session belongs to, in plain words, once more than one is found. */
  agent?: string;
}

/**
 * One session on the board: what a row of the list says, stacked to fit a
 * column. Its mark and name; where it works, "storefront on checkout-flow";
 * the app when it is known, and the tool once more than one is found; its
 * status and how long, read as one phrase, "Working 12m", with how long the
 * agent has been quiet under it when it says so; and Jump.
 *
 * It is an inner surface of the card's glass: a faint fill inside a hairline,
 * on the corners of a selection 10px inside the panel. Nothing about it is
 * warm but the lamp of a session that needs the person. Its Jump is the quiet
 * one, as in the list: the solid one belongs to the hero, which holds the same
 * session above.
 *
 * Agent Lookout reports what each session is doing and changes none of it, so
 * a card cannot be dragged, and nothing about it looks as if it could. It
 * moves to another column on its own, when its session changes status.
 *
 * A long name, folder, branch or tool is cut, and stays a hover or a Tab away.
 * What a press of Jump came to is a badge beside the name, or under it where
 * the line cannot hold both, and the two sentences about macOS take a line of
 * their own, as in the list.
 */
export function BoardCard({ session, now, agent }: BoardCardProps) {
  const ended = session.status === "finished" || session.status === "failed";
  const gone = session.alive === false;
  // As in the list: the badge is for a session still claiming to run.
  const orphaned = gone && !ended;
  const stale = isStaleIdle(session);
  const quiet = stale || ended || gone;
  const mark: MarkKind = stale ? "stale" : session.status;
  const jump = useJump(session);
  const app = surfaceLabel(session.surface);

  return (
    <li
      data-slot='board-card'
      data-session={session.id}
      data-status={session.status}
      data-stale={stale || undefined}
      draggable={false}
      className='group flex min-w-0 flex-col rounded-inner bg-fill-zebra px-3.5 pt-3 pb-3 text-body text-ink-secondary inset-ring inset-ring-hairline'
    >
      {/* What Jump came to goes under the name when the line cannot hold both. */}
      <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
        <div className='flex max-w-full min-w-0 items-center gap-3'>
          <StatusMark kind={mark} />
          <Truncated
            data-part='name'
            className={cn(
              "text-row",
              quiet ? "font-medium text-ink-secondary" : "font-semibold text-ink",
            )}
          >
            {session.name}
          </Truncated>
        </div>
        {orphaned && <Badge tone='outline'>Process ended</Badge>}
        <JumpNote session={session} jump={jump} />
      </div>

      {/*
       * The folder's name, its whole path one Tab or one hover away, and its
       * branch after it. "on" stays with the branch, which is cut rather than
       * leave the word on a line alone, so the two take two lines at most.
       */}
      {session.project && (
        <p data-part='place' className='mt-1.5 min-w-0 leading-tight'>
          <Tooltip content={session.cwd} mono>
            <span
              data-part='project'
              tabIndex={session.cwd ? 0 : undefined}
              className='inline-block max-w-full truncate rounded-bar align-top'
            >
              {session.project}
            </span>
          </Tooltip>
          {session.git && (
            <>
              {" "}
              <span
                data-part='git'
                className='inline-flex max-w-full gap-1 align-top whitespace-nowrap text-ink-muted'
              >
                <Branch git={session.git} inSentence className='min-w-0' />
              </span>
            </>
          )}
        </p>
      )}

      {/*
       * The app, then the tool. The dot that sets the tool apart sits in the gap
       * before it, and the line clips it if the tool starts a line of its own.
       * An app that is not known is left out, and the tool then stands alone.
       */}
      {(app !== null || agent !== undefined) && (
        <p
          data-part='where'
          className='mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-px overflow-x-clip leading-tight'
        >
          {app !== null && (
            <span data-part='app' className='whitespace-nowrap'>
              {app}
            </span>
          )}
          {agent !== undefined && (
            <>
              {/* Read as "Terminal, Codex". */}
              {app !== null && <span className='sr-only'>, </span>}
              <span className='relative flex min-w-0'>
                {app !== null && (
                  <span aria-hidden className='absolute right-full mr-1'>
                    ·
                  </span>
                )}
                <Truncated data-part='agent' className='min-w-0'>
                  {agent}
                </Truncated>
              </span>
            </>
          )}
        </p>
      )}

      {/*
       * Jump keeps to the card's right edge, as every other Jump on the board
       * does, on a line of its own under the status when a long time leaves no
       * room for both.
       */}
      <div className='mt-3 flex min-w-0 flex-wrap items-center gap-2'>
        <div className='min-w-0'>
          {/* Read as one phrase: "Working 8m". */}
          <p className='flex items-baseline gap-1.5 leading-tight whitespace-nowrap'>
            <span data-part='status'>{stale ? "Stale" : STATUS_LABEL[session.status]}</span>
            <Duration session={session} now={now} quiet={quiet} />
          </p>
          <QuietFor session={session} now={now} />
        </div>
        <Jump
          session={session}
          jump={jump}
          className='ml-auto group-hover:bg-fill-selected group-hover:text-ink'
        />
      </div>
    </li>
  );
}
