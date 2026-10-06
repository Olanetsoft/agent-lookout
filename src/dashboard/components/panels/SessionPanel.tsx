import { Fragment, useMemo, useState, type ReactNode } from "react";

import { withoutWaitingText, type Session } from "@core/sessions/session";
import { waitingLabel } from "@core/notices/waiting";
import { OwnEvents } from "@dashboard/components/events/EventsCard";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { StopButton, StopNote } from "@dashboard/components/stop/StopSession";
import { TimelineChart } from "@dashboard/components/timeline/TimelineCard";
import { Button } from "@dashboard/components/ui/controls/Button";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { DetailsModal } from "@dashboard/components/ui/surfaces/DetailsModal";
import { Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { useJump } from "@dashboard/hooks/actions/useJump";
import { useStop } from "@dashboard/hooks/actions/useStop";
import { MAX_EVENTS, type CollectorState } from "@dashboard/lib/api/collectorStore";
import { buildTimeline } from "@dashboard/lib/charts/timeline";
import {
  durationInWords,
  formatClockMinutes,
  formatDuration,
  formatSince,
} from "@dashboard/lib/format";
import { logEntries, logStart } from "@dashboard/lib/events/events";
import { quietFor, quietPhrase } from "@dashboard/lib/sessions/quiet";
import { isStaleIdle } from "@dashboard/lib/sessions/sessions";
import { STATUS_LABEL, surfaceLabel, waitingDetail } from "@dashboard/lib/sessions/status";
import { waitedOnYou } from "@dashboard/lib/sessions/waits";
import { agentLabel } from "@dashboard/lib/sources/sources";
import { DESKTOP_NO_STOP } from "@dashboard/lib/stop/stopWords";
import { cn } from "@dashboard/lib/utils";

const NO_SESSIONS: readonly Session[] = [];

/**
 * Where focus goes when a session's details close: the link to them that had
 * focus when they opened, or else the session's name in its row or its card,
 * or in the hero. On the board a waiting session has both a card and a place
 * in the hero, and a click on the card leaves nothing focused to say which it
 * was, so the card comes first.
 */
function nameOf(sessionId: string, opener: HTMLElement | null): HTMLElement | null {
  const id = CSS.escape(sessionId);
  const names = [
    ...document.querySelectorAll<HTMLElement>(
      `:is([data-slot="session-row"], [data-slot="board-card"], [data-slot="hero-session"])[data-session="${id}"] a[data-part="name"]`,
    ),
  ];
  if (opener !== null && names.includes(opener)) return opener;
  return names.find((name) => !name.closest('[data-slot="hero-session"]')) ?? names[0] ?? null;
}

/**
 * Its status, in the words and the mark the list uses, with how long it has
 * had it, and under them why it waits, since when, and how long a working
 * session's agent has written nothing, as its row says it. Under the pair go
 * what a waiting session is asking, cut at two lines, and the agent's own
 * wording of a wait, when it says more. A session that has left the list is
 * waiting no more, so what it was asking is not said.
 */
function StatusFact({
  session,
  gone,
  asOf,
  now,
}: {
  session: Session;
  gone: boolean;
  asOf: number;
  now: number;
}) {
  const ended = session.status === "finished" || session.status === "failed";
  const stale = isStaleIdle(session);
  // A wait whose session has gone is over, and its lamp is out, as it is in the log.
  const mark: MarkKind = stale
    ? "stale"
    : gone && session.status === "needs-you"
      ? "answered"
      : session.status;
  const since = session.statusSince;
  const lasted = since !== null ? Math.max(0, asOf - since) : null;
  const quiet = quietFor(session, asOf);
  const waiting = session.status === "needs-you";
  const detail = waiting ? waitingDetail(session) : null;
  const asking = (waiting && !gone && session.waitingText?.trim()) || null;
  const when =
    since !== null
      ? `${ended ? "at" : stale ? "idle since" : "since"} ${formatSince(since, now)}`
      : "time not reported";
  const line = [waiting ? waitingLabel(session) : null, when, quiet && quietPhrase(quiet)].filter(
    (part) => typeof part === "string",
  );

  return (
    <FactRow
      label='Status'
      note={
        asking ? (
          <>
            <Truncated data-part='asking' lines={2} className='wrap-anywhere'>
              {asking}
            </Truncated>
            {detail && <span className='block'>{detail}</span>}
          </>
        ) : (
          (detail ?? undefined)
        )
      }
    >
      <span className='inline-flex items-center gap-2'>
        <StatusMark kind={mark} />
        <span data-part='status'>{stale ? "Stale" : STATUS_LABEL[session.status]}</span>
        {lasted !== null && (
          <span data-part='duration' className='tabular-nums'>
            <span className='sr-only'>
              {ended ? ` ${durationInWords(lasted)} ago` : ` for ${durationInWords(lasted)}`}
            </span>
            <span aria-hidden>
              {formatDuration(lasted)}
              {ended && " ago"}
            </span>
          </span>
        )}
      </span>
      <span
        data-part='since'
        className='block text-caption font-normal text-ink-secondary tabular-nums'
      >
        {line.join(", ")}
      </span>
    </FactRow>
  );
}

/** "Once, 1m 05s", "3 times, 5m 51s in all", or "None", over the period the page holds. */
function WaitsFact({
  session,
  state,
  now,
  asOf,
}: {
  session: Session;
  state: CollectorState;
  now: number;
  asOf: number;
}) {
  const waits = useMemo(
    () =>
      waitedOnYou({
        sessions: state.snapshot?.sessions ?? NO_SESSIONS,
        events: state.events,
        history: state.history,
        now,
        asOf,
        eventsFull: state.events.length >= MAX_EVENTS,
      }),
    [state.snapshot, state.events, state.history, now, asOf],
  );
  if (!waits) {
    return (
      <FactRow label='Waits'>
        Not known
        <span className='block text-caption font-normal text-ink-secondary'>
          The history could not be read
        </span>
      </FactRow>
    );
  }
  const own = waits.sessions.find((entry) => entry.id === session.id);
  const period = waits.period.today ? "today" : `since ${formatClockMinutes(waits.period.from)}`;
  let value = "None";
  if (own) {
    const length = `${own.startKnown ? "" : "at least "}${formatDuration(own.ms)}`;
    value = own.times === 1 ? `Once, ${length}` : `${own.times} times, ${length} in all`;
  }
  return (
    <FactRow label='Waits'>
      <span data-part='waits' className='tabular-nums'>
        {value}
      </span>
      <span className='block text-caption font-normal text-ink-secondary'>{period}</span>
    </FactRow>
  );
}

/** A part of the details under the facts: its heading, a quiet word at its right, and what it holds. */
function Part({
  title,
  aside,
  children,
  ...data
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  "data-part": string;
}) {
  return (
    <section {...data} aria-label={title} className='mt-6'>
      <div className='flex items-baseline justify-between gap-4 border-b border-hairline pb-2'>
        <h3 className='text-body font-semibold text-ink'>{title}</h3>
        {aside && <p className='text-caption text-ink-muted'>{aside}</p>}
      </div>
      {children}
    </section>
  );
}

/** Everything the page holds about one session. */
function Details({
  session,
  gone,
  state,
  now,
  asOf,
}: {
  session: Session;
  gone: boolean;
  state: CollectorState;
  now: number;
  asOf: number;
}) {
  const sources = state.snapshot?.sources ?? [];
  const sessions = state.snapshot?.sessions ?? NO_SESSIONS;
  const app = surfaceLabel(session.surface);
  const full = state.events.length >= MAX_EVENTS;

  const entries = useMemo(
    () =>
      logEntries(
        state.events.filter((event) => event.sessionId === session.id),
        sessions,
      ),
    [state.events, sessions, session.id],
  );
  const start = logStart(state.events, state.history, full);

  const timeline = useMemo(
    () =>
      state.history
        ? buildTimeline({
            sessions,
            events: state.events,
            history: state.history,
            now,
            asOf,
            eventsFull: full,
          })
        : null,
    [sessions, state.events, state.history, now, asOf, full],
  );
  const row = timeline?.rows.find((candidate) => candidate.id === session.id);

  return (
    <>
      {gone && (
        <p data-part='gone' className='mt-4 text-body text-ink-secondary'>
          This session has left the list. Here is what was last known of it.
        </p>
      )}

      <FactList className='mt-3'>
        <StatusFact session={session} gone={gone} asOf={asOf} now={now} />
        <FactRow label='Agent'>{agentLabel(session, sources)}</FactRow>
        {app !== null && <FactRow label='App'>{app}</FactRow>}
        <FactRow label='Folder' mono={session.cwd !== null}>
          {session.cwd !== null ? (
            <span data-part='folder' className='wrap-anywhere select-text'>
              {/* A long path breaks after a slash where it can. */}
              {session.cwd.split("/").map((part, index, parts) => (
                <Fragment key={index}>
                  {part}
                  {index < parts.length - 1 && (
                    <>
                      /<wbr />
                    </>
                  )}
                </Fragment>
              ))}
            </span>
          ) : (
            "Not known"
          )}
        </FactRow>
        {session.git?.repository !== undefined && (
          <FactRow label='Repository'>
            <span data-part='repository' className='wrap-anywhere'>
              {session.git.repository.name}
            </span>
          </FactRow>
        )}
        {session.git?.branch !== undefined ? (
          <FactRow label='Branch'>
            <span data-part='branch' className='wrap-anywhere'>
              {session.git.branch}
            </span>
          </FactRow>
        ) : (
          session.git?.commit !== undefined && (
            <FactRow label='Commit' mono>
              {session.git.commit}
            </FactRow>
          )
        )}
        <FactRow label='Started'>
          <span className='tabular-nums'>
            {session.startedAt !== null ? formatSince(session.startedAt, now) : "Not reported"}
          </span>
        </FactRow>
        {session.pid !== undefined && (
          <FactRow
            label='Process'
            mono
            note={
              session.alive === false
                ? "The process has ended."
                : // The desktop app looks after its own process, so it has no Stop, and says why.
                  !gone && session.source === "claude-code" && session.surface === "desktop"
                  ? DESKTOP_NO_STOP
                  : undefined
            }
          >
            {session.pid}
          </FactRow>
        )}
        <WaitsFact session={session} state={state} now={now} asOf={asOf} />
      </FactList>

      <Part
        data-part='events'
        title='Events'
        aside={start ? `since ${formatClockMinutes(start.at)}` : undefined}
      >
        {entries.length > 0 ? (
          <OwnEvents entries={entries} now={now} className='pt-0.5' />
        ) : (
          <p className='py-2.5 text-body text-ink-secondary'>
            Nothing has happened to this session{" "}
            {start ? `since ${formatClockMinutes(start.at)}` : "yet"}.
          </p>
        )}
      </Part>

      <Part data-part='timeline' title='Timeline' aside='last hour'>
        {timeline && row ? (
          <TimelineChart
            timeline={timeline}
            rows={[row]}
            named={false}
            label='Its last hour'
            className='pt-3'
          />
        ) : (
          <p className='py-2.5 text-body text-ink-secondary'>
            {timeline
              ? "It did not run in the last hour."
              : "The last hour could not be read. The page asks again every two seconds."}
          </p>
        )}
      </Part>
    </>
  );
}

interface SessionDialogProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  state: CollectorState;
  now: number;
  /** Told once the session has been stopped, so the page reads the sessions again at once. */
  onStopped?: () => void;
}

/** One session's dialog, from the moment its address is opened until it has faded out. */
function SessionDialog({ sessionId, open, onClose, state, now, onStopped }: SessionDialogProps) {
  const listed = state.snapshot?.sessions.find((session) => session.id === sessionId) ?? null;
  // What was last known of it, and when, kept for when it leaves the list while open.
  const [kept, setKept] = useState<{ session: Session; at: number } | null>(null);
  if (listed !== null && listed !== kept?.session) {
    setKept({ session: listed, at: state.lastOkAt ?? now });
  } else if (listed === null && kept?.session.waitingText !== undefined) {
    // Once it has left the list its wait is over, and what it was asking is not kept.
    setKept({ ...kept, session: withoutWaitingText(kept.session) });
  }
  const session = listed ?? kept?.session ?? null;
  const gone = listed === null && kept !== null;
  // Before the session is known it has no way to be reached, and its Jump is not drawn.
  const jump = useJump(
    session ?? { id: sessionId, source: "status-files", surface: "unknown", links: {} },
  );
  // Once answers stop, its timers stop at the last one, as the Overview's do, and
  // once it has gone, at the last answer that listed it.
  const asOf =
    gone && kept
      ? kept.at
      : state.phase === "stalled" && state.lastOkAt !== null
        ? state.lastOkAt
        : now;
  const saying = jump.outcome !== null || jump.asking !== null;
  const stop = useStop(sessionId, { open, onStopped });
  // What Stop asks is no question once the session has gone, but what it came to is still said.
  const stopSaying =
    stop.step.kind === "answered" || (stop.step.kind === "confirming" && (stop.step.busy || !gone));

  let title: string;
  let body: ReactNode;
  let size: "sm" | "wide" = "wide";
  if (session) {
    title = session.name;
    body = (
      <>
        {!gone && (
          <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1", saying && "mt-3")}>
            <JumpNote session={session} jump={jump} />
          </div>
        )}
        {stopSaying && <StopNote session={session} stop={stop} className='mt-3' />}
        <Details session={session} gone={gone} state={state} now={now} asOf={asOf} />
      </>
    );
  } else if (state.snapshot === null) {
    title = "Session";
    body = <Loading label='Reading sessions' className='justify-start px-0 pt-5 pb-1' />;
  } else {
    title = "No such session";
    size = "sm";
    body = (
      <div data-part='missing'>
        <p className='mt-2 text-body text-ink-secondary'>
          Agent Lookout is not watching a session at this address. It may have ended before this
          page was opened.
        </p>
        <Button className='mt-4' onClick={onClose}>
          Go to the Overview
        </Button>
      </div>
    );
  }

  return (
    <DetailsModal
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      size={size}
      focusTitle
      // Once the session has left the list, focus goes to the view.
      returnFocus={(opener) =>
        nameOf(sessionId, opener) ?? document.querySelector<HTMLElement>("main")
      }
      actions={
        session &&
        !gone && (
          <>
            <Jump
              session={session}
              jump={jump}
              variant={session.status === "needs-you" ? "needs-you" : "quiet"}
            />
            <StopButton session={session} stop={stop} />
          </>
        )
      }
    >
      {body}
    </DetailsModal>
  );
}

interface SessionPanelProps {
  /** The session whose details are open, from the page's address, or null when none are. */
  sessionId: string | null;
  /** Closes them, and goes back to the Overview. */
  onClose: () => void;
  state: CollectorState;
  now: number;
  /** Told once a session has been stopped from its details, so the page reads the sessions again. */
  onStopped?: () => void;
}

/**
 * One session's details, over the Overview: everything the page already holds
 * about it, in one place, at its own address.
 *
 * Its name is the title, with its Jump beside it when it has one: the lamp's
 * solid Jump while it needs the person, as in the hero, and the quiet one
 * otherwise. After it comes Stop, when the collector can stop the session:
 * it asks first, at the top of the details, and says there what it came to.
 * A session in the desktop app has no Stop, and its process fact says why.
 * Under them, as facts: its status with how long and since when, its agent,
 * its app when known, its folder's whole path, its branch, when it started,
 * its process, and how often and how long it waited over the period the page
 * holds. Then its own events, newest first, as the Events log draws
 * them, and its row of the Timeline across the whole width.
 *
 * The only warm things are the needs-you signals the rest of the page has for
 * the same wait: the lamp of its status, the lit lamp of the event that began
 * a wait still open and the open block on its timeline, and its Jump. Its
 * reason and its waits are in the ink.
 *
 * A session that leaves the list while it is open keeps what was last known,
 * under one calm line that says so, and has no Jump and no Stop. An address that names no
 * session says so and offers the Overview.
 */
export function SessionPanel({ sessionId, onClose, state, now, onStopped }: SessionPanelProps) {
  // Kept while the dialog fades out, so what it shows stays put.
  const [shownId, setShownId] = useState(sessionId);
  if (sessionId !== null && sessionId !== shownId) setShownId(sessionId);
  if (shownId === null) return null;
  return (
    <SessionDialog
      key={shownId}
      sessionId={shownId}
      open={sessionId !== null}
      onClose={onClose}
      state={state}
      now={now}
      onStopped={onStopped}
    />
  );
}
