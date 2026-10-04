import { memo, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import type { Session, SessionEvent } from "@core/session";
import { EmptyState } from "@dashboard/components/ui/EmptyState";
import { SectionCard } from "@dashboard/components/ui/SectionCard";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/Tooltip";
import { MAX_EVENTS, type CollectorHistory } from "@dashboard/lib/collectorStore";
import { logEntries, logRows, logStart, watchGaps } from "@dashboard/lib/events";
import {
  formatClock,
  formatClockMinutes,
  formatDay,
  formatDuration,
  formatFullTime,
  startOfDay,
} from "@dashboard/lib/format";
import { eventPhrase, STOPPED_WAITING } from "@dashboard/lib/status";
import { cn } from "@dashboard/lib/utils";

interface EventsCardProps {
  /** Newest first. */
  events: readonly SessionEvent[];
  /** The sessions listed now. They say which waits are still open. */
  sessions?: readonly Pick<Session, "id" | "status">[];
  /**
   * The history the page holds: when Agent Lookout started watching, and, from
   * its points, where its polls broke off. Null when it could not be read.
   */
  history?:
    (Pick<CollectorHistory, "startedAt"> & Partial<Pick<CollectorHistory, "points">>) | null;
  now: number;
  className?: string;
}

/** The time column: the mono, in the muted ink, 64px wide so every mark sits on one line. */
const TIME = "w-16 shrink-0 self-center font-mono text-caption whitespace-nowrap";

/** How the thread runs past a row: on above it and below it, or not, and dotted where nothing watched. */
interface Thread {
  above: "line" | "dots" | null;
  below: "line" | "dots" | null;
}

/** One stretch of the thread, from the edge of a row to just short of its mark. */
function ThreadPart({ kind, side }: { kind: "line" | "dots"; side: "above" | "below" }) {
  return (
    <span
      aria-hidden
      data-part='thread'
      data-kind={kind}
      className={cn(
        "absolute left-1/2 -translate-x-1/2",
        side === "above" ? "top-0 bottom-1/2 mb-2.5" : "top-1/2 bottom-0 mt-2.5",
        kind === "line" ? "w-px bg-rule" : "w-0 border-l border-dotted border-ink-muted opacity-70",
      )}
    />
  );
}

/**
 * The mark's column. The marks sit on one thread, because events are a
 * sequence, and the thread stops just short of each mark.
 */
function MarkColumn({ thread, children }: { thread: Thread; children?: ReactNode }) {
  return (
    <span className='relative flex w-mark shrink-0 items-center justify-center'>
      {thread.above && <ThreadPart kind={thread.above} side='above' />}
      {children}
      {thread.below && <ThreadPart kind={thread.below} side='below' />}
    </span>
  );
}

/**
 * One row of the log: the time, a mark on the thread, then what happened. A row
 * is at least 38px tall; past what the card can show, the log scrolls. In a
 * narrow window, what happened goes on to a second line when it does not fit
 * beside the name.
 */
function Row({
  at,
  mark,
  thread,
  lit = false,
  children,
  ...data
}: {
  at: number;
  mark: ReactNode;
  thread: Thread;
  lit?: boolean;
  children: ReactNode;
  "data-slot": string;
}) {
  return (
    <li
      {...data}
      data-lit={lit || undefined}
      className={cn(
        "flex min-h-log-row shrink-0 items-stretch gap-3.5 px-6 text-body",
        lit ? "text-ink" : "text-ink-secondary",
      )}
    >
      <Tooltip content={formatFullTime(at)} mono align='start'>
        <time
          dateTime={new Date(at).toISOString()}
          className={cn(TIME, "rounded-bar", lit ? "text-ink-secondary" : "text-ink-muted")}
        >
          {formatClock(at)}
        </time>
      </Tooltip>
      <MarkColumn thread={thread}>{mark}</MarkColumn>
      <div className='flex min-w-0 flex-1 items-baseline gap-x-1 self-center py-2 max-mid:flex-wrap'>
        {children}
      </div>
    </li>
  );
}

/**
 * One event. The row is drawn again only when the event, its mark or the thread
 * beside it changes, not on every tick of the clock, so a long log costs nothing
 * while it sits there.
 */
const EventRow = memo(function EventRow({
  event,
  mark,
  open,
  waitedMs,
  above,
  below,
}: {
  event: SessionEvent;
  mark: MarkKind;
  open: boolean;
  waitedMs: number | null;
  above: Thread["above"];
  below: Thread["below"];
}) {
  const phrase = eventPhrase(event, waitedMs);
  return (
    <Row
      data-slot='event-row'
      at={event.at}
      lit={open}
      thread={{ above, below }}
      mark={<StatusMark kind={mark} labelled />}
    >
      <Truncated
        data-part='name'
        tooltip={`${event.sessionName} ${phrase}`}
        className='font-semibold text-ink'
      >
        {event.sessionName}
      </Truncated>
      <span data-part='phrase' className='max-w-full shrink-0'>
        {waitedMs !== null && phrase.startsWith(STOPPED_WAITING) ? (
          <>
            {STOPPED_WAITING}{" "}
            <span className='whitespace-nowrap tabular-nums'>{formatDuration(waitedMs)}</span>
          </>
        ) : (
          phrase
        )}
      </span>
    </Row>
  );
});

/**
 * The heading over the events of an earlier day. Every row shows its clock time,
 * so after a night of running the log still says when each thing happened, and
 * the time column keeps one width. The thread runs on past it.
 */
function DayHeading({ day, now, thread }: { day: number; now: number; thread: Thread }) {
  return (
    <li data-slot='event-day' className='flex shrink-0 items-stretch gap-3.5 px-6'>
      <span className={cn(TIME, "pt-3 pb-1 font-medium text-ink-muted")}>
        {formatDay(day, now)}
      </span>
      <MarkColumn thread={thread} />
    </li>
  );
}

/**
 * The height at which a log longer than its room shows only whole rows, or null
 * while every row fits.
 *
 * Beside the Sessions card the log has that card's height, and stacked under it
 * the stylesheet caps it; either way the room seldom ends on the edge of a row.
 * Cut there, the last row in view would be sliced through its words at the
 * card's rim, which reads as a fault and not as a list that goes on. So the
 * list ends at the foot of the last row that fits with the space under it that
 * the end of the log has, above the rim, and its scrollbar says the rest is
 * below.
 *
 * The room is read from the frame the list is laid in, or from the cap, and
 * never from the list itself, so setting its height does not change what is
 * measured. It is measured again whenever the frame changes size or the rows
 * change.
 */
function useWholeRows(
  frame: RefObject<HTMLDivElement | null>,
  list: RefObject<HTMLOListElement | null>,
  rowsKey: string,
): number | null {
  const [fit, setFit] = useState<number | null>(null);

  useLayoutEffect(() => {
    const box = frame.current;
    const ol = list.current;
    if (!box || !ol) return;
    const measure = () => {
      const style = getComputedStyle(ol);
      // Beside the Sessions card the list is laid over its frame; stacked, it
      // is in the flow under its cap. Read to the fraction of a pixel, since a
      // card's height seldom is a whole number.
      const room =
        style.position === "absolute"
          ? box.getBoundingClientRect().height
          : Number.parseFloat(style.maxHeight);
      let next: number | null = null;
      if (Number.isFinite(room) && ol.scrollHeight > room + 0.5) {
        // The last row in view keeps the space under it that the end of the
        // log has, so it never sits on the rim.
        const limit = room - Number.parseFloat(style.paddingBottom || "0");
        // Each row's foot, measured from the top of the list.
        const top = ol.getBoundingClientRect().top - ol.scrollTop;
        for (const row of ol.children) {
          const foot = row.getBoundingClientRect().bottom - top;
          if (foot > limit + 0.01) break;
          next = foot;
        }
      }
      setFit(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [frame, list, rowsKey]);

  return fit;
}

/** What a row of the log is, before the thread past it is known. */
type Item =
  | { kind: "day"; key: string; day: number }
  | {
      kind: "event";
      key: string;
      event: SessionEvent;
      mark: MarkKind;
      open: boolean;
      waitedMs: number | null;
    }
  | { kind: "resumed"; key: string; at: number; unmeasuredMs: number }
  | { kind: "started"; key: string; at: number };

/**
 * What changed, newest first, each with the mark of the status it moved to, on
 * one thread. A wait that is still open has the lit lamp and its row is lit, and
 * one that is over has the answered mark, so the only amber here is for what
 * needs the person now.
 *
 * Where the history the page holds has a break in the collector's polls, a row
 * says when watching resumed and how long was not measured, with the lookout
 * mark, and the thread turns dotted across the break.
 *
 * While the log holds everything since Agent Lookout started watching, it ends
 * with that moment, and the head says "since" it. Once it is full, the head
 * gives the oldest event held instead and claims nothing before it.
 *
 * Before anything has changed, the log is that one moment, with a quiet line
 * under it that says nothing has changed since. Only when the start is not known
 * either does it say there are no events yet.
 *
 * Beside the Sessions card it takes that card's height and scrolls inside it
 * once its rows are many. Stacked under it, it scrolls within a fixed height of
 * about twelve rows. Either way, at rest it shows whole rows only, ending a
 * little above the card's rim, and its thin scrollbar is what shows that it
 * goes on: nothing fades, so every row keeps its contrast.
 */
export function EventsCard({
  events,
  sessions = [],
  history = null,
  now,
  className,
}: EventsCardProps) {
  const today = startOfDay(now);
  // A log that holds as many events as it can may have let older ones go.
  const start = logStart(events, history, events.length >= MAX_EVENTS);
  // Breaks older than the start of the log would sit past what it vouches for.
  const gaps = watchGaps(history).filter((gap) => !start || gap.at >= start.at);

  // Today's events come first and need no heading. Each earlier day gets one.
  const items: Item[] = [];
  let day = today;
  const dayOf = (at: number) => {
    const eventDay = startOfDay(at);
    if (eventDay !== day) {
      day = eventDay;
      items.push({ kind: "day", key: `day-${day}`, day });
    }
  };
  for (const row of logRows(logEntries(events, sessions), gaps)) {
    if (row.kind === "event") {
      dayOf(row.entry.event.at);
      items.push({ kind: "event", key: row.entry.event.id, ...row.entry });
    } else {
      dayOf(row.gap.at);
      items.push({
        kind: "resumed",
        key: `resumed-${row.gap.at}`,
        at: row.gap.at,
        unmeasuredMs: row.gap.unmeasuredMs,
      });
    }
  }
  if (start?.started) {
    dayOf(start.at);
    items.push({ kind: "started", key: "started", at: start.at });
  }

  const scrolls = events.length > 0 || gaps.length > 0;
  const frame = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const fit = useWholeRows(frame, list, scrolls ? items.map((item) => item.key).join(" ") : "");

  // The thread runs between every two rows, and is dotted below a row that
  // says watching resumed: the stretch down to the row before it was not watched.
  const rows = items.map((item, index) => {
    const previous = items[index - 1];
    const above: Thread["above"] = !previous ? null : previous.kind === "resumed" ? "dots" : "line";
    const below: Thread["below"] =
      index === items.length - 1 ? null : item.kind === "resumed" ? "dots" : "line";
    const thread = { above, below };
    switch (item.kind) {
      case "day":
        return <DayHeading key={item.key} day={item.day} now={now} thread={thread} />;
      case "event":
        return (
          <EventRow
            key={item.key}
            event={item.event}
            mark={item.mark}
            open={item.open}
            waitedMs={item.waitedMs}
            above={above}
            below={below}
          />
        );
      case "resumed":
        return (
          <Row
            key={item.key}
            data-slot='event-resumed'
            at={item.at}
            thread={thread}
            mark={<StatusMark kind='lookout' labelled />}
          >
            <span>
              Watching resumed,{" "}
              <span className='tabular-nums'>{formatDuration(item.unmeasuredMs)}</span> not measured
            </span>
          </Row>
        );
      case "started":
        return (
          <Row
            key={item.key}
            data-slot='event-start'
            at={item.at}
            thread={thread}
            mark={<StatusMark kind='lookout' labelled />}
          >
            <span>Started watching</span>
          </Row>
        );
    }
  });

  let body: ReactNode;
  if (scrolls) {
    body = (
      <div ref={frame} className='relative min-h-65 flex-1 max-wide:min-h-0'>
        <ol
          ref={list}
          data-slot='event-list'
          data-whole-rows={fit !== null || undefined}
          aria-label='Event log, newest first'
          tabIndex={0}
          className={cn(
            // A scrollbar, when the log is long enough for one, is 4px inside
            // the card's right edge.
            "thin-scroll flex flex-col overflow-y-auto pt-0.5 pb-3.5 focus-visible:-outline-offset-2",
            "wide:absolute wide:inset-0 max-wide:max-h-120",
          )}
          style={fit !== null ? { bottom: "auto", height: fit } : undefined}
        >
          {rows}
        </ol>
      </div>
    );
  } else if (start?.started) {
    // Watching has begun and nothing has changed yet. The one row is that
    // moment, and the line under it lines up with its words.
    body = (
      <div className='pb-4'>
        <ol data-slot='event-list' aria-label='Event log, newest first' className='flex flex-col'>
          {rows}
        </ol>
        <p data-part='unchanged' className='flex gap-3.5 px-6 text-caption text-ink-muted'>
          <span aria-hidden className={cn(TIME, "invisible")}>
            {formatClock(start.at)}
          </span>
          <span aria-hidden className='w-mark shrink-0' />
          <span>Nothing has changed since.</span>
        </p>
      </div>
    );
  } else {
    body = (
      <EmptyState compact title='No events yet' className='my-auto'>
        <p>When a session starts, finishes or needs you, it is logged here.</p>
      </EmptyState>
    );
  }

  return (
    <SectionCard
      title='Events'
      aside={
        start ? (
          <span data-part='since'>
            since <span className='font-mono'>{formatClockMinutes(start.at)}</span>
          </span>
        ) : undefined
      }
      className={cn("flex flex-col", className)}
    >
      {body}
    </SectionCard>
  );
}
