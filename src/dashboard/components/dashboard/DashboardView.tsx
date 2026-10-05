import { StaleNotice, Unreachable } from "@dashboard/components/dashboard/ConnectionNotices";
import { EventsCard } from "@dashboard/components/events/EventsCard";
import { HeroPanel } from "@dashboard/components/hero/HeroPanel";
import { LastHourCard } from "@dashboard/components/last-hour/LastHourCard";
import { SessionsCard } from "@dashboard/components/sessions/SessionsCard";
import { TimelineCard } from "@dashboard/components/timeline/TimelineCard";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useFocusFollowsRow } from "@dashboard/hooks/dom/useFocusFollowsRow";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import type { HistoryMetric } from "@dashboard/lib/charts/historyChart";
import { countState, heroLight } from "@dashboard/lib/sessions/sessions";
import { cn } from "@dashboard/lib/utils";

interface DashboardViewProps {
  state: CollectorState;
  now: number;
  onRetry: () => void;
  /** Opens the history behind Needs you, Working or Idle. */
  onOpenHistory?: (metric: HistoryMetric) => void;
  /** Where the events log draws the line under what arrived while the page was out of sight. */
  newSince?: number | null;
  /** Told whether that line is in view. */
  onNewLineInView?: (inView: boolean) => void;
}

/** Every row that stands for one session: in the hero, in the Sessions table, or a card on its board. */
const SESSION_ROWS =
  '[data-slot="hero-session"], [data-slot="session-row"], [data-slot="board-card"]';

/*
 * Where each card sits. Wide, the hero and Last hour share the first row, the
 * Sessions and Events cards the second, and the timeline the third across both.
 * Below the `wide` breakpoint it is one column in that order, hero first.
 */
const PLACE = {
  hero: "col-start-1 row-start-1",
  lastHour: "col-start-2 row-start-1 max-wide:col-start-1 max-wide:row-start-2",
  sessions: "col-start-1 row-start-2 max-wide:row-start-3",
  events: "col-start-2 row-start-2 max-wide:col-start-1 max-wide:row-start-4",
  timeline: "col-span-2 col-start-1 row-start-3 max-wide:col-span-1 max-wide:row-start-5",
} as const;

/**
 * The Overview. What it shows depends on what is known:
 *
 *   no answer yet            the layout, holding its place, with a spinner
 *   never answered           a connection problem, in place of the dashboard
 *   answered                 the hero, Last hour, the sessions, the events and the timeline
 *   answered, then stopped   the same, under a notice that says how old it is
 *
 * The light behind the hero is laid in the hero's own grid cell, under it, so
 * it follows the hero wherever the layout puts it: the lamp while a session
 * needs the person, the rest light while none does, and neither before anything
 * is counted.
 *
 * Focus held in a session's row follows the session when its row is drawn
 * somewhere else: to another group of the table, or up into the hero when the
 * session starts waiting. On the board it follows the card to its new column.
 */
export function DashboardView({
  state,
  now,
  onRetry,
  onOpenHistory,
  newSince = null,
  onNewLineInView,
}: DashboardViewProps) {
  const { snapshot, phase } = state;
  const [grid, followFocus] = useFocusFollowsRow<HTMLDivElement>(SESSION_ROWS, "data-session");

  if (!snapshot && phase === "unreachable") {
    return <Unreachable problem={state.problem} kind={state.problemKind} onRetry={onRetry} />;
  }

  // Once answers stop, nobody is measuring. Time in status is counted up to the
  // last answer and no further, so no row claims minutes that were never seen.
  const asOf = phase === "stalled" && state.lastOkAt !== null ? state.lastOkAt : now;
  const sessions = snapshot?.sessions ?? null;
  const sources = snapshot?.sources ?? [];
  const light = heroLight(countState(sessions, sources));

  return (
    <div data-slot='dashboard' data-phase={phase} className='flex flex-col gap-4'>
      {snapshot && phase === "stalled" && state.lastOkAt !== null && (
        <StaleNotice lastOkAt={state.lastOkAt} now={now} onRetry={onRetry} />
      )}

      <div
        ref={grid}
        {...followFocus}
        data-slot='overview-grid'
        className='relative isolate grid grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)] gap-4 max-wide:grid-cols-1'
      >
        {light && (
          <div
            key={light}
            aria-hidden
            data-slot='hero-light'
            data-light={light}
            className={cn(light === "lamp" ? "lamp-light" : "rest-light", PLACE.hero)}
          />
        )}

        <HeroPanel
          sessions={sessions}
          sources={sources}
          events={state.events}
          history={state.history}
          now={now}
          asOf={asOf}
          onOpenHistory={onOpenHistory}
          className={cn("z-1", PLACE.hero)}
        />

        <LastHourCard
          sessions={sessions}
          sources={sources}
          events={state.events}
          history={state.history}
          now={now}
          asOf={asOf}
          className={cn("z-1", PLACE.lastHour)}
        />

        {snapshot ? (
          <>
            <SessionsCard
              sessions={snapshot.sessions}
              sources={snapshot.sources}
              now={asOf}
              className={cn("z-1", PLACE.sessions)}
            />
            <EventsCard
              events={state.events}
              sessions={snapshot.sessions}
              history={state.history}
              now={now}
              newSince={newSince}
              onNewLineInView={onNewLineInView}
              className={cn("z-1", PLACE.events)}
            />
          </>
        ) : (
          <>
            <SectionCard title='Sessions' className={cn("z-1", PLACE.sessions)}>
              <Loading label='Reading sessions' />
            </SectionCard>
            <SectionCard title='Events' className={cn("z-1", PLACE.events)}>
              <Loading label='Reading events' />
            </SectionCard>
          </>
        )}

        <TimelineCard
          sessions={sessions}
          sources={sources}
          events={state.events}
          history={state.history}
          now={now}
          asOf={asOf}
          className={cn("z-1", PLACE.timeline)}
        />
      </div>
    </div>
  );
}
