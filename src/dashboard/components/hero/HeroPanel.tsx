import { useId, useMemo, type ReactNode } from "react";

import type { Session, SessionEvent, SourceHealth } from "@core/sessions/session";
import { waitingLabel } from "@core/sessions/waiting";
import { CountsRow, NOT_KNOWN } from "@dashboard/components/hero/CountsRow";
import { WaitedOnYou } from "@dashboard/components/hero/WaitedOnYou";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { DurationFigure } from "@dashboard/components/ui/status/DurationFigure";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { StatusMark } from "@dashboard/components/ui/status/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useJump } from "@dashboard/hooks/data/useJump";
import { MAX_EVENTS, type CollectorHistory } from "@dashboard/lib/api/collectorStore";
import {
  durationInWords,
  durationParts,
  formatClockMinutes,
  formatDuration,
} from "@dashboard/lib/format";
import type { HistoryMetric } from "@dashboard/lib/charts/historyChart";
import {
  countState,
  heroLight,
  waitingSessions,
  type CountState,
} from "@dashboard/lib/sessions/sessions";
import { agentLabel, showsAgents } from "@dashboard/lib/sources/sources";
import { SURFACE_LABEL, waitingDetail } from "@dashboard/lib/sessions/status";
import { cn } from "@dashboard/lib/utils";
import {
  unmeasuredNote,
  waitedOnYou,
  type LastWait,
  type WaitedOnYou as Waits,
} from "@dashboard/lib/sessions/waits";

interface HeroPanelProps {
  /** Null until the first answer arrives. The hero then holds its place. */
  sessions: readonly Session[] | null;
  /** The sources behind those sessions. They decide whether a zero is a real zero. */
  sources?: readonly SourceHealth[];
  /** Every event the page holds. */
  events?: readonly SessionEvent[];
  /** The hour of history the page holds, or null when it could not be read. */
  history?: CollectorHistory | null;
  /** The present. */
  now: number;
  /**
   * The moment the sessions describe: the present while answers arrive, and the
   * last answer once they stop, so a timer never counts past what was seen.
   */
  asOf?: number;
  /** Opens the history behind Needs you, Working or Idle. */
  onOpenHistory?: (metric: HistoryMetric) => void;
  className?: string;
}

/**
 * The words of the hero's title as a button that opens the history of how many
 * sessions needed the person. Its name is the words on it, so the hero is still
 * called by its title; what it opens is said as its description. Under the
 * pointer it lights as a quiet rounded shape, as a row does, so it reads as
 * something that opens; the words stay where they are.
 */
function OpensHistory({ onOpen, children }: { onOpen: () => void; children: string }) {
  const described = useId();
  return (
    <>
      <button
        type='button'
        aria-haspopup='dialog'
        aria-describedby={described}
        onClick={onOpen}
        className='-mx-1.5 -my-0.5 cursor-pointer rounded-row px-1.5 py-0.5 text-left transition-colors duration-120 hover:bg-fill-hover'
      >
        {children}
      </button>
      <span id={described} hidden>
        Opens the history of how many sessions needed you
      </span>
    </>
  );
}

/** The hero's title: the lamp, the words, and how many are waiting. */
function Title({ id, count, onOpen }: { id: string; count: number; onOpen?: () => void }) {
  return (
    <h2
      id={id}
      data-part='title'
      className='flex items-center gap-2.5 text-row leading-tight font-semibold text-ink'
    >
      <StatusMark kind='needs-you' breathing className='size-4.5' />
      {onOpen ? <OpensHistory onOpen={onOpen}>Needs you</OpensHistory> : <span>Needs you</span>}
      <span data-part='count' className='font-medium text-ink-secondary tabular-nums'>
        {count}
      </span>
    </h2>
  );
}

/**
 * Why it waits, in plain words, in the lamp's label colour. The vendor's own
 * wording, when it says more, is one hover or one Tab away.
 */
function Reason({ session, className }: { session: Session; className?: string }) {
  const reason = waitingLabel(session);
  const detail = waitingDetail(session);
  if (!detail) {
    return (
      <span data-part='reason-text' className={cn("text-label-needs-you", className)}>
        {reason}
      </span>
    );
  }
  return (
    <Tooltip content={`${reason}: ${detail}`}>
      <span
        data-part='reason-text'
        tabIndex={0}
        className={cn("rounded-bar text-label-needs-you", className)}
      >
        {reason}
        <span className='sr-only'>: {detail}</span>
      </span>
    </Tooltip>
  );
}

/**
 * Where it runs: the folder, whose whole path is one hover or one Tab away, the
 * app, and the tool when more than one is found.
 *
 * It is positioned, so a cut line also clips the words only a screen reader
 * meets, which would otherwise sit past its end and widen the page.
 */
function Place({
  session,
  agent,
  className,
}: {
  session: Session;
  agent?: string;
  className?: string;
}) {
  const surface = SURFACE_LABEL[session.surface];
  return (
    <span
      data-part='place'
      className={cn("relative min-w-0 text-body text-ink-secondary", className)}
    >
      {session.project ? (
        <>
          <Tooltip content={session.cwd} mono>
            <span
              data-part='project'
              tabIndex={session.cwd ? 0 : undefined}
              className='rounded-bar font-medium text-ink'
            >
              {session.project}
            </span>
          </Tooltip>{" "}
          in <span data-part='app'>{surface}</span>
        </>
      ) : (
        <>
          In <span data-part='app'>{surface}</span>
        </>
      )}
      {agent !== undefined && (
        <>
          {/* Read as "in VS Code, Codex". On screen the two are set apart by a dot. */}
          <span className='sr-only'>, </span>
          <span aria-hidden className='mx-1.5'>
            ·
          </span>
          <span data-part='agent'>{agent}</span>
        </>
      )}
    </span>
  );
}

/** "Process ended", for a waiting session whose process has gone. */
function Ended({ session }: { session: Session }) {
  return session.alive === false ? <Badge tone='outline'>Process ended</Badge> : null;
}

/** How long a session has waited, as of `asOf`, or null when its source did not say. */
function waitedFor(session: Session, asOf: number): number | null {
  return session.statusSince === null ? null : Math.max(0, asOf - session.statusSince);
}

/**
 * The longest wait, in full: its name large, why it waits and where it runs on
 * the left; the wait at the hero's largest size, when it began, and the Jump on
 * the right. Its Jump is the lamp's fill, the one solid button on the screen,
 * because the session needs the person now.
 */
function Lead({ session, asOf, agent }: { session: Session; asOf: number; agent?: string }) {
  const waited = waitedFor(session, asOf);
  const jump = useJump(session.id);
  return (
    <div
      data-slot='hero-session'
      data-session={session.id}
      className='flex items-end justify-between gap-6 max-mid:flex-col max-mid:items-stretch max-mid:gap-4'
    >
      <div className='min-w-0 flex-1'>
        {/* What Jump came to goes under the name when the line cannot hold both. */}
        <div className='mt-3.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
          <div className='flex max-w-full min-w-0 items-center gap-3'>
            <Truncated data-part='name' className='text-name font-semibold'>
              {session.name}
            </Truncated>
            <Ended session={session} />
          </div>
          <JumpNote session={session} jump={jump} />
        </div>
        <p data-part='reason' className='mt-2 flex min-w-0 text-lead font-medium'>
          <Reason session={session} className='truncate' />
        </p>
        {/* A folder or an agent named by a status file can be one long word, so it may break anywhere. */}
        <Place session={session} agent={agent} className='mt-1.5 block wrap-anywhere' />
      </div>

      <div className='flex shrink-0 items-end gap-6 max-mid:justify-between'>
        <div data-part='wait' className='text-right max-mid:text-left'>
          <p className='text-wait font-medium whitespace-nowrap text-label-needs-you'>
            {waited !== null ? (
              <>
                <span className='sr-only'>Waiting {durationInWords(waited)}</span>
                <span aria-hidden>
                  <DurationFigure parts={durationParts(waited)} />
                </span>
              </>
            ) : (
              <>
                <span className='sr-only'>How long it has waited was not reported</span>
                <span aria-hidden>{NOT_KNOWN}</span>
              </>
            )}
          </p>
          <p data-part='since' className='mt-2 text-caption text-ink-secondary'>
            {session.statusSince !== null ? (
              <>
                waiting since{" "}
                <span className='font-semibold text-ink tabular-nums'>
                  {formatClockMinutes(session.statusSince)}
                </span>
              </>
            ) : (
              "time not reported"
            )}
          </p>
        </div>
        <Jump session={session} jump={jump} variant='needs-you' size='hero' />
      </div>
    </div>
  );
}

/** A wait after the longest, as one compact row with the same parts. */
function Other({ session, asOf, agent }: { session: Session; asOf: number; agent?: string }) {
  const waited = waitedFor(session, asOf);
  const jump = useJump(session.id);
  return (
    <li
      data-slot='hero-session'
      data-session={session.id}
      className='flex items-center gap-5 border-t border-hairline py-3 max-mid:flex-wrap max-mid:gap-x-4 max-mid:gap-y-2'
    >
      <div className='min-w-0 flex-1 max-mid:basis-full'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <div className='flex max-w-full min-w-0 items-center gap-2'>
            <Truncated data-part='name' className='text-lead font-semibold text-ink'>
              {session.name}
            </Truncated>
            <Ended session={session} />
          </div>
          <JumpNote session={session} jump={jump} />
        </div>
        <p
          data-part='reason'
          className='mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 text-body'
        >
          <Reason session={session} className='font-medium' />
          <Place session={session} agent={agent} className='truncate' />
        </p>
      </div>
      <p
        data-part='wait'
        className='shrink-0 text-right text-lead font-semibold whitespace-nowrap text-label-needs-you tabular-nums max-mid:mr-auto max-mid:text-left'
      >
        {waited !== null ? (
          <>
            <span className='sr-only'>Waiting {durationInWords(waited)}</span>
            <span aria-hidden>{formatDuration(waited)}</span>
          </>
        ) : (
          <>
            <span className='sr-only'>How long it has waited was not reported</span>
            <span aria-hidden>{NOT_KNOWN}</span>
          </>
        )}
      </p>
      <Jump session={session} jump={jump} variant='needs-you' size='sm' />
    </li>
  );
}

/** "demo-project, answered at 09:40". */
function lastWaitNote(last: LastWait): ReactNode {
  return (
    <>
      <span className='font-semibold text-ink'>{last.name}</span>,{" "}
      {last.how === "ended" ? "ended at" : "answered at"}{" "}
      <span className='tabular-nums'>{formatClockMinutes(last.at)}</span>
    </>
  );
}

/**
 * Nothing needs the person. It says so at the hero's size, with the lamp out,
 * and on the right gives the last wait that is over, so the panel stays worth
 * looking at. With none in the period, it says that instead, once: "None since
 * 13:05", and how much of that time nobody measured.
 */
function Quiet({ id, waits, onOpen }: { id: string; waits: Waits | null; onOpen?: () => void }) {
  const last = waits?.lastWait ?? null;
  const since = waits
    ? waits.period.today
      ? "today"
      : `since ${formatClockMinutes(waits.period.from)}`
    : null;
  // With no wait in the period the bars are left out, so the time nobody
  // measured, which would have been said under them, is said here.
  const unmeasured = waits && waits.sessions.length === 0 ? unmeasuredNote(waits) : null;
  return (
    <div className='flex items-end justify-between gap-6 max-mid:flex-col max-mid:items-start max-mid:gap-4'>
      <div className='min-w-0'>
        <h2
          id={id}
          data-part='title'
          className='mt-1 flex items-center gap-3.5 text-name font-semibold text-ink'
        >
          <StatusMark kind='needs-you' unlit className='size-6.5' />
          {onOpen ? (
            <OpensHistory onOpen={onOpen}>Nothing needs you</OpensHistory>
          ) : (
            <span>Nothing needs you</span>
          )}
        </h2>
        <p className='mt-2.5 max-w-md text-row text-ink-secondary'>
          When a session stops to ask for something, it will show here.
        </p>
      </div>

      <div data-part='last-wait' className='shrink-0 text-right max-mid:text-left'>
        <p className='mb-2.5 text-caption font-semibold text-ink-secondary'>Last wait</p>
        {last ? (
          <>
            <p className='text-wait font-normal whitespace-nowrap text-ink'>
              <span className='sr-only'>The last wait lasted {durationInWords(last.ms)}</span>
              <span aria-hidden>
                <DurationFigure parts={durationParts(last.ms)} />
              </span>
            </p>
            <p data-part='last-note' className='mt-2 text-caption text-ink-secondary'>
              {lastWaitNote(last)}
            </p>
          </>
        ) : (
          <>
            <p data-part='last-note' className='text-body text-ink-secondary'>
              {since ? `None ${since}` : "Not known"}
            </p>
            {unmeasured && (
              <p data-part='last-gaps' className='mt-1 text-caption text-ink-secondary'>
                {unmeasured}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Before anything is counted: the hero's title with the lamp out, and what is still to come. */
function Uncounted({ id, counts }: { id: string; counts: CountState }) {
  return (
    <div>
      <h2
        id={id}
        data-part='title'
        className='flex items-center gap-2.5 text-row leading-tight font-semibold text-ink'
      >
        <StatusMark kind='needs-you' unlit className='size-4.5' />
        Needs you
      </h2>
      {counts.summary === null ? (
        <Loading label='Reading sessions' className='justify-start px-0 pt-5 pb-1' />
      ) : (
        <>
          <p
            data-part='value'
            role='img'
            aria-label='Not known'
            className='mt-3.5 text-name font-semibold text-ink'
          >
            {NOT_KNOWN}
          </p>
          <p data-part='uncounted' className='mt-2 max-w-md text-row text-ink-secondary'>
            {counts.searching
              ? "Agent Lookout is still looking for agents on this computer. The count follows as soon as one is read."
              : "No agent tool could be read, so nothing could be counted. The Sessions card says why."}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The hero: the sessions that need the person, lifted out of the Sessions table
 * onto the highest glass at the top left. It is the first thing to look at in
 * every state, and it never uses the muted ink, because the lamp's light can sit
 * behind it.
 *
 *   loading          the title with the lamp out and a spinner; no light, no zero
 *   not counted      a dash and why: still looking, or no source could be read
 *   quiet            "Nothing needs you", and the last wait that is over
 *   one waiting      its name large, why and where, a timer and the Jump
 *   several waiting  the longest in full, then each of the others, each with
 *                    its reason, timer and Jump
 *
 * Under the top sit the bars of how long sessions waited, when any did, and
 * the hero ends with the counts. Once answers stop, every timer stops at the
 * last one.
 */
export function HeroPanel({
  sessions,
  sources = [],
  events = [],
  history = null,
  now,
  asOf = now,
  onOpenHistory,
  className,
}: HeroPanelProps) {
  const titleId = useId();
  const counts = countState(sessions, sources);
  const light = heroLight(counts);
  const waiting = useMemo(() => (sessions ? waitingSessions(sessions) : []), [sessions]);
  const agents = showsAgents(sources, sessions ?? []);
  const agentOf = (session: Session) => (agents ? agentLabel(session, sources) : undefined);

  const waits = useMemo(
    () =>
      sessions && light
        ? waitedOnYou({
            sessions,
            events,
            history,
            now,
            asOf,
            eventsFull: events.length >= MAX_EVENTS,
          })
        : null,
    [sessions, light, events, history, now, asOf],
  );

  const openHistory = onOpenHistory && history && light ? onOpenHistory : undefined;
  const [first, ...rest] = waiting;

  let top: ReactNode;
  let state: string;
  if (!light) {
    state = counts.summary === null ? "loading" : "uncounted";
    top = <Uncounted id={titleId} counts={counts} />;
  } else if (!first) {
    state = "quiet";
    top = (
      <Quiet id={titleId} waits={waits} onOpen={openHistory && (() => openHistory("needsYou"))} />
    );
  } else {
    state = rest.length > 0 ? "several" : "one";
    top = (
      <div>
        <Title
          id={titleId}
          count={waiting.length}
          onOpen={openHistory && (() => openHistory("needsYou"))}
        />
        {/* Keyed, so what a press of one session's Jump came to is never said of another. */}
        <Lead key={first.id} session={first} asOf={asOf} agent={agentOf(first)} />
        {rest.length > 0 && (
          <ul data-part='others' aria-label='Also waiting, longest first' className='mt-5'>
            {rest.map((session) => (
              <Other key={session.id} session={session} asOf={asOf} agent={agentOf(session)} />
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <section
      data-slot='hero'
      data-state={state}
      data-light={light ?? undefined}
      aria-labelledby={titleId}
      className={cn(
        "glass-raised flex min-w-0 flex-col justify-between gap-5 px-7 pt-6 pb-5.5 max-mid:px-5",
        className,
      )}
    >
      {top}
      {/* With no session waiting in the period there are no bars to draw, and
          the quiet top already says since when, so the bars are left out. */}
      {light && (waits === null || waits.sessions.length > 0) && <WaitedOnYou waits={waits} />}
      <CountsRow counts={counts} asOf={asOf} onOpenHistory={openHistory} />
    </section>
  );
}
