import type { Session } from "@core/sessions/session";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
import { formatShortDuration, formatSince, shortDurationInWords } from "@dashboard/lib/format";
import { quietFor, quietPhrase, quietPhraseInWords } from "@dashboard/lib/sessions/quiet";
import { cn } from "@dashboard/lib/utils";

/**
 * How long a session has had its status, in the list's short form, "34m":
 * seconds only in the first minute, and days alone. An ending says how long
 * ago, "2h ago". The exact start is in the tooltip. A quiet session, stale or
 * ended, has it in the secondary ink. The row and the board's card both draw
 * it after the status word, so the two read as one phrase: "Working 34m".
 */
export function Duration({
  session,
  now,
  quiet,
}: {
  session: Pick<Session, "status" | "statusSince">;
  now: number;
  quiet: boolean;
}) {
  const ended = session.status === "finished" || session.status === "failed";
  const since = session.statusSince;
  const lasted = since !== null ? now - since : null;
  return (
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
}

/**
 * How long a working session's agent has written nothing, once that is 5
 * minutes or more: "quiet for 12m", in the list's short form and the muted ink.
 * The last write's time is one hover or one Tab away. Nothing, for any other
 * session.
 */
export function QuietFor({
  session,
  now,
}: {
  session: Pick<Session, "status" | "lastWriteAt">;
  now: number;
}) {
  const ms = quietFor(session, now);
  if (ms === null || session.lastWriteAt === undefined) return null;
  return (
    <Tooltip content={`Last write at ${formatSince(session.lastWriteAt, now)}`} mono align='end'>
      <span
        data-part='quiet'
        tabIndex={0}
        className='block w-fit rounded-bar leading-tight whitespace-nowrap text-ink-muted tabular-nums'
      >
        <span className='sr-only'>{quietPhraseInWords(ms)}</span>
        <span aria-hidden>{quietPhrase(ms)}</span>
      </span>
    </Tooltip>
  );
}
