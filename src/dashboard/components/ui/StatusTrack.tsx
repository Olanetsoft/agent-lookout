import { useRef, useState, type KeyboardEvent } from "react";

import type { SessionStatus } from "@core/session";
import { Tooltip } from "@dashboard/components/ui/Tooltip";
import { durationInWords, formatClock, formatDuration } from "@dashboard/lib/format";
import { STATUS_LABEL } from "@dashboard/lib/status";
import { cn } from "@dashboard/lib/utils";

/**
 * What a stretch of a track shows: a session status, an idle stretch past the
 * stale threshold, or time nobody measured.
 */
export type TrackKind = SessionStatus | "stale" | "unmeasured";

export interface TrackSegment {
  /** When the stretch began, epoch milliseconds. */
  from: number;
  /** When it ended, or when it was last seen. For the stretch that reaches the present, the present. */
  to: number;
  kind: TrackKind;
  /** Set false when the stretch began before anything saw it. Its length is then a minimum. */
  startKnown?: boolean;
  /** Set for the stretch that reaches the present. It reads "so far" and "to now". */
  ongoing?: boolean;
  /**
   * Set for a wait nobody had answered when it was last seen: the open wait,
   * drawn in the lamp's colour. A needs-you stretch without it was answered, and
   * is drawn hollow. While answers arrive the open wait reaches the present.
   * Once they stop it ends at the last one, still open but no longer ongoing,
   * and its length is a minimum. Only a needs-you stretch is ever open.
   */
  open?: boolean;
}

interface StatusTrackProps {
  /** In time order, never overlapping. Time with no segment is drawn empty. */
  segments: readonly TrackSegment[];
  /** Left edge of the window, epoch milliseconds. */
  start: number;
  /** Right edge of the window: the present. */
  end: number;
  /** The session's name, for assistive technology. */
  label: string;
  /**
   * Moments, epoch milliseconds, at which a time rule runs down the track. The
   * track draws them itself, so each one stops where the track is hatched, and
   * the rules of stacked tracks meet into one line.
   */
  rules?: readonly number[];
  className?: string;
}

const KIND_LABEL: Record<TrackKind, string> = {
  ...STATUS_LABEL,
  stale: "Stale",
  unmeasured: "Not measured",
};

/**
 * How each kind is drawn, with the fills every bar on the screen shares. Height
 * says how much the stretch wanted the person, so no two kinds differ by colour
 * alone, and a track reads in greyscale:
 *
 *   needs you, open     a 16px block in the lamp's colour, inside its edge, with
 *                       the lamp's glow
 *   needs you, answered a 16px hollow block in the idle colour, faintly filled
 *   working             a 10px capsule in the working fill, lit along its top
 *   idle                a 2px line
 *   stale               a 2px dotted line
 *   unknown             a 6px hollow band in the idle colour
 *   finished, failed    a tick or a small cross at the moment it ended, and
 *                       nothing after it
 *   not measured        the hatch, 3px in from the top and the bottom of the
 *                       track, with no ground of its own
 *
 * Each mark stops 2px short of the end of its stretch, so two stretches side by
 * side read as two.
 */
function Mark({ segment, from, share }: { segment: TrackSegment; from: number; share: number }) {
  switch (segment.kind) {
    case "needs-you":
      return (
        <span
          aria-hidden
          data-part='mark'
          className={cn(
            "block h-bar-needs-you w-full rounded-bar",
            segment.open ? "bar-open bar-glow" : "bar-answered",
          )}
        />
      );
    case "working":
      return (
        <span
          aria-hidden
          data-part='mark'
          className='bar-working block h-bar-working w-full rounded-capsule'
        />
      );
    case "idle":
      return (
        <span
          aria-hidden
          data-part='mark'
          className='bar-idle block h-bar-idle w-full rounded-capsule'
        />
      );
    case "stale":
      return <span aria-hidden data-part='mark' className='stale-dots block h-bar-idle w-full' />;
    case "unknown":
      return (
        <span
          aria-hidden
          data-part='mark'
          className='block h-1.5 w-full rounded-bar inset-ring inset-ring-status-idle'
        />
      );
    case "finished":
      return (
        <span
          aria-hidden
          data-part='mark'
          className='absolute left-0 h-3 w-0.5 rounded-bar bg-status-finished'
        />
      );
    case "failed":
      return (
        <svg
          aria-hidden
          data-part='mark'
          viewBox='0 0 10 10'
          fill='none'
          className='absolute left-0 size-2.5 -translate-x-1/2 text-status-finished'
        >
          <path
            d='M2 2l6 6M8 2l-6 6'
            stroke='currentColor'
            strokeWidth='1.75'
            strokeLinecap='round'
          />
        </svg>
      );
    case "unmeasured":
      // The hatch is laid as wide as the whole track and shifted back to the
      // track's left edge, then cut to this stretch, so its lines fall in the
      // same places on every track and line up from row to row.
      return (
        <span
          aria-hidden
          data-part='hatch'
          className='absolute inset-0'
          style={{ clipPath: "inset(3px 2px 3px 0 round var(--radius-bar))" }}
        >
          <span
            className='unmeasured-hatch absolute inset-y-0'
            style={{ left: percent(-from / share), width: percent(1 / share) }}
          />
        </span>
      );
  }
}

/**
 * A stretch shorter than this share of the window may be drawn at its minimum
 * width. It is then kept above its neighbours, and can be pointed at from a
 * little either side of it.
 */
const NARROW = 0.01;

/** Where each key takes the keyboard, given the stretch it is on and the last one. */
const KEYS: Record<string, (current: number, last: number) => number> = {
  ArrowLeft: (current) => Math.max(0, current - 1),
  ArrowRight: (current, last) => Math.min(last, current + 1),
  Home: () => 0,
  End: (_current, last) => last,
};

interface Reading {
  status: string;
  /** How long it lasted, as the page writes a duration: `at least 4m 12s so far`. */
  lasted: string;
  /** The same, with the duration in words. */
  lastedInWords: string;
  /** `10:02:11 to 10:06:23`, or `10:02:11 to now` for the stretch that reaches the present. */
  clock: string;
}

function read(segment: TrackSegment): Reading {
  const length = segment.to - segment.from;
  const open = segment.kind === "needs-you" && segment.open === true;
  // An open wait that stops short of the present was cut off where the answers
  // stopped. Nobody saw it end, so it lasted at least as long as is drawn.
  const minimum = segment.startKnown === false || (open && !segment.ongoing);
  const qualify = (duration: string) =>
    [minimum && "at least", duration, segment.ongoing && "so far"].filter(Boolean).join(" ");
  return {
    status: segment.kind === "needs-you" && !open ? "Needed you" : KIND_LABEL[segment.kind],
    lasted: qualify(formatDuration(length)),
    lastedInWords: qualify(durationInWords(length)),
    clock: `${formatClock(segment.from)} to ${segment.ongoing ? "now" : formatClock(segment.to)}`,
  };
}

function percent(share: number): string {
  return `${Math.round(share * 100_000) / 1_000}%`;
}

/**
 * Where the time rules show: everywhere but under a stretch nobody measured,
 * where the hatch is, up to the 2px every mark stops short of its end. The
 * hatch has no ground of its own on glass, so this is what stops a rule there.
 */
function rulesMask(shown: readonly TrackSegment[], start: number, end: number): string {
  const span = end - start;
  const stops = shown
    .filter((segment) => segment.kind === "unmeasured")
    .map((segment) => {
      const from = percent((Math.max(segment.from, start) - start) / span);
      const to = `calc(${percent((Math.min(segment.to, end) - start) / span)} - 2px)`;
      return `black ${from}, transparent ${from} ${to}, black ${to}`;
    });
  return `linear-gradient(to right, black, ${stops.join(", ")}${stops.length ? ", " : ""}black)`;
}

/**
 * One session's status over a window of time, as a row of marks placed by time.
 * The window ends at the present. Time the session was not running is left
 * empty. Time in which its status is not known is hatched, on this track alone:
 * a status known from its source is drawn as itself, with nothing behind it. A
 * hatched stretch is a stretch like any other: it can be pointed at, it has a
 * tooltip and a name, and the arrow keys stop on it.
 *
 * Pointing at a stretch, or reaching it with the keyboard, says what the status
 * was, how long it lasted and when. The track is one stop on the way through the
 * page: Tab reaches the stretch at the present, Left and Right move between
 * stretches, and Home and End go to the first and the last.
 *
 * Nothing in the track moves, so there is nothing for the reduced-motion
 * preference to stop.
 */
export function StatusTrack({
  segments,
  start,
  end,
  label,
  rules = [],
  className,
}: StatusTrackProps) {
  const track = useRef<HTMLDivElement>(null);
  // The end of the stretch the keyboard is on. Null means the one at the present.
  const [chosen, setChosen] = useState<number | null>(null);

  const span = end - start;
  const shown =
    span > 0
      ? segments.filter(
          (segment) => segment.to > segment.from && segment.to > start && segment.from < end,
        )
      : [];
  const last = shown.length - 1;
  const found = chosen === null ? -1 : shown.findIndex((segment) => segment.to === chosen);
  const current = found === -1 ? last : found;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = KEYS[event.key];
    if (!move || last < 0) return;
    event.preventDefault();
    const stretches = track.current?.querySelectorAll<HTMLElement>('[data-part="segment"]');
    stretches?.[move(current, last)]?.focus();
  };

  return (
    <div
      ref={track}
      data-slot='status-track'
      role='group'
      aria-label={`${label}: status over time. Arrow keys move along it.`}
      onKeyDown={onKeyDown}
      className={cn("relative h-track w-full", className)}
    >
      {span > 0 && rules.some((at) => at > start && at < end) && (
        <span
          aria-hidden
          data-part='rules'
          className='pointer-events-none absolute inset-0'
          style={{ maskImage: rulesMask(shown, start, end) }}
        >
          {rules
            .filter((at) => at > start && at < end)
            .map((at) => (
              <span
                key={at}
                className='absolute inset-y-0 w-px bg-hairline'
                style={{ left: percent((at - start) / span) }}
              />
            ))}
        </span>
      )}
      {shown.map((segment, index) => {
        const from = Math.max(segment.from, start);
        const to = Math.min(segment.to, end);
        const share = (to - from) / span;
        const reading = read(segment);
        return (
          <Tooltip
            // A stretch that has ended is known by when it ended, which never
            // changes. The one at the present keeps its place however it grows,
            // so focus and an open tooltip survive every new answer.
            key={index === last ? "present" : segment.to}
            content={
              <span className='flex flex-col'>
                <span>{reading.status}</span>
                <span className='font-mono text-fact text-ink-secondary'>{reading.lasted}</span>
                <span className='font-mono text-fact text-ink-muted'>{reading.clock}</span>
              </span>
            }
          >
            <span
              data-part='segment'
              data-kind={segment.kind}
              data-open={segment.kind === "needs-you" ? Boolean(segment.open) : undefined}
              role='img'
              aria-label={`${reading.status}, ${reading.lastedInWords}, ${reading.clock}`}
              tabIndex={index === current ? 0 : -1}
              onFocus={() => setChosen(index === last ? null : segment.to)}
              className={cn(
                // The whole height of the track is the stretch, whatever the height
                // of its mark, so a thin line is as easy to point at as a tall bar.
                "absolute inset-y-0 flex min-w-0.75 items-center pr-0.5 focus-visible:z-20",
                share < NARROW && "z-10 before:absolute before:inset-y-0 before:-inset-x-1",
              )}
              style={{
                // Never so far right that the minimum width would leave the track.
                left: `min(${percent((from - start) / span)}, calc(100% - 3px))`,
                width: percent(share),
              }}
            >
              <Mark segment={segment} from={(from - start) / span} share={share} />
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
