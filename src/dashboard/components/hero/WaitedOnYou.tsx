import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { durationInWords, formatDuration } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";
import {
  measuredNote,
  waitedHeading,
  type WaitedOnYou as Waits,
} from "@dashboard/lib/sessions/waits";

/** The bars' scale never falls below seven minutes, so a short wait reads as short. */
const LEAST_SCALE_MS = 7 * 60_000;

interface WaitedOnYouProps {
  /** The waits over the period, or null when the history could not be read. */
  waits: Waits | null;
}

/**
 * How long each session has waited on the person, one bar each, longest first.
 *
 * A wait still open is the lamp's fill with its glow, and grows each second; its
 * name and value are lit. A wait that is over is hollow in the idle colour,
 * faintly filled, as it is everywhere else. Open and answered differ by shape as
 * well as colour, a filled bar against an outlined one, and each track says in
 * words what it shows.
 *
 * The period is what the page can vouch for, and the note under the bars says
 * from when, and how much of it nobody measured.
 *
 * In a narrow window each bar takes the whole width, under its name and value.
 * Its one column never grows past the hero, so a long name is cut with an
 * ellipsis there as it is everywhere else, stays reachable in full, and its
 * value stays in sight.
 */
export function WaitedOnYou({ waits }: WaitedOnYouProps) {
  const heading = waits ? waitedHeading(waits) : "Waited on you";
  const longest = waits?.sessions[0]?.ms ?? 0;
  const scale = Math.max(LEAST_SCALE_MS, longest);

  return (
    <div
      data-slot='waited-on-you'
      role='group'
      aria-label={heading}
      className='grid grid-cols-1 gap-2.5 border-t border-hairline pt-4.5'
    >
      <div className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1'>
        <h3 className='min-w-0 text-body font-semibold text-ink'>{heading}</h3>
        {waits && waits.totalMs > 0 && (
          <p data-part='total' className='shrink-0 text-caption text-ink-secondary'>
            <span className='text-body font-semibold text-ink tabular-nums'>
              {formatDuration(waits.totalMs)}
            </span>{" "}
            in all
          </p>
        )}
      </div>

      {waits && waits.sessions.length > 0 && (
        <ul data-part='bars' className='grid grid-cols-1 gap-1.75'>
          {waits.sessions.map((session) => {
            const words = `${session.startKnown ? "" : "at least "}${durationInWords(session.ms)}`;
            return (
              <li
                key={session.id}
                data-part='waited'
                data-open={session.open}
                className='flex items-center gap-4 text-body leading-5 max-mid:flex-wrap max-mid:gap-y-1'
              >
                <Truncated
                  data-part='who'
                  className={cn(
                    "w-waited-name shrink-0 max-mid:w-auto max-mid:min-w-0 max-mid:flex-1",
                    session.open ? "font-semibold text-ink" : "font-medium text-ink-secondary",
                  )}
                >
                  {session.name}
                </Truncated>
                <span
                  data-part='track'
                  role='img'
                  aria-label={
                    session.open
                      ? `${session.name} has waited ${words}, still waiting`
                      : `${session.name} waited ${words}, answered`
                  }
                  className='relative h-2.5 min-w-0 flex-1 before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-hairline max-mid:order-last max-mid:basis-full'
                >
                  <i
                    data-part='bar'
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-bar",
                      session.open ? "bar-open bar-glow" : "bar-answered",
                    )}
                    style={{ width: `${Math.round((session.ms / scale) * 10_000) / 100}%` }}
                  />
                </span>
                <span
                  data-part='value'
                  aria-hidden
                  className={cn(
                    "w-16 shrink-0 text-right whitespace-nowrap tabular-nums",
                    session.open ? "font-semibold text-label-needs-you" : "text-ink-secondary",
                  )}
                >
                  {formatDuration(session.ms)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <p data-part='note' className='text-caption text-ink-secondary'>
        {waits === null
          ? "The history could not be read, so how long sessions waited is not known."
          : waits.sessions.length === 0
            ? `No session waited on you. ${measuredNote(waits)}`
            : measuredNote(waits)}
      </p>
    </div>
  );
}
