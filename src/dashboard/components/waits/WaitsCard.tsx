import { useId, useState } from "react";

import type { WaitDay, WaitPeriod, WaitsResponse, WaitTotal } from "@core/api";
import { machineInId, nameOnMachine, type Session } from "@core/sessions/session";
import { needsYou } from "@core/waits/answeredWaits";
import { OnMachine } from "@dashboard/components/sessions/Machine";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useWaitTotals } from "@dashboard/hooks/data/useWaitTotals";
import type { CollectorHistory } from "@dashboard/lib/api/collectorStore";
import { durationInWords, formatDuration } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";
import {
  coverageNote,
  dayInWords,
  dayLabel,
  noWaitsLine,
  openPart,
  waitsAt,
  waitsCount,
  wasMeasured,
} from "@dashboard/lib/sessions/waitTotals";

/** Shown in place of a number that was not measured. */
const NOT_KNOWN = "–";

/** The bars' scale never falls below a quarter of an hour, so a short day reads as short. */
const LEAST_SCALE_MS = 15 * 60_000;

/** How many of the longest waits are listed. The rest are counted under them. */
const LISTED = 5;

type Period = "today" | "sevenDays";

const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "sevenDays", label: "7 days" },
];

function percent(share: number): string {
  return `${Math.round(share * 100_000) / 1_000}%`;
}

/** The sentence that heads the card, in Last hour's words: who waited on whom today, how long and how many times. */
function Sum({ today }: { today: WaitTotal }) {
  return (
    <p data-part='sum' className='text-body text-ink-secondary'>
      {!wasMeasured(today) ? (
        "Nothing was measured today"
      ) : today.waits === 0 ? (
        "No session waited on you today"
      ) : (
        <>
          Sessions waited on you for{" "}
          <span className='font-semibold text-ink tabular-nums'>
            {formatDuration(today.waitedMs)}
          </span>{" "}
          today, in {waitsCount(today).toLowerCase()}
        </>
      )}
    </p>
  );
}

/**
 * A total at the figure size, with how many waits it held under it, or a dash
 * when nothing was measured: a term of the card's list and its two values, so
 * a screen reader takes the three together.
 */
function Figure({
  label,
  total,
  className,
}: {
  label: string;
  total: WaitTotal;
  className?: string;
}) {
  const measured = wasMeasured(total);
  return (
    <div data-part='figure' className={cn("min-w-0", className)}>
      <dt className='text-body font-medium text-ink-secondary'>{label}</dt>
      <dd data-part='value' className='mt-2 text-stat font-medium whitespace-nowrap tabular-nums'>
        <span className='sr-only'>
          {measured ? durationInWords(total.waitedMs) : "Not measured"}
        </span>
        <span aria-hidden>{measured ? formatDuration(total.waitedMs) : NOT_KNOWN}</span>
      </dd>
      <dd data-part='count' className='mt-2 text-caption text-ink-muted'>
        {waitsCount(total)}
      </dd>
    </div>
  );
}

/**
 * One day: its name, a bar of how long sessions waited on the person, the
 * total and how much of the day was measured. A wait still open, today's
 * alone, is the lamp's fill at the end of the bar, as in Last hour; the rest is
 * hollow in the idle colour. A day nobody measured is hatched, with a dash.
 *
 * In a narrow window it is two lines: the day and its total, then the bar and
 * how much was measured. The total and how much was measured keep their
 * widths there too, so every track is as long as the others and the bars stay
 * on one scale.
 */
function Day({ day, scale, now }: { day: WaitDay; scale: number; now: number }) {
  const measured = wasMeasured(day);
  const today = dayLabel(day, now) === "Today";
  const open = openPart(day, now);
  const answered = day.waitedMs - open;
  return (
    <li
      data-part='day'
      data-day={day.day}
      data-open={open > 0}
      className='flex items-center gap-4 text-body leading-5 max-mid:grid max-mid:grid-cols-[minmax(0,1fr)_auto] max-mid:gap-x-4 max-mid:gap-y-1.5'
    >
      <span
        data-part='label'
        className={cn(
          "w-waited-name shrink-0 max-mid:col-start-1 max-mid:row-start-1 max-mid:w-auto",
          today ? "font-semibold text-ink" : "font-medium text-ink-secondary",
        )}
      >
        {dayLabel(day, now)}
      </span>
      <span
        data-part='track'
        role='img'
        aria-label={dayInWords(day, now)}
        className='relative h-2.5 min-w-0 flex-1 before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-hairline max-mid:col-start-1 max-mid:row-start-2'
      >
        {!measured ? (
          <i
            data-part='unmeasured'
            className='unmeasured-hatch absolute inset-0 block rounded-bar'
          />
        ) : day.waitedMs > 0 ? (
          <span
            data-part='bar'
            className='absolute inset-y-0 left-0 flex min-w-0.5 gap-0.5'
            style={{ width: percent(Math.min(1, day.waitedMs / scale)) }}
          >
            {answered > 0 && (
              <i
                data-kind='answered'
                className='block h-full min-w-0.5 rounded-bar bar-answered'
                style={{ flexGrow: answered, flexBasis: 0 }}
              />
            )}
            {open > 0 && (
              <i
                data-kind='open'
                className='block h-full min-w-0.5 rounded-bar bar-open'
                style={{ flexGrow: open, flexBasis: 0 }}
              />
            )}
          </span>
        ) : null}
      </span>
      <span
        data-part='value'
        aria-hidden
        className='w-16 shrink-0 text-right whitespace-nowrap text-ink tabular-nums max-mid:col-start-2 max-mid:row-start-1 max-mid:justify-self-end'
      >
        {measured ? formatDuration(day.waitedMs) : NOT_KNOWN}
      </span>
      <span
        data-part='measured'
        aria-hidden
        className='w-30 shrink-0 text-right text-caption whitespace-nowrap text-ink-muted tabular-nums max-mid:col-start-2 max-mid:row-start-2'
      >
        {measured ? `measured ${formatDuration(day.measuredMs)}` : "not measured"}
      </span>
    </li>
  );
}

/** The seven days, oldest first, each with its bar on one scale. */
function ByDay({ period, now }: { period: WaitPeriod; now: number }) {
  const headingId = useId();
  const longest = Math.max(0, ...period.days.map((day) => day.waitedMs));
  const scale = Math.max(LEAST_SCALE_MS, longest);
  return (
    <section data-part='by-day' aria-labelledby={headingId} className='min-w-0'>
      <h3 id={headingId} className='text-caption font-semibold text-ink-secondary'>
        By day
      </h3>
      <ul className='mt-3 grid grid-cols-1 gap-2.5'>
        {period.days.map((day) => (
          <Day key={day.day} day={day} scale={scale} now={now} />
        ))}
      </ul>
    </section>
  );
}

/** The sessions that waited longest in the period chosen, each with how many times and how long. */
function Longest({
  waits,
  period,
  onPeriod,
}: {
  waits: WaitsResponse;
  period: Period;
  onPeriod: (period: Period) => void;
}) {
  const headingId = useId();
  const chosen = waits[period];
  const listed = chosen.sessions.slice(0, LISTED);
  const more = chosen.sessionCount - listed.length;
  return (
    <section data-part='longest' aria-labelledby={headingId} className='min-w-0'>
      {/* Narrow, the switch takes a line of its own under the heading. */}
      <div className='flex items-center justify-between gap-4 max-mid:flex-col max-mid:items-start max-mid:gap-2.5'>
        <h3 id={headingId} className='text-caption font-semibold text-ink-secondary'>
          Longest waits
        </h3>
        <SegmentedControl
          label='Longest waits over'
          value={period}
          onValueChange={onPeriod}
          options={PERIODS}
          className='-my-2.5 max-mid:my-0'
        />
      </div>
      {listed.length > 0 ? (
        <>
          <ul className='mt-1.5'>
            {listed.map((session) => (
              <li
                key={session.sessionId}
                data-part='session'
                data-open={session.open}
                className='flex items-start justify-between gap-4 border-b border-hairline py-2.5 last:border-b-0'
              >
                <div className='min-w-0 flex-1'>
                  {/* A session on another machine says which, so two of one name are told apart. */}
                  <Truncated
                    data-part='name'
                    tooltip={nameOnMachine(session.name, machineInId(session.sessionId))}
                    className='block text-body font-semibold text-ink'
                  >
                    {session.name}
                    <OnMachine
                      machine={machineInId(session.sessionId)}
                      className='text-ink-secondary'
                    />
                  </Truncated>
                  <p data-part='times' className='mt-0.5 text-caption text-ink-secondary'>
                    {session.waits} {session.waits === 1 ? "wait" : "waits"}
                    {session.open && ", waiting now"}
                  </p>
                </div>
                <p
                  data-part='value'
                  className='shrink-0 text-body font-medium whitespace-nowrap text-ink tabular-nums'
                >
                  <span className='sr-only'>{durationInWords(session.waitedMs)}</span>
                  <span aria-hidden>{formatDuration(session.waitedMs)}</span>
                </p>
              </li>
            ))}
          </ul>
          {more > 0 && (
            <p data-part='more' className='mt-1 text-caption text-ink-muted'>
              and {more} more
            </p>
          )}
        </>
      ) : (
        <p data-part='none' className='mt-4 text-body text-ink-secondary'>
          {noWaitsLine(chosen, period)}
        </p>
      )}
    </section>
  );
}

/** What the card says once the app has answered. */
function WaitsBody({ waits }: { waits: WaitsResponse }) {
  const [period, setPeriod] = useState<Period>("today");
  return (
    <div data-part='waits' className='px-6 pb-5.5'>
      <Sum today={waits.today} />
      {/* Narrow, the two figures stand one under the other, with no rule between. */}
      <dl className='mt-4 flex items-start gap-6 max-mid:flex-col max-mid:gap-4'>
        <Figure label='Today' total={waits.today} />
        <Figure
          label='Last 7 days'
          total={waits.sevenDays}
          className='border-l border-rule pl-6 max-mid:border-l-0 max-mid:pl-0'
        />
      </dl>
      <p
        data-part='coverage'
        className='mt-4 max-w-3xl text-caption text-pretty text-ink-secondary'
      >
        {coverageNote(waits)}
      </p>
      <div className='mt-6 grid grid-cols-2 gap-x-12 gap-y-7 max-wide:grid-cols-1'>
        <ByDay period={waits.sevenDays} now={waits.at} />
        <Longest waits={waits} period={period} onPeriod={setPeriod} />
      </div>
    </div>
  );
}

interface WaitsCardProps {
  /** The history the page holds. A restart or a clearing it shows has the totals read again at once. */
  history: CollectorHistory | null;
  /**
   * The sessions the page holds. A wait that opens or ends among them, an
   * answered one included, has the totals read again at once.
   */
  sessions: readonly Pick<Session, "id" | "status" | "answered">[];
  /** The moment counted to: now, or the last answer once answers stop. Open waits grow to it between answers. */
  asOf: number;
  className?: string;
}

/**
 * Waits: how long sessions waited on the person today and over the last seven
 * days, day by day, and which sessions waited longest, from the whole of the
 * history Agent Lookout keeps. It counts only the time Agent Lookout was
 * running, and says how much of each period that was.
 *
 * It is a review, not the present, so it sits after the timeline. Nothing in
 * it is warm but the part of today's bar that is a wait still open.
 */
export function WaitsCard({ history, sessions, asOf, className }: WaitsCardProps) {
  const waiting = sessions.filter(needsYou).map((session) => session.id);
  const reading = useWaitTotals(history, waiting);
  return (
    <SectionCard title='Waits' className={className}>
      {reading.waits ? (
        <WaitsBody waits={waitsAt(reading.waits, asOf)} />
      ) : reading.status === "failed" ? (
        <div className='px-6 pb-5'>
          <Callout tone='error' title='How long sessions waited could not be read'>
            <p>
              Agent Lookout did not answer when asked for it. The page asks again every 30 seconds.
            </p>
          </Callout>
        </div>
      ) : (
        <Loading label='Reading waits' />
      )}
    </SectionCard>
  );
}
