import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";

import {
  machineInId,
  nameOnMachine,
  type Session,
  type SessionEvent,
} from "@core/sessions/session";
import { OnMachine } from "@dashboard/components/sessions/Machine";
import { EmptyState } from "@dashboard/components/ui/feedback/EmptyState";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { MAX_EVENTS, type CollectorHistory } from "@dashboard/lib/api/collectorStore";
import {
  logEntries,
  logRows,
  logStart,
  watchGaps,
  type LogEntry,
} from "@dashboard/lib/events/events";
import { countNew } from "@dashboard/lib/events/newSince";
import {
  clockAt,
  formatClock,
  formatDay,
  formatDuration,
  formatFullTime,
  startOfDay,
} from "@dashboard/lib/format";
import { eventPhrase, STOPPED_WAITING } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";

interface EventsCardProps {
  /** Newest first. */
  events: readonly SessionEvent[];
  /** The sessions listed now. They say which waits are still open. */
  sessions?: readonly Pick<Session, "id" | "status">[];
  /**
   * The history the page holds: when Agent Lookout started watching, or the
   * history was cleared, when it started again, and, from its points, where
   * its polls broke off. Null when it could not be read.
   */
  history?:
    | (Pick<CollectorHistory, "startedAt" | "since" | "restarts"> &
        Partial<Pick<CollectorHistory, "points">>)
    | null;
  now: number;
  /**
   * Events after this moment arrived while the page was out of sight. The log
   * draws a line under them and its head counts them. Null for no line.
   */
  newSince?: number | null;
  /** Told whether the line is in view, within the window and the log's own scrolling. */
  onNewLineInView?: (inView: boolean) => void;
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
  className,
  children,
  ...data
}: {
  at: number;
  mark: ReactNode;
  thread: Thread;
  lit?: boolean;
  /** In place of the card's inset, for a list that is not in a card. */
  className?: string;
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
        className,
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
  // A session on another machine says which, so two of one name are told apart.
  const machine = machineInId(event.sessionId);
  const who = nameOnMachine(event.sessionName, machine);
  return (
    <Row
      data-slot='event-row'
      at={event.at}
      lit={open}
      thread={{ above, below }}
      mark={<StatusMark kind={mark} labelled />}
    >
      <Truncated data-part='name' tooltip={`${who} ${phrase}`} className='font-semibold text-ink'>
        {event.sessionName}
      </Truncated>
      <OnMachine machine={machine} className='shrink-0 whitespace-nowrap' />
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

/** What happened, as the start of a line: "Stopped waiting after 1m 05s". */
function sentenceOf(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** The most rows a session's own events show before they scroll. */
const OWN_ROWS = 6;

/**
 * One session's own events, newest first, in the log's rows: the time, the mark
 * on the thread and what happened, with the same marks, so an open wait has the
 * lit lamp here as it has in the log. The name is left out, because what holds
 * the list names the session, and what happened starts the line. The events of
 * an earlier day are under its heading, as in the log. Past six events the list
 * scrolls, inside the height of six rows.
 */
export function OwnEvents({
  entries,
  now,
  className,
}: {
  /** Newest first, from `logEntries`. */
  entries: readonly LogEntry[];
  now: number;
  className?: string;
}) {
  // Today's events need no heading. Each earlier day gets one.
  const items: ({ kind: "day"; day: number } | { kind: "event"; entry: LogEntry })[] = [];
  let day = startOfDay(now);
  for (const entry of entries) {
    const eventDay = startOfDay(entry.event.at);
    if (eventDay !== day) {
      day = eventDay;
      items.push({ kind: "day", day });
    }
    items.push({ kind: "event", entry });
  }
  const scrolls = entries.length > OWN_ROWS;
  return (
    <ol
      data-slot='own-events'
      aria-label='Its events, newest first'
      tabIndex={scrolls ? 0 : undefined}
      className={cn(
        "thin-scroll flex flex-col",
        scrolls && "max-h-57 overflow-y-auto focus-visible:-outline-offset-2",
        className,
      )}
    >
      {items.map((item, index) => {
        // The thread runs on past a day heading, as in the log.
        const thread: Thread = {
          above: index === 0 ? null : "line",
          below: index === items.length - 1 ? null : "line",
        };
        if (item.kind === "day") {
          return (
            <DayHeading
              key={`day-${item.day}`}
              day={item.day}
              now={now}
              thread={thread}
              className='px-0'
            />
          );
        }
        const { entry } = item;
        const phrase = eventPhrase(entry.event, entry.waitedMs);
        return (
          <Row
            key={entry.event.id}
            data-slot='event-row'
            at={entry.event.at}
            lit={entry.open}
            thread={thread}
            mark={<StatusMark kind={entry.mark} labelled />}
            className='px-0'
          >
            <span data-part='phrase'>
              {entry.waitedMs !== null && phrase.startsWith(STOPPED_WAITING) ? (
                <>
                  {sentenceOf(STOPPED_WAITING)}{" "}
                  <span className='whitespace-nowrap tabular-nums'>
                    {formatDuration(entry.waitedMs)}
                  </span>
                </>
              ) : (
                sentenceOf(phrase)
              )}
            </span>
          </Row>
        );
      })}
    </ol>
  );
}

/**
 * The heading over the events of an earlier day. Every row shows its clock time,
 * so after a night of running the log still says when each thing happened, and
 * the time column keeps one width. The thread runs on past it.
 */
function DayHeading({
  day,
  now,
  thread,
  className,
}: {
  day: number;
  now: number;
  thread: Thread;
  /** In place of the card's inset, for a list that is not in a card. */
  className?: string;
}) {
  return (
    <li data-slot='event-day' className={cn("flex shrink-0 items-stretch gap-3.5 px-6", className)}>
      <span className={cn(TIME, "pt-3 pb-1 font-medium text-ink-muted")}>
        {formatDay(day, now)}
      </span>
      <MarkColumn thread={thread} />
    </li>
  );
}

/**
 * The line where the person left off: under what arrived while the page was out
 * of sight, over what they had seen. It says since when to the second, as every
 * row does, so a row from the same minute under it does not read as new, and
 * gives the day as well when that was before today. A rule runs on from its
 * words to the edge.
 *
 * It is quiet, because new is not the same as needing the person: a wait among
 * the new events keeps its own lamp, and nothing else here is warm. A screen
 * reader meets it in its place in the list.
 */
function NewLine({
  since,
  now,
  thread,
  ref,
}: {
  since: number;
  now: number;
  thread: Thread;
  ref: Ref<HTMLLIElement>;
}) {
  const clock = formatClock(since);
  const when = startOfDay(since) === startOfDay(now) ? clock : `${formatDay(since, now)} ${clock}`;
  return (
    <li ref={ref} data-slot='event-new' className='flex shrink-0 items-stretch gap-3.5 px-6'>
      <span aria-hidden className={TIME} />
      <MarkColumn thread={thread} />
      <span className='flex min-w-0 flex-1 items-center gap-3 py-2'>
        <span data-part='words' className='min-w-0 text-caption font-medium text-ink-muted'>
          New since{" "}
          <time dateTime={new Date(since).toISOString()} className='whitespace-nowrap tabular-nums'>
            {when}
          </time>
        </span>
        {/* In a narrow window the words fill the row, and the rule would be a stub. */}
        <span aria-hidden data-part='rule' className='h-px min-w-4 flex-1 bg-rule max-mid:hidden' />
      </span>
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

/**
 * Says whether the line where the person left off is in view: at least half of
 * it within the window, and within the log where the log scrolls. Out of view,
 * gone or not drawn, it says no.
 */
function useNewLineInView(
  lined: boolean,
  onInView: ((inView: boolean) => void) | undefined,
): RefObject<HTMLLIElement | null> {
  const line = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const element = line.current;
    if (!lined || !element || !onInView) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) onInView(entry.isIntersecting && entry.intersectionRatio >= 0.5);
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      onInView(false);
    };
  }, [lined, onInView]);
  return line;
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
  | { kind: "started"; key: string; at: number; cleared: boolean }
  | { kind: "new"; key: string; since: number };

/**
 * What changed, newest first, each with the mark of the status it moved to, on
 * one thread. A wait that is still open has the lit lamp and its row is lit, and
 * one that is over has the answered mark, so the only amber here is for what
 * needs the person now.
 *
 * Where the history the page holds has a break in the collector's polls, or
 * Agent Lookout started again, a row says when watching resumed and how long
 * was not measured, with the lookout mark, and the thread turns dotted across
 * the break.
 *
 * While the log holds everything since Agent Lookout started watching, it ends
 * with that moment, and the head says "since" it, with the day when that was
 * not today. Since the history was cleared, it ends with that moment instead,
 * "History cleared". Once it is full, the head gives the oldest event held
 * instead and claims nothing before it, and so it does when the history kept
 * reaches back only so far because what came before was let go.
 *
 * Before anything has changed, the log is that one moment, with a quiet line
 * under it that says nothing has changed since. Only when the start is not known
 * either does it say there are no events yet.
 *
 * With `newSince`, the events after it arrived while the page was out of sight:
 * a line sits under them, over the first row from before, and the head counts
 * them, "3 new". The card says when the line is in view, and the page decides
 * when it goes.
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
  newSince = null,
  onNewLineInView,
  className,
}: EventsCardProps) {
  const today = startOfDay(now);
  // A log that holds as many events as it can may have let older ones go.
  const start = logStart(events, history, events.length >= MAX_EVENTS);
  // Breaks older than the start of the log would sit past what it vouches for.
  const gaps = watchGaps(history).filter((gap) => !start || gap.at >= start.at);
  const newCount = countNew(events, newSince);

  // Today's events come first and need no heading. Each earlier day gets one.
  // The line where the person left off goes over the first row from before,
  // and over that row's day heading, since the heading belongs to what is under
  // it. With nothing from before, it is last.
  const items: Item[] = [];
  let lineAt = newCount > 0 ? newSince : null;
  let day = today;
  const dayOf = (at: number) => {
    if (lineAt !== null && at <= lineAt) {
      items.push({ kind: "new", key: "new", since: lineAt });
      lineAt = null;
    }
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
    items.push({ kind: "started", key: "started", at: start.at, cleared: start.cleared === true });
  }
  if (lineAt !== null) items.push({ kind: "new", key: "new", since: lineAt });
  const lined = newCount > 0;

  const scrolls = events.length > 0 || gaps.length > 0;
  const frame = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const fit = useWholeRows(frame, list, scrolls ? items.map((item) => item.key).join(" ") : "");
  const line = useNewLineInView(lined, onNewLineInView);

  // The thread runs between every two rows, and is dotted below a row that
  // says watching resumed: the stretch down to the row before it was not watched.
  // A day heading and the line where the person left off are not moments of
  // their own, so the thread runs past them as it was.
  let dotted = false;
  const rows = items.map((item, index) => {
    const above: Thread["above"] = index === 0 ? null : dotted ? "dots" : "line";
    dotted = item.kind === "resumed" || ((item.kind === "day" || item.kind === "new") && dotted);
    const below: Thread["below"] = index === items.length - 1 ? null : dotted ? "dots" : "line";
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
            <span>{item.cleared ? "History cleared" : "Started watching"}</span>
          </Row>
        );
      case "new":
        return <NewLine key={item.key} ref={line} since={item.since} now={now} thread={thread} />;
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
      count={
        lined ? (
          <>
            {newCount} new
            {/* So "3 new" and the aside's "since 17:00" are not heard as one phrase. */}
            <span className='sr-only'>, the log</span>
          </>
        ) : undefined
      }
      aside={
        start ? (
          <span data-part='since'>
            since <span className='tabular-nums'>{clockAt(start.at, now)}</span>
          </span>
        ) : undefined
      }
      className={cn("flex flex-col", className)}
    >
      {body}
    </SectionCard>
  );
}
