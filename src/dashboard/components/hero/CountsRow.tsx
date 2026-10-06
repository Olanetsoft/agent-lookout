import type { ReactNode } from "react";

import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import { StatusMark } from "@dashboard/components/ui/status/StatusMark";
import { formatDuration } from "@dashboard/lib/format";
import type { HistoryMetric } from "@dashboard/lib/charts/historyChart";
import type { CountState, Longest, SessionsSummary } from "@dashboard/lib/sessions/sessions";

/** "a day", or "36 hours" if the threshold is ever not a whole number of days. */
const STALE_AFTER =
  STALE_THRESHOLD_MS % 86_400_000 === 0
    ? STALE_THRESHOLD_MS === 86_400_000
      ? "a day"
      : `${STALE_THRESHOLD_MS / 86_400_000} days`
    : `${Math.round(STALE_THRESHOLD_MS / 3_600_000)} hours`;

/** Shown in place of a number that was not counted. */
export const NOT_KNOWN = "–";

/*
 * Every note is a short fragment in lower case, in every state: "longest 34m",
 * "7 open, 1 finished", "none running". Before there is a count, each says what
 * it counts, in the same voice.
 */
const NOTE = {
  working: "busy with a task",
  idle: "ready for a prompt",
  stale: `idle ${STALE_AFTER} or more`,
  sessions: "all sessions found",
  noneWorking: "none working",
  noneIdle: "none idle",
  noneRunning: "none running",
  timeNotReported: "time not reported",
  notCountedYet: "not counted yet",
  noSource: "no source to count",
} as const;

/**
 * "longest 34m 12s", for Working and Idle. The duration is kept on one line, so
 * where the note wraps it breaks between words and never inside a value.
 */
function longestNote(
  longest: Longest | null,
  count: number,
  asOf: number,
  none: string,
): ReactNode {
  if (longest) {
    return (
      <>
        longest{" "}
        <span data-part='note-value' className='whitespace-nowrap tabular-nums'>
          {formatDuration(asOf - longest.since)}
        </span>
      </>
    );
  }
  return count > 0 ? NOTE.timeNotReported : none;
}

/** "7 open, 1 finished", or "7 open" when nothing has finished, and the failures when there are any. */
function sessionsNote(summary: SessionsSummary): string {
  if (summary.total === 0) return NOTE.noneRunning;
  const parts = [`${summary.open} open`];
  if (summary.finished > 0) parts.push(`${summary.finished} finished`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.join(", ");
}

interface CountProps {
  kind: "working" | "idle" | "stale" | "sessions";
  label: string;
  mark?: ReactNode;
  /** The count, a dash when it could not be counted, or null while there is nothing yet. */
  value: number | typeof NOT_KNOWN | null;
  note: ReactNode;
  /** Opens the history behind the count. With it, the count is a button. */
  onOpen?: () => void;
}

/**
 * One count: the figure, then its label with its mark, and a note under the
 * label. A count with a history behind it opens it: its label is a real button
 * whose hit area is stretched over the whole count, and the focus ring is drawn
 * around the whole count, because the whole of it is what opens. Under the
 * pointer the whole count lights as one quiet rounded shape, as a row does, so
 * it reads as something that opens. The shape reaches 8px past the count into
 * the gaps around it, so nothing in the row moves.
 */
function Count({ kind, label, mark, value, note, onOpen }: CountProps) {
  return (
    <div
      data-slot='count'
      data-kind={kind}
      data-opens={onOpen ? "" : undefined}
      role='group'
      aria-label={label}
      className={
        onOpen
          ? "relative -m-2 flex min-w-0 cursor-pointer items-center gap-3 rounded-inner p-2 transition-colors duration-120 hover:bg-fill-hover has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-2 has-[button:focus-visible]:outline-focus"
          : "flex min-w-0 items-center gap-3"
      }
    >
      {value === null ? (
        <span
          data-part='placeholder'
          aria-hidden
          className='block h-7 w-5.5 shrink-0 rounded-bar bg-fill-selected'
        />
      ) : (
        <p
          data-part='value'
          className='min-w-5.5 shrink-0 text-stat font-medium tabular-nums'
          {...(value === NOT_KNOWN ? { role: "img", "aria-label": "Not known" } : {})}
        >
          {value}
        </p>
      )}
      <div className='min-w-0'>
        <p
          data-part='label'
          className='flex min-w-0 items-center gap-1.75 text-body leading-tight font-semibold text-ink'
        >
          {mark}
          {onOpen ? (
            <button
              type='button'
              aria-haspopup='dialog'
              aria-label={`${label}: open history`}
              onClick={onOpen}
              className='min-w-0 cursor-pointer truncate text-left outline-none after:absolute after:inset-0 after:rounded-inner'
            >
              {label}
            </button>
          ) : (
            <span className='truncate'>{label}</span>
          )}
        </p>
        {/* It wraps rather than being cut, so the failures it counts are never the part lost. */}
        <p data-part='note' className='mt-px text-caption text-pretty text-ink-secondary'>
          {note}
        </p>
      </div>
    </div>
  );
}

interface CountsRowProps {
  /** What could be counted, from `countState`. */
  counts: CountState;
  /** The moment the sessions describe: the last answer once answers stop. */
  asOf: number;
  /** Opens the history behind Working or Idle, once there is a count to have a history of. */
  onOpenHistory?: (metric: HistoryMetric) => void;
}

/**
 * The four counts at the foot of the hero: Working, Idle, Stale and Sessions,
 * each a figure, a label and a note, with no boxes. Needs you is the hero itself.
 *
 * Each session is counted once: Needs you, Working, Idle and Stale, with the
 * endings the Sessions note names, add up to the Sessions figure. A stale
 * session is idle, but it is counted under Stale and not under Idle.
 *
 * A count is shown only when it was counted. Before the first answer each holds
 * its place. When no source could be read, or one is still being looked for, it
 * shows a dash and says "Not known": nothing was found, which is not zero.
 */
export function CountsRow({ counts, asOf, onOpenHistory }: CountsRowProps) {
  const { summary, counted, searching } = counts;
  const value = (count: number | undefined) =>
    summary === null ? null : counted ? (count ?? 0) : NOT_KNOWN;
  const opens = (metric: HistoryMetric) =>
    onOpenHistory && counted ? () => onOpenHistory(metric) : undefined;

  return (
    <div
      data-slot='counts-row'
      role='group'
      aria-label='Summary'
      className='grid grid-cols-4 gap-4 border-t border-hairline pt-4.5 max-wide:grid-cols-2 max-wide:gap-y-3.5'
    >
      <Count
        kind='working'
        label='Working'
        mark={<StatusMark kind='working' />}
        value={value(summary?.working)}
        note={
          summary && counted
            ? longestNote(summary.longestWorking, summary.working, asOf, NOTE.noneWorking)
            : NOTE.working
        }
        onOpen={opens("working")}
      />
      <Count
        kind='idle'
        label='Idle'
        mark={<StatusMark kind='idle' />}
        value={value(summary?.idle)}
        note={
          summary && counted
            ? longestNote(summary.longestIdle, summary.idle, asOf, NOTE.noneIdle)
            : NOTE.idle
        }
        onOpen={opens("idle")}
      />
      <Count
        kind='stale'
        label='Stale'
        mark={<StatusMark kind='stale' />}
        value={value(summary?.stale)}
        note={NOTE.stale}
      />
      <Count
        kind='sessions'
        label='Sessions'
        value={value(summary?.total)}
        note={
          !summary
            ? NOTE.sessions
            : counted
              ? sessionsNote(summary)
              : searching
                ? NOTE.notCountedYet
                : NOTE.noSource
        }
      />
    </div>
  );
}
