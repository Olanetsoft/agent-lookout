import { useId, useMemo, type ReactNode } from "react";

import {
  isRemoteSource,
  machineInId,
  type Session,
  type SessionEvent,
  type SourceHealth,
} from "@core/sessions/session";
import { waitingLabel } from "@core/notices/waiting";
import { CountsRow, NOT_KNOWN } from "@dashboard/components/hero/CountsRow";
import { WaitedOnYou } from "@dashboard/components/hero/WaitedOnYou";
import { AnswerAsk } from "@dashboard/components/answer/AnswerAsk";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { Branch } from "@dashboard/components/sessions/Branch";
import { Machine } from "@dashboard/components/sessions/Machine";
import { Badge } from "@dashboard/components/ui/status/Badge";
import { DurationFigure } from "@dashboard/components/ui/status/DurationFigure";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { StatusMark } from "@dashboard/components/ui/status/StatusMark";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useJump } from "@dashboard/hooks/actions/useJump";
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
import {
  agentLabel,
  showsAgents,
  sourceNames,
  unseenMachines,
  unseenSentence,
} from "@dashboard/lib/sources/sources";
import { surfaceLabel, waitingDetail } from "@dashboard/lib/sessions/status";
import { openFromLink, sessionHref } from "@dashboard/lib/shell/sessionDetails";
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
  /** Told once a permission prompt was answered from here, so the page reads the sessions again. */
  onAnswered?: () => void;
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
      tabIndex={-1}
      className='flex items-center gap-2.5 text-row leading-tight font-semibold text-ink outline-none'
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
 * What the session is asking, when its agent says: "Run: npm test", "Edit:
 * src/app.ts", or the question it put. A line of its own under the reason, in
 * the hero's quieter ink and never warm, cut at two lines, and whole one hover
 * or one Tab away while it is cut. A command or a path can be one long word, so
 * it may break anywhere.
 */
function Asking({ session, className }: { session: Session; className?: string }) {
  const asking = session.waitingText?.trim();
  // A held request shows the whole of what it asks, in place of the line.
  if (!asking || session.ask) return null;
  return (
    <Truncated
      data-part='asking'
      lines={2}
      className={cn("min-w-0 text-body wrap-anywhere text-ink-secondary", className)}
    >
      {asking}
    </Truncated>
  );
}

/**
 * Where it runs: the folder, whose whole path is one hover or one Tab away, the
 * branch or commit it has checked out when it is in a git repository, the app,
 * and the tool when more than one is found: "storefront on checkout-flow in
 * VS Code · Claude Code". An app that is not known is left out, "storefront on
 * checkout-flow · my-agent", and with nothing at all to say there is no line.
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
  const app = surfaceLabel(session.surface);
  const where = Boolean(session.project) || app !== null;
  if (!where && agent === undefined) return null;
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
          </Tooltip>
          {session.git && (
            <>
              {" "}
              <span data-part='git'>
                {/* Cut at the line's width, a branch keeps the line's baseline. */}
                <Branch
                  git={session.git}
                  inSentence
                  className='inline-block max-w-full align-top font-medium text-ink'
                />
              </span>
            </>
          )}
          {app !== null && (
            <>
              {" "}
              in <span data-part='app'>{app}</span>
            </>
          )}
        </>
      ) : (
        app !== null && (
          <>
            In <span data-part='app'>{app}</span>
          </>
        )
      )}
      {agent !== undefined && (
        <>
          {where && (
            <>
              {/* Read as "in VS Code, Codex". On screen the two are set apart by a dot. */}
              <span className='sr-only'>, </span>
              <span aria-hidden className='mx-1.5'>
                ·
              </span>
            </>
          )}
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
 * A waiting session's name, as a link to its details, named "checkout-flow,
 * details", as a row's name is. The hero is no row, so its name is the one
 * thing in it that opens them, and a click anywhere else opens nothing. Under
 * the pointer it lights as a quiet rounded shape, as the title does, and its
 * words keep their place, size and colour. Its ring is the one every control
 * has, round that shape.
 */
function Name({ session, className }: { session: Session; className: string }) {
  return (
    <Truncated
      data-part='name'
      href={sessionHref(session.id)}
      onClick={(event) => openFromLink(event, session.id)}
      aria-label={`${session.name}, details`}
      aria-haspopup='dialog'
      className={cn(
        "-mx-1.5 -my-0.5 rounded-row px-1.5 py-0.5 transition-colors duration-120 hover:bg-fill-hover",
        className,
      )}
    >
      {session.name}
    </Truncated>
  );
}

/**
 * The longest wait, in full: its name large, why it waits, what it is asking
 * and where it runs on the left; the wait at the hero's largest size, when it
 * began, and the Jump on the right. Its Jump is the lamp's fill, the one solid
 * button on the screen, because the session needs the person now.
 */
function Lead({
  session,
  asOf,
  agent,
  onAnswered,
  titleId,
}: {
  session: Session;
  asOf: number;
  agent?: string;
  onAnswered?: () => void;
  /** The hero's title, which takes focus when this row leaves with focus in its answer. */
  titleId?: string;
}) {
  const waited = waitedFor(session, asOf);
  const jump = useJump(session);
  return (
    <div
      data-slot='hero-session'
      data-session={session.id}
      className='mt-3.5 flex items-end justify-between gap-6 max-mid:flex-col max-mid:items-stretch max-mid:gap-4'
    >
      <div className='min-w-0 flex-1'>
        {/* The machine, and what Jump came to, go under the name when the line cannot hold both. */}
        <div className='flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'>
          <div className='flex max-w-full min-w-0 items-center gap-3'>
            <Name session={session} className='text-name font-semibold' />
            <Ended session={session} />
          </div>
          <Machine session={session} />
          <JumpNote session={session} jump={jump} />
        </div>
        <p data-part='reason' className='mt-2 flex min-w-0 text-lead font-medium'>
          <Reason session={session} className='truncate' />
        </p>
        <Asking session={session} className='mt-1' />
        {/* A folder or an agent named by a status file can be one long word, so it may break anywhere. */}
        <Place session={session} agent={agent} className='mt-1.5 block wrap-anywhere' />
        <AnswerAsk
          session={session}
          onAnswered={onAnswered}
          focusOnLeave={titleId}
          className='mt-3'
        />
      </div>

      <div className='flex shrink-0 items-end gap-6 max-mid:flex-wrap max-mid:justify-between max-mid:gap-y-3'>
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

/** A wait after the longest, as one compact row with the same parts: what it is asking goes under its reason. */
function Other({
  session,
  asOf,
  agent,
  onAnswered,
  titleId,
}: {
  session: Session;
  asOf: number;
  agent?: string;
  onAnswered?: () => void;
  titleId?: string;
}) {
  const waited = waitedFor(session, asOf);
  const jump = useJump(session);
  return (
    <li
      data-slot='hero-session'
      data-session={session.id}
      className='flex items-center gap-5 border-t border-hairline py-3 max-mid:flex-wrap max-mid:gap-x-4 max-mid:gap-y-2'
    >
      <div className='min-w-0 flex-1 max-mid:basis-full'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1'>
          <div className='flex max-w-full min-w-0 items-center gap-2'>
            <Name session={session} className='text-lead font-semibold text-ink' />
            <Ended session={session} />
          </div>
          <Machine session={session} />
          <JumpNote session={session} jump={jump} />
        </div>
        <p
          data-part='reason'
          className='mt-1 flex min-w-0 flex-wrap items-baseline gap-x-3 text-body'
        >
          <Reason session={session} className='font-medium' />
          {/* It wraps as the lead's does. Cut as one line, it would hide a long branch whole. */}
          <Place session={session} agent={agent} className='block min-w-0 wrap-anywhere' />
        </p>
        <Asking session={session} className='mt-1' />
        <AnswerAsk
          session={session}
          onAnswered={onAnswered}
          focusOnLeave={titleId}
          className='mt-2'
        />
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

/**
 * "demo-project, answered at 09:40", and, for a wait that was under way when
 * the period began, "demo-project, answered at 09:40, waiting since before 09:15".
 * A session on another machine says which: "demo-project on devbox, answered…".
 */
function lastWaitNote(last: LastWait, from: number): ReactNode {
  const machine = machineInId(last.id);
  return (
    <>
      <span className='font-semibold text-ink'>{last.name}</span>
      {machine !== null && ` on ${machine}`}, {last.how === "ended" ? "ended at" : "answered at"}{" "}
      <span className='tabular-nums'>{formatClockMinutes(last.at)}</span>
      {!last.startKnown && (
        <>
          , waiting since before <span className='tabular-nums'>{formatClockMinutes(from)}</span>
        </>
      )}
    </>
  );
}

/** Which machines' sessions the quiet hero can speak for, and which it cannot. */
interface Seen {
  /** The other machines read, "gpu", named with this computer. */
  connected: readonly Pick<SourceHealth, "label">[];
  /** Why the others cannot be spoken for, or null when every one is read. */
  unseen: string | null;
}

/**
 * Nothing needs the person. It says so at the hero's size, with the lamp out,
 * and on the right gives the last wait that is over, so the panel stays worth
 * looking at. With none in the period, it says that instead, once: "None since
 * 13:05", and how much of that time nobody measured. It never says none while
 * the bars of waits under it show one.
 *
 * While another machine is not connected, or still connecting, nothing is
 * known of its sessions, so the hero never says that nothing needs the
 * person: it says "Nothing on this computer needs you", with any machine
 * that is read named too, and under it which machine is not known and a link
 * to Sources, which says why. It is said in plain words, with nothing warm or
 * red: a machine that is switched off is no fault.
 */
function Quiet({
  id,
  waits,
  onOpen,
  seen,
}: {
  id: string;
  waits: Waits | null;
  onOpen?: () => void;
  seen: Seen;
}) {
  const places = ["this computer", ...seen.connected.map((source) => source.label)];
  const where =
    places.length > 1 ? `${places.slice(0, -1).join(", ")} or ${places.at(-1)}` : places[0];
  const title = seen.unseen === null ? "Nothing needs you" : `Nothing on ${where} needs you`;
  const last = waits?.lastWait ?? null;
  // The bars under the hero can show a wait the page could not say was the last.
  const none = waits !== null && waits.sessions.length === 0;
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
          tabIndex={-1}
          className='mt-1 flex items-center gap-3.5 text-name font-semibold text-ink outline-none'
        >
          <StatusMark kind='needs-you' unlit className='size-6.5' />
          {onOpen ? <OpensHistory onOpen={onOpen}>{title}</OpensHistory> : <span>{title}</span>}
        </h2>
        {seen.unseen === null ? (
          <p className='mt-2.5 max-w-md text-row text-ink-secondary'>
            When a session stops to ask for something, it will show here.
          </p>
        ) : (
          <p data-part='unseen' className='mt-2.5 max-w-md text-row text-ink-secondary'>
            {seen.unseen}{" "}
            <a
              href='#sources'
              className='rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink'
            >
              Sources
            </a>{" "}
            says why.
          </p>
        )}
      </div>

      <div data-part='last-wait' className='shrink-0 text-right max-mid:text-left'>
        <p className='mb-2.5 text-caption font-semibold text-ink-secondary'>Last wait</p>
        {last ? (
          <>
            <p className='text-wait font-normal whitespace-nowrap text-ink'>
              <span className='sr-only'>
                The last wait lasted {last.startKnown ? "" : "at least "}
                {durationInWords(last.ms)}
              </span>
              <span aria-hidden>
                <DurationFigure parts={durationParts(last.ms)} />
              </span>
            </p>
            <p data-part='last-note' className='mt-2 text-caption text-ink-secondary'>
              {lastWaitNote(last, waits?.period.from ?? last.at)}
            </p>
          </>
        ) : (
          <>
            <p data-part='last-note' className='text-body text-ink-secondary'>
              {since && none ? `None ${since}` : "Not known"}
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

/**
 * Before anything is counted: the hero's title with the lamp out, and what is
 * still to come. While only another machine is still being reached, it says
 * that, not that agents on this computer are being looked for.
 */
function Uncounted({
  id,
  counts,
  connecting,
}: {
  id: string;
  counts: CountState;
  /** The other machines still connecting, when nothing on this computer is still looked for. */
  connecting: readonly Pick<SourceHealth, "label">[];
}) {
  return (
    <div>
      <h2
        id={id}
        data-part='title'
        tabIndex={-1}
        className='flex items-center gap-2.5 text-row leading-tight font-semibold text-ink outline-none'
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
              ? connecting.length > 0
                ? `Agent Lookout is still connecting to ${sourceNames(connecting)} over SSH. The count follows as soon as ${connecting.length === 1 ? "it is" : "one is"} read.`
                : "Agent Lookout is still looking for agents on this computer. The count follows as soon as one is read."
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
 *   not counted      a dash and why: still looking, still connecting to
 *                    another machine, or no source could be read
 *   quiet            "Nothing needs you", and the last wait that is over; or,
 *                    while another machine is not read, "Nothing on this
 *                    computer needs you" and which machine is not known
 *   one waiting      its name large, why, what it asks and where, a timer
 *                    and the Jump
 *   several waiting  the longest in full, then each of the others, each with
 *                    its reason, timer and Jump
 *
 * Each waiting session's name is a link to its details. The Sessions list
 * leaves waiting sessions to the hero, so this is where they open from.
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
  onAnswered,
  className,
}: HeroPanelProps) {
  const titleId = useId();
  const counts = countState(sessions, sources);
  const light = heroLight(counts);
  const waiting = useMemo(() => (sessions ? waitingSessions(sessions) : []), [sessions]);
  const agents = showsAgents(sources, sessions ?? []);
  const agentOf = (session: Session) => (agents ? agentLabel(session, sources) : undefined);
  // What the hero can speak for: this computer, and each other machine that is read.
  const unseen = unseenMachines(sources);
  const seen: Seen = {
    connected: sources.filter((source) => isRemoteSource(source.id) && source.state === "ok"),
    unseen: unseenSentence(unseen),
  };
  const lookingHere = sources.some(
    (source) => source.state === "searching" && !isRemoteSource(source.id),
  );

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
    top = (
      <Uncounted id={titleId} counts={counts} connecting={lookingHere ? [] : unseen.connecting} />
    );
  } else if (!first) {
    state = "quiet";
    top = (
      <Quiet
        id={titleId}
        waits={waits}
        onOpen={openHistory && (() => openHistory("needsYou"))}
        seen={seen}
      />
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
        <Lead
          key={first.id}
          session={first}
          asOf={asOf}
          agent={agentOf(first)}
          onAnswered={onAnswered}
          titleId={titleId}
        />
        {rest.length > 0 && (
          <ul data-part='others' aria-label='Also waiting, longest first' className='mt-5'>
            {rest.map((session) => (
              <Other
                key={session.id}
                session={session}
                asOf={asOf}
                agent={agentOf(session)}
                onAnswered={onAnswered}
                titleId={titleId}
              />
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
