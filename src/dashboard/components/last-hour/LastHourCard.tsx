import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";

import type { Session, SessionEvent, SourceHealth } from "@core/session";
import { Callout } from "@dashboard/components/ui/Callout";
import { EmptyState } from "@dashboard/components/ui/EmptyState";
import { Loading } from "@dashboard/components/ui/Loading";
import { SectionCard } from "@dashboard/components/ui/SectionCard";
import { useElementWidth } from "@dashboard/hooks/useElementWidth";
import type { CollectorHistory } from "@dashboard/lib/collectorStore";
import { formatClockMinutes, formatDuration } from "@dashboard/lib/format";
import { timeTicks } from "@dashboard/lib/historyChart";
import {
  buildLastHour,
  type LastHour,
  type LastHourBucket,
  type LastHourMeans,
} from "@dashboard/lib/lastHour";
import { quietPhrase } from "@dashboard/lib/measured";
import { cn } from "@dashboard/lib/utils";

interface LastHourCardProps {
  /** Null until the first answer arrives. The card then holds its place. */
  sessions: readonly Session[] | null;
  /** The sources behind those sessions. They decide whether an empty hour is a real one. */
  sources?: readonly SourceHealth[];
  /** Every event the page holds. They tell a wait still open from one answered. */
  events?: readonly SessionEvent[];
  /** The hour of history the page holds, or null when it could not be read. */
  history: CollectorHistory | null;
  /** The present. The hour ends here. */
  now: number;
  /** The last answer. Nothing after it was measured. */
  asOf?: number;
  className?: string;
}

/** A segment smaller than this, in sessions, is left out of a bar: it would be a sliver. */
const LEAST_SEGMENT = 0.02;
/** A mean smaller than this is not read out. */
const LEAST_SAID = 0.05;
/** The least room one time label needs, so the axis never crowds. */
const TICK_ROOM = 96;

function percent(share: number): string {
  return `${Math.round(share * 100_000) / 1_000}%`;
}

/** "09:05 to 09:10", or "09:55 to now" for the bucket at the present. */
function rangeOf(bucket: LastHourBucket, end: number): string {
  return `${formatClockMinutes(bucket.from)} to ${bucket.to >= end ? "now" : formatClockMinutes(bucket.to)}`;
}

/** One decimal, as the chart reads a mean: "3.2". */
function mean(value: number): string {
  return value.toFixed(1);
}

/**
 * The means of a bucket in words, in the chart's order from the baseline up,
 * named as the legend and the reading box name them.
 */
function meansInWords(means: LastHourMeans): string {
  const parts = [
    means.open >= LEAST_SAID && `needs you ${mean(means.open)}`,
    means.answered >= LEAST_SAID && `answered ${mean(means.answered)}`,
    means.working >= LEAST_SAID && `working ${mean(means.working)}`,
    means.idle >= LEAST_SAID && `idle ${mean(means.idle)}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "no sessions";
}

/** One bucket read out: its clock range, then its means, or that it was not measured. */
function readBucket(bucket: LastHourBucket, end: number): string {
  if (!bucket.means) return `${rangeOf(bucket, end)}: not measured`;
  const partly = bucket.measuredMs < bucket.to - bucket.from - 1_000;
  return `${rangeOf(bucket, end)}: ${meansInWords(bucket.means)}${
    partly ? `, measured for ${formatDuration(bucket.measuredMs)}` : ""
  }`;
}

/** The whole chart in words, for assistive technology. */
function describe(hour: LastHour): string {
  const lost = hour.unmeasured.map(
    (span) =>
      `from ${formatClockMinutes(span.from)} to ${span.to >= hour.end ? "now" : formatClockMinutes(span.to)}`,
  );
  return [
    "The average number of sessions in each status, every five minutes over the last hour.",
    lost.length > 0 ? `Not measured ${lost.join(", and ")}.` : "",
    ...hour.buckets.map((bucket) => `${readBucket(bucket, hour.end)}.`),
  ]
    .filter(Boolean)
    .join(" ");
}

/** Which labels the count axis carries: the bottom, the top and the middle when there is one. */
function labelled(ticks: readonly number[]): Set<number> {
  const shown = new Set<number>();
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  if (first !== undefined) shown.add(first);
  if (last !== undefined) shown.add(last);
  if (ticks.length % 2 === 1) {
    const middle = ticks[(ticks.length - 1) / 2];
    if (middle !== undefined) shown.add(middle);
  }
  return shown;
}

/**
 * One bar: the empty glass of a tube as tall as the sessions that were open,
 * filled from the bottom with the time they waited on the person, then the
 * time they worked. What is left of the tube is idle. A wait still open is the
 * lamp's fill; one answered is hollow in the idle colour.
 */
function Bar({
  means,
  ceiling,
  from,
  to,
  hour,
}: {
  means: LastHourMeans;
  ceiling: number;
  from: number;
  to: number;
  hour: LastHour;
}) {
  if (means.total <= 0) return null;
  const span = hour.end - hour.start;
  const segments: [string, number, string][] = [
    ["open", means.open, "bar-open"],
    ["answered", means.answered, "bar-answered"],
    ["working", means.working, "bar-working"],
  ];
  return (
    <div
      aria-hidden
      data-part='bar'
      className='bar-tube absolute bottom-0 z-10 flex flex-col-reverse gap-0.5 overflow-hidden rounded-t-tube rounded-b-bar'
      style={{
        left: percent((from - hour.start) / span),
        width: `max(2px, calc(${percent((to - from) / span)} - 4px))`,
        height: percent(Math.min(1, means.total / ceiling)),
      }}
    >
      {segments.map(([kind, value, fill]) =>
        value >= LEAST_SEGMENT ? (
          <i
            key={kind}
            data-part='segment'
            data-kind={kind}
            className={cn("block shrink-0", fill)}
            style={{ height: percent(value / means.total) }}
          />
        ) : null,
      )}
    </div>
  );
}

/** A swatch in the legend, drawn with the fill its bars use. */
function Swatch({ fill }: { fill: string }) {
  return <i aria-hidden className={cn("block h-2.5 w-3.5 rounded-bar", fill)} />;
}

/**
 * The chart itself: the bars over a count axis on the right, the hatch where
 * nothing was measured, and a time axis that ends at now.
 *
 * It is one stop on the way through the page. Pointing at it, or focusing it
 * and pressing the arrow keys, reads out one bucket: its clock range and its
 * means. Home and End go to the first and the last bucket.
 */
function Chart({ hour }: { hour: LastHour }) {
  const descriptionId = useId();
  const [axis, width] = useElementWidth<HTMLDivElement>();
  // The bucket being read, or null when nothing points at the chart.
  const [chosen, setChosen] = useState<number | null>(null);
  const span = hour.end - hour.start;
  const ceiling = hour.axis.ceiling;
  const last = hour.buckets.length - 1;
  const index = chosen === null ? last : Math.min(chosen, last);
  const bucket = hour.buckets[index];
  const reading = bucket ? readBucket(bucket, hour.end) : "";
  const shown = labelled(hour.axis.ticks);

  const marks =
    width > 0
      ? timeTicks(hour.start, hour.end, Math.max(1, Math.floor(width / TICK_ROOM)))
          .map((at) => ({ at, share: (at - hour.start) / span }))
          // Clear of the left edge, and of "now" at the right.
          .filter(({ share }) => share * width >= 16 && share * width <= width - 52)
      : [];

  const pointAt = (clientX: number, box: DOMRect) => {
    const at = hour.start + ((clientX - box.left) / box.width) * span;
    const found = hour.buckets.findIndex((candidate) => at < candidate.to);
    setChosen(found === -1 ? last : found);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move: Record<string, (from: number) => number> = {
      ArrowLeft: (from) => from - 1,
      ArrowDown: (from) => from - 1,
      ArrowRight: (from) => from + 1,
      ArrowUp: (from) => from + 1,
      Home: () => 0,
      End: () => last,
    };
    const step = move[event.key];
    if (!step) return;
    event.preventDefault();
    setChosen(Math.min(last, Math.max(0, step(index))));
  };

  return (
    <>
      <div
        data-slot='last-hour-chart'
        role='slider'
        tabIndex={0}
        aria-label='Last hour, every five minutes. Arrow keys read each five minutes.'
        aria-describedby={descriptionId}
        aria-orientation='horizontal'
        aria-valuemin={0}
        aria-valuemax={Math.max(0, last)}
        aria-valuenow={index}
        aria-valuetext={reading}
        onPointerMove={(event) =>
          pointAt(event.clientX, event.currentTarget.getBoundingClientRect())
        }
        onPointerLeave={() => setChosen(null)}
        onBlur={() => setChosen(null)}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible"))
            setChosen((current) => current ?? last);
        }}
        onKeyDown={onKeyDown}
        className='relative mt-4 mr-11.5 ml-6 min-h-28 flex-1 cursor-crosshair rounded-bar max-wide:h-50 max-wide:flex-none'
      >
        {hour.axis.ticks.map((value) => (
          <span
            key={value}
            aria-hidden
            data-part='grid'
            className={cn(
              "absolute inset-x-0 block h-px",
              value === 0 ? "bg-rule-strong" : "bg-hairline",
            )}
            style={{ bottom: percent(value / ceiling) }}
          >
            {shown.has(value) && (
              <span className='absolute -top-1.75 -right-7.5 w-5.5 font-mono text-micro leading-3.5 text-ink-muted'>
                {value}
              </span>
            )}
          </span>
        ))}

        {chosen !== null && bucket && (
          // The bucket being read: a selected fill inside a rule, so it shows
          // on the brightest glass by Day as well as at Night, and the reading
          // box beside it is plainly about it.
          <i
            aria-hidden
            data-part='chosen'
            className='absolute inset-y-0 block rounded-bar bg-fill-selected inset-ring inset-ring-rule'
            style={{
              left: percent((bucket.from - hour.start) / span),
              width: `calc(${percent((bucket.to - bucket.from) / span)} - 2px)`,
            }}
          />
        )}

        {hour.unmeasured.map((gap) => (
          <i
            key={gap.from}
            aria-hidden
            data-part='unmeasured'
            className='unmeasured-hatch absolute inset-y-0 z-0 block'
            style={{
              left: percent((gap.from - hour.start) / span),
              width: percent((gap.to - gap.from) / span),
            }}
          />
        ))}

        {hour.buckets.flatMap((item) =>
          item.means
            ? item.measured.map((part) => (
                <Bar
                  key={part.from}
                  means={item.means as LastHourMeans}
                  ceiling={ceiling}
                  from={part.from}
                  to={part.to}
                  hour={hour}
                />
              ))
            : [],
        )}

        {chosen !== null && bucket && (
          <div
            aria-hidden
            data-part='reading'
            className='pointer-events-none absolute top-0 z-20 rounded-row bg-glass-float px-2.5 py-1.5 font-mono text-fact whitespace-nowrap inset-ring inset-ring-rule'
            style={
              (bucket.from - hour.start) / span > 0.55
                ? { right: `calc(${percent((hour.end - bucket.from) / span)} + 6px)` }
                : { left: `calc(${percent((bucket.to - hour.start) / span)} + 2px)` }
            }
          >
            <span className='block text-ink-secondary'>{rangeOf(bucket, hour.end)}</span>
            {bucket.means ? (
              <>
                {bucket.means.open >= LEAST_SAID && (
                  <span className='block text-label-needs-you'>
                    Needs you {mean(bucket.means.open)}
                  </span>
                )}
                {bucket.means.answered >= LEAST_SAID && (
                  <span className='block text-ink'>Answered {mean(bucket.means.answered)}</span>
                )}
                <span className='block text-ink'>Working {mean(bucket.means.working)}</span>
                <span className='block text-ink'>Idle {mean(bucket.means.idle)}</span>
              </>
            ) : (
              <span className='block text-ink'>Not measured</span>
            )}
          </div>
        )}
      </div>
      <p id={descriptionId} className='sr-only'>
        {describe(hour)}
      </p>

      <div
        ref={axis}
        aria-hidden
        data-slot='last-hour-axis'
        className='relative mr-11.5 ml-6 h-5.5 font-mono text-micro leading-none text-ink-muted'
      >
        {marks.map((mark) => (
          <span
            key={mark.at}
            data-part='time-tick'
            className='absolute top-1.75 -translate-x-1/2 whitespace-nowrap'
            style={{ left: percent(mark.share) }}
          >
            {formatClockMinutes(mark.at)}
          </span>
        ))}
        <span
          data-part='now'
          className='absolute top-1.75 right-0 whitespace-nowrap text-ink-secondary'
        >
          now
        </span>
      </div>
    </>
  );
}

/**
 * The names of the fills. Needs you is named only while a wait is still open,
 * so the legend is never the only warm thing on the screen.
 */
function Legend({ open }: { open: boolean }) {
  const entries: [string, string, string][] = [
    ["working", "bar-working", "Working"],
    ...(open ? [["needs-you", "bar-open", "Needs you"] as [string, string, string]] : []),
    ["answered", "bar-answered", "Answered"],
    ["idle", "bar-tube", "Idle"],
    ["unmeasured", "unmeasured-hatch", "Not measured"],
  ];
  return (
    <ul
      data-slot='last-hour-legend'
      aria-label='Legend'
      className='flex flex-wrap items-center gap-x-3.5 gap-y-1.5 px-6 pt-2 pb-5 text-caption text-ink-secondary'
    >
      {entries.map(([kind, fill, label]) => (
        <li key={kind} data-kind={kind} className='flex items-center gap-1.5 whitespace-nowrap'>
          <Swatch fill={fill} />
          {label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Last hour: how many sessions were waiting on the person, working or idle, on
 * average, in each five minutes of the hour that ends now. The sentence above
 * the bars says how long sessions waited on the person in all.
 *
 * Built in the page from the history it holds. Time nobody measured is hatched
 * across the full height and never drawn as zero, and a bucket nobody measured
 * has no bar. With nothing to draw the card says why, in one of four distinct
 * ways: still waiting, the hour could not be read, no source could be read, or
 * nothing ran. That nothing ran is said only of the time that was measured:
 * "No sessions since 13:28" when Agent Lookout has watched for less than the
 * hour.
 */
export function LastHourCard({
  sessions,
  sources = [],
  events = [],
  history,
  now,
  asOf = now,
  className,
}: LastHourCardProps) {
  const hour = useMemo(
    () => (sessions && history ? buildLastHour({ history, sessions, events, now, asOf }) : null),
    [sessions, history, events, now, asOf],
  );
  const drawn = hour?.buckets.some((bucket) => (bucket.means?.total ?? 0) > 0) ?? false;

  let body: ReactNode;
  let aside: ReactNode = "every 5 minutes";
  if (sessions === null) {
    body = <Loading label='Reading the last hour' />;
  } else if (hour === null) {
    aside = undefined;
    body = (
      <div className='px-6 pb-5'>
        <Callout tone='error' title='The last hour could not be read'>
          <p>
            Agent Lookout did not answer when asked for its history. The page asks again every two
            seconds.
          </p>
        </Callout>
      </div>
    );
  } else if (drawn || sessions.length > 0) {
    body = (
      <>
        <p data-part='sum' className='px-6 text-body text-ink-secondary'>
          {hour.waitedMs > 0 ? (
            <>
              Sessions waited on you for{" "}
              <span className='font-semibold text-ink tabular-nums'>
                {formatDuration(hour.waitedMs)}
              </span>{" "}
              in all
            </>
          ) : hour.unmeasured.length > 0 ? (
            "No session waited on you in the time measured"
          ) : (
            "No session waited on you in the last hour"
          )}
        </p>
        <Chart hour={hour} />
        <Legend open={hour.openMs > 0} />
      </>
    );
  } else if (sources.some((source) => source.state === "searching")) {
    body = <Loading label='Looking for sessions' />;
  } else if (!sources.some((source) => source.state === "ok")) {
    aside = undefined;
    body = (
      <div className='px-6 pb-5'>
        <Callout title='The last hour was not measured'>
          <p>No source could be read, so there is nothing to count. The Sessions card says why.</p>
        </Callout>
      </div>
    );
  } else {
    // Only the time that was measured can be called empty: right after Agent
    // Lookout starts, that is the minutes since it did, not the hour.
    const when = quietPhrase({ from: hour.start, to: hour.end }, hour.unmeasured);
    body = (
      <EmptyState
        compact
        title={when ? `No sessions ${when}` : "Nothing was measured in the last hour"}
      >
        <p>When a session runs, how many waited, worked or sat idle is drawn here.</p>
      </EmptyState>
    );
  }

  return (
    <SectionCard title='Last hour' aside={aside} className={cn("flex flex-col", className)}>
      {body}
    </SectionCard>
  );
}
