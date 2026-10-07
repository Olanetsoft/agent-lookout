import { useMemo, type ReactNode } from "react";

import {
  machineInId,
  nameOnMachine,
  type Session,
  type SessionEvent,
  type SourceHealth,
} from "@core/sessions/session";
import { OnMachine } from "@dashboard/components/sessions/Machine";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { EmptyState } from "@dashboard/components/ui/feedback/EmptyState";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { StatusTrack, type TrackKind } from "@dashboard/components/ui/charts/StatusTrack";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useElementWidth } from "@dashboard/hooks/dom/useElementWidth";
import { MAX_EVENTS, type CollectorHistory } from "@dashboard/lib/api/collectorStore";
import { formatClockMinutes } from "@dashboard/lib/format";
import { timeTicks } from "@dashboard/lib/charts/historyChart";
import { quietPhrase } from "@dashboard/lib/charts/measured";
import { buildTimeline, type Timeline, type TimelineRow } from "@dashboard/lib/charts/timeline";
import { cn } from "@dashboard/lib/utils";

interface TimelineCardProps {
  /** Null until the first answer arrives. The card then holds its place. */
  sessions: readonly Session[] | null;
  /** The sources behind those sessions. They decide whether an empty hour is a real one. */
  sources?: readonly SourceHealth[];
  /** Every event the page holds. */
  events: readonly SessionEvent[];
  /** The last hour of polls, or null when it could not be read. */
  history: CollectorHistory | null;
  /** The present. The timeline ends here. */
  now: number;
  /**
   * The moment the sessions describe. It is the present while answers arrive, and
   * the last answer once they stop, so no row claims minutes that were never seen.
   */
  asOf?: number;
  /** How long a session is idle before it is stale, as the snapshot's time rules say. */
  staleAfterMs?: number;
  className?: string;
}

/** The most marks the time axis carries: one every ten minutes. */
const MAX_TICKS = 6;
/** The least room one time label needs, so the axis never crowds. */
const TICK_ROOM = 96;
/** A label this close to the left edge would be cut by it. */
const EDGE_ROOM = 20;
/** A label this close to the right edge would run into the present's label. */
const NOW_ROOM = 100;

/** Where a moment sits along the window, as a share of its width. */
function shareOf(at: number, timeline: Timeline): number {
  return (at - timeline.start) / (timeline.end - timeline.start);
}

function percent(share: number): string {
  return `${Math.round(share * 100_000) / 1_000}%`;
}

/** The mark beside a row's name: what the session is doing now. None once it has left the list. */
function markOf(row: TimelineRow): MarkKind | null {
  if (row.status === null) return null;
  if (row.answered) return "answered";
  return row.stale && row.status === "idle" ? "stale" : row.status;
}

/**
 * One session: its mark and name, with the other machine it runs on after
 * the name, and its status over the hour beside it, with the time rules.
 * Unnamed, the track has the row to itself.
 */
function Row({
  row,
  timeline,
  rules,
  named,
}: {
  row: TimelineRow;
  timeline: Timeline;
  rules: readonly number[];
  named: boolean;
}) {
  const mark = markOf(row);
  const lit = row.status === "needs-you" && !row.answered;
  // A session on another machine says which, so two of one name are told apart.
  const machine = machineInId(row.id);
  const said = nameOnMachine(row.name, machine);
  return (
    <li
      data-slot='timeline-row'
      data-ended={row.ended}
      className='flex h-track items-center rounded-row odd:bg-fill-zebra'
    >
      {named && (
        <div
          className={cn(
            "flex w-label-col shrink-0 items-center gap-3 px-3 text-body",
            lit ? "font-semibold text-ink" : "font-medium text-ink-secondary",
          )}
        >
          {mark ? (
            <StatusMark kind={mark} />
          ) : (
            <span aria-hidden data-part='no-mark' className='size-mark shrink-0' />
          )}
          <Truncated data-part='name' tooltip={said}>
            {row.name}
            <OnMachine machine={machine} className='text-ink-muted' />
          </Truncated>
        </div>
      )}
      <StatusTrack
        segments={row.segments}
        start={timeline.start}
        end={timeline.end}
        label={row.ended ? `${said}, ended` : said}
        rules={rules}
        className='min-w-0 flex-1'
      />
    </li>
  );
}

/** One entry of the legend: a swatch drawn as the track draws it, and its name. */
interface LegendEntry {
  kind: TrackKind | "answered";
  label: string;
  swatch: ReactNode;
}

/** A block swatch, drawn with the fill its bars use. */
const BLOCK = "block h-2.5 w-3.5 rounded-bar";
/** A line swatch, as long as a block is wide. */
const LINE = "block h-bar-idle w-3.5";

const LEGEND: readonly LegendEntry[] = [
  {
    kind: "needs-you",
    label: "Needs you",
    swatch: <i className={cn(BLOCK, "bar-open")} />,
  },
  {
    kind: "answered",
    label: "Answered",
    swatch: <i className={cn(BLOCK, "bar-answered")} />,
  },
  {
    kind: "working",
    label: "Working",
    swatch: <i className={cn(BLOCK, "bar-working")} />,
  },
  { kind: "idle", label: "Idle", swatch: <i className={cn(LINE, "bar-idle rounded-capsule")} /> },
  { kind: "stale", label: "Stale", swatch: <i className={cn(LINE, "stale-dots")} /> },
  {
    kind: "finished",
    label: "Finished",
    swatch: <i className='mx-1.5 block h-3 w-0.5 rounded-bar bg-status-finished' />,
  },
  {
    kind: "failed",
    label: "Failed",
    swatch: <StatusMark kind='failed' className='size-2.5' />,
  },
  {
    kind: "unknown",
    label: "Unknown",
    swatch: <i className='block h-1.5 w-3.5 rounded-bar inset-ring inset-ring-status-idle' />,
  },
  {
    kind: "unmeasured",
    label: "Not measured",
    swatch: <i className={cn(BLOCK, "unmeasured-hatch")} />,
  },
];

/**
 * What the marks mean. It always names the marks any hour can hold. The lamp
 * is named only while a row has a wait that is still open, so the legend is
 * never the only warm thing on the screen, and a failure or an unknown status
 * only while a row shows one.
 */
function Legend({ timeline }: { timeline: Timeline }) {
  const shown = new Set<LegendEntry["kind"]>([
    "answered",
    "working",
    "idle",
    "stale",
    "finished",
    "unmeasured",
  ]);
  for (const row of timeline.rows) {
    for (const segment of row.segments) {
      if (segment.kind === "needs-you" && segment.open) shown.add("needs-you");
      if (segment.kind === "failed" || segment.kind === "unknown") shown.add(segment.kind);
    }
  }
  return (
    <ul
      data-slot='timeline-legend'
      aria-label='Legend'
      className='flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-caption text-ink-secondary'
    >
      {LEGEND.filter((entry) => shown.has(entry.kind)).map((entry) => (
        <li
          key={entry.kind}
          data-kind={entry.kind}
          className='flex items-center gap-1.5 whitespace-nowrap'
        >
          <span aria-hidden className='flex items-center'>
            {entry.swatch}
          </span>
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * The round clock times the axis marks, as shares of the window. A time too
 * close to either edge is left out: its label would be cut on the left, or run
 * into the present's label on the right.
 */
function timeMarks(timeline: Timeline, width: number): { at: number; left: string }[] {
  if (width <= 0) return [];
  const most = Math.max(1, Math.min(MAX_TICKS, Math.floor(width / TICK_ROOM)));
  return timeTicks(timeline.start, timeline.end, most)
    .map((at) => ({ at, share: shareOf(at, timeline) }))
    .filter(({ share }) => share * width >= EDGE_ROOM && share * width <= width - NOW_ROOM)
    .map(({ at, share }) => ({ at, left: percent(share) }));
}

/**
 * The rows, each drawing a rule down every marked time on its own track, then
 * the time axis. A track stops its rules where it is hatched, so the hatch,
 * which has no ground of its own on glass, still reads as its own stretch.
 *
 * A session's details draw their own row alone, unnamed, since they name the
 * session already, and the track and the axis take the whole width.
 */
export function TimelineChart({
  timeline,
  rows = timeline.rows,
  named = true,
  label = "Sessions over the last hour",
  className = "px-6 pb-4.5",
}: {
  timeline: Timeline;
  /** The rows to draw. Every row of the timeline unless said. */
  rows?: readonly TimelineRow[];
  /** Whether each row leads with its mark and name. */
  named?: boolean;
  label?: string;
  className?: string;
}) {
  const [axis, width] = useElementWidth<HTMLDivElement>();
  const marks = timeMarks(timeline, width);
  const rules = marks.map((mark) => mark.at);

  return (
    <div className={className}>
      <ul data-slot='timeline-rows' aria-label={label}>
        {rows.map((row) => (
          <Row key={row.id} row={row} timeline={timeline} rules={rules} named={named} />
        ))}
      </ul>

      <div
        ref={axis}
        data-slot='timeline-axis'
        aria-hidden
        className={cn(
          "relative mt-2 h-5.5 border-t border-rule font-mono text-micro leading-none text-ink-muted",
          named && "ml-label-col",
        )}
      >
        {marks.map((mark) => (
          <span
            key={mark.at}
            data-part='time-tick'
            className='absolute top-2 -translate-x-1/2 whitespace-nowrap before:absolute before:-top-2 before:left-1/2 before:h-1 before:w-px before:bg-rule-strong'
            style={{ left: mark.left }}
          >
            {formatClockMinutes(mark.at)}
          </span>
        ))}
        {/* The window ends at the present, whatever the last round time was. */}
        <span
          data-part='now'
          className='absolute top-2 right-0 whitespace-nowrap text-ink-secondary before:absolute before:-top-2 before:right-0 before:h-1 before:w-px before:bg-rule-strong'
        >
          {formatClockMinutes(timeline.end)} now
        </span>
      </div>
    </div>
  );
}

/**
 * Every session across the last hour, one row each, marked by what it was doing.
 * It is built in the page from the snapshot, the events and the history: nothing
 * more is asked of the collector.
 *
 * A row is hatched where its session's status is not known, never drawn as
 * idle, and a status its source vouches for is drawn with nothing behind it.
 * Time a session was not running is left empty. The window ends at the present.
 *
 * With no rows the card says why, in one of four distinct ways: still waiting,
 * the hour could not be read, no source could be read, or nothing ran. That
 * nothing ran is said only of the time that was measured.
 */
export function TimelineCard({
  sessions,
  sources = [],
  events,
  history,
  now,
  asOf = now,
  staleAfterMs,
  className,
}: TimelineCardProps) {
  const timeline = useMemo(
    () =>
      sessions && history
        ? buildTimeline({
            sessions,
            events,
            history,
            now,
            asOf,
            eventsFull: events.length >= MAX_EVENTS,
            staleAfterMs,
          })
        : null,
    [sessions, events, history, now, asOf, staleAfterMs],
  );

  let body;
  if (sessions === null) {
    body = <Loading label='Reading the last hour' />;
  } else if (timeline === null) {
    body = (
      <div className='px-6 pb-6'>
        <Callout tone='error' title='The last hour could not be read'>
          <p>
            Agent Lookout did not answer when asked for its history. The page asks again every two
            seconds.
          </p>
        </Callout>
      </div>
    );
  } else if (timeline.rows.length > 0) {
    body = <TimelineChart timeline={timeline} />;
  } else if (sources.some((source) => source.state === "searching")) {
    body = <Loading label='Looking for sessions' />;
  } else if (!sources.some((source) => source.state === "ok")) {
    // Nothing was measured, which is not the same as nothing having run.
    body = (
      <div className='px-6 pb-6'>
        <Callout title='The last hour was not measured'>
          <p>No source could be read, so there is no status to draw. The Sessions card says why.</p>
        </Callout>
      </div>
    );
  } else {
    // Only the time that was measured can be called empty: right after Agent
    // Lookout starts, that is the minutes since it did, not the hour.
    const when = quietPhrase({ from: timeline.start, to: timeline.end }, timeline.unmeasured);
    body = (
      <EmptyState
        compact
        title={when ? `No sessions ${when}` : "Nothing was measured in the last hour"}
      >
        <p>When a session runs, its status over time is drawn here.</p>
      </EmptyState>
    );
  }

  return (
    <SectionCard
      title='Timeline'
      sub='last hour, one row per session'
      aside={timeline && timeline.rows.length > 0 ? <Legend timeline={timeline} /> : undefined}
      className={className}
    >
      {body}
    </SectionCard>
  );
}
