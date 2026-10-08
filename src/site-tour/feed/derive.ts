import type {
  HistoryKept,
  HistoryResponse,
  HistorySince,
  LastMessageResponse,
  WaitsResponse,
} from "@core/api";
import { historyPointFor } from "@core/history";
import { diffSessions } from "@core/sessions/diff";
import type {
  AnswerDecision,
  AnsweringStatus,
  HistoryPoint,
  Session,
  SessionEvent,
  SessionsSnapshot,
} from "@core/sessions/session";
import { isStale } from "@core/sessions/staleness";
import { messageText } from "@core/text";
import { isQuietAt } from "@core/time-rules/quietHours";
import { DEFAULT_TIME_RULES, staleAfterMs, type TimeRules } from "@core/time-rules/timeRules";
import type { Span } from "@core/waits/measured";
import { isWaitEvent, waitTotals } from "@core/waits/waitTotals";
import {
  ANSWERED_STEP,
  MOMENTS,
  RESUMED_AT,
  SESSIONS,
  STOPPED_AT,
  WAITING_SESSION,
  WATCHING_SINCE,
  type HourSession,
  type MomentName,
} from "@site-tour/feed/hour";
import { sourcesAt } from "@site-tour/feed/sources";
import { weekBefore } from "@site-tour/feed/week";

/**
 * What the collector's routes answer at any moment of the hour in `hour.ts`.
 *
 * The statuses are those of a moment of the hour, and every time the page
 * reads against the present is the present: when the sources were checked,
 * how long a session has been quiet, and the history, which goes on from the
 * moment to now with the counts that moment had. So a moment can be shown for
 * as long as somebody looks at it, and showing it again later shows it again.
 *
 * The events are what `diffSessions` reports between the moments the hour
 * changes, as the collector reports them between two polls, and the history
 * is a point every two seconds counted by `historyPointFor`. Nothing changes
 * while Agent Lookout is stopped, and the first moment after it starts again
 * is not compared with anything, as the collector compares nothing then.
 *
 * The wait at the end of the hour is answered when the visit says: the
 * answered moment is the present at that time, with checkout-flow working
 * again from it, and everything until then as the waiting moment had it.
 *
 * Before the hour are the six days in `week.ts`, which the history kept on
 * disk still holds: their waits are in the log and in the Waits card, and
 * each morning Agent Lookout started again is a restart. The six-hour charts
 * hold the hour alone.
 */

/** The collector polls every two seconds, and keeps a point for each poll. */
export const POLL_MS = 2_000;

/** What the history folder holds, as Settings says it. */
const KEPT_BYTES = 1_468_006;

/** The history's own limits, as the collector has them: 20 MB, for 8 days. */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** How long Agent Lookout holds a permission request, as it does unless told otherwise: 5 minutes. */
export const HOLD_MS = 5 * 60 * 1000;

/** Answering, as the collector says it once the plugin's requests have reached it. */
const ANSWERING: AnsweringStatus = { state: "on", plugin: "seen", holdMs: HOLD_MS };

/**
 * What is shown of the hour: one of its moments, and for the answered one,
 * when the wait was answered, in epoch milliseconds. An answer before the end
 * of the hour is taken as the end of it.
 */
export interface Shown {
  moment: MomentName;
  answeredAt?: number | null;
  /** Whether pull requests are on, as the visitor in the tour has turned them. On unless this says false. */
  pullRequests?: boolean;
  /** The sessions stopped from the dashboard, with when: they are gone from the list from then on. */
  stopped?: readonly StoppedSession[];
  /** For the answered moment: what the visitor pressed when the wait was answered from the dashboard. */
  decision?: AnswerDecision;
  /** The time rules, as the visitor in the tour has set them. Every rule off unless this says. */
  timeRules?: TimeRules;
}

/** A session stopped from the dashboard in the tour: its process ended then, as far as the dashboard can tell. */
export interface StoppedSession {
  id: string;
  name: string;
  status: Session["status"];
  at: number;
}

export interface Feed {
  /** The moment the hour ends at, in epoch milliseconds. Every moment is given from it. */
  readonly t0: number;
  /** The sessions as `/api/sessions` lists them at a moment, with the present `now`. */
  snapshot(shown: Shown, now: number): SessionsSnapshot;
  /** The events up to a moment, newest first, after `clearedAt` when the history was cleared. */
  events(shown: Shown, clearedAt?: number | null): SessionEvent[];
  /** `/api/history` at a moment, with the present `now`, for the last `windowMs`. */
  history(shown: Shown, now: number, windowMs: number, clearedAt?: number | null): HistoryResponse;
  /** `/api/waits` at a moment, with the present `now`: today and the last seven days. */
  waits(shown: Shown, now: number, clearedAt?: number | null): WaitsResponse;
  /**
   * `/api/sessions/last-message` for one session at a moment, with the present
   * `now`, or null for a session that is not listed then, which the collector
   * answers 404. Only a Claude Code session on this computer is read.
   */
  lastMessage(id: string, shown: Shown, now: number): LastMessageResponse | null;
}

/** A moment as an offset from `t0`, and when the wait was answered, from `t0` too, or null. */
interface Place {
  offset: number;
  answer: number | null;
}

/** The step a session is on at a moment, from `t0`, with the wait answered at `answer`. */
function stepAt(session: HourSession, offset: number, answer: number | null = null) {
  const steps =
    answer !== null && session.id === WAITING_SESSION
      ? [...session.steps, { ...ANSWERED_STEP, at: answer }]
      : session.steps;
  let step = steps[0];
  for (const next of steps) {
    if (next.at <= offset) step = next;
  }
  return step;
}

/** Whether a session is listed at a moment. */
function listedAt(session: HourSession, offset: number): boolean {
  return session.appearsAt === undefined || session.appearsAt <= offset;
}

/** Whether a moment falls while Agent Lookout was stopped. */
function stopped(offset: number): boolean {
  return offset > STOPPED_AT && offset < RESUMED_AT;
}

export function createFeed(t0: number): Feed {
  const at = (offset: number) => t0 + offset;
  const week = weekBefore(t0);

  /** Where a moment is in the hour. */
  function place({ moment, answeredAt = null }: Shown): Place {
    if (moment !== "answered") return { offset: MOMENTS[moment], answer: null };
    const answer = Math.max(MOMENTS.answered, (answeredAt ?? t0) - t0);
    return { offset: answer, answer };
  }

  /** The sessions at a moment as the collector holds them from one poll to the next: without what they ask. */
  function sessionsAt(
    offset: number,
    answer: number | null = null,
    now: number = at(offset),
    pullRequests = true,
    staleAfter: number = staleAfterMs(DEFAULT_TIME_RULES),
  ): Session[] {
    const sessions: Session[] = [];
    for (const hour of SESSIONS) {
      if (!listedAt(hour, offset)) continue;
      const step = stepAt(hour, offset, answer);
      const session: Session = {
        id: hour.id,
        source: hour.source,
        surface: hour.surface,
        name: hour.name,
        cwd: hour.folder,
        project: hour.project,
        git: {
          branch: hour.branch,
          repository: { ...hour.repository },
          ...(pullRequests &&
            hour.pullRequest && {
              pullRequest: { ...hour.pullRequest, checks: { ...hour.pullRequest.checks } },
            }),
        },
        status: step.status,
        startedAt: at(hour.startedAt),
        statusSince: at(step.at),
        links: { ...hour.links },
        stale: isStale({ status: step.status, statusSince: at(step.at) }, now, staleAfter),
      };
      if (hour.agent !== undefined) session.agent = hour.agent;
      if (hour.machine !== undefined) session.machine = hour.machine;
      if (step.status === "needs-you") {
        if (step.waitingReason) session.waitingReason = step.waitingReason;
        if (step.waitingDetail) session.waitingDetail = step.waitingDetail;
      }
      if (hour.writes) {
        // A working agent writes as it works. Any other has not since it stopped.
        session.lastWriteAt = step.status === "working" ? now - 3_000 : at(step.at);
      }
      if (hour.pid !== undefined) {
        session.pid = hour.pid;
        session.alive = step.status !== "finished";
      }
      if (hour.jump) session.jump = { ...hour.jump };
      // Claude Code can be stopped in a terminal and in VS Code, while its process runs something.
      if (
        hour.source === "claude-code" &&
        (hour.surface === "terminal" || hour.surface === "vscode") &&
        session.alive === true &&
        step.status !== "finished" &&
        step.status !== "failed"
      ) {
        session.stop = { how: "signal" };
      }
      sessions.push(session);
    }
    return sessions;
  }

  // The moments the hour changes, oldest first. The first look is not one: it is where watching began.
  const changes = [
    ...new Set(
      SESSIONS.flatMap((session) => [
        ...(session.appearsAt === undefined ? [] : [session.appearsAt]),
        ...session.steps.map((step) => step.at),
      ]),
    ),
  ]
    .filter((offset) => offset > WATCHING_SINCE && offset <= 0 && !stopped(offset))
    .sort((a, b) => a - b);

  // Newest first, as the log lists them.
  const allEvents: SessionEvent[] = changes
    .filter((offset) => offset !== RESUMED_AT)
    .flatMap((offset) => diffSessions(sessionsAt(offset - 1), sessionsAt(offset), at(offset)))
    .reverse();

  // A point for every poll, up to t0, but none while Agent Lookout was stopped.
  const basePoints: HistoryPoint[] = [];
  for (let offset = WATCHING_SINCE; offset <= 0; offset += POLL_MS) {
    if (stopped(offset)) continue;
    basePoints.push(historyPointFor(sessionsAt(offset), at(offset)));
  }

  /** What stopping sessions from the dashboard adds to the log: Agent Lookout stopped each, and it ended. */
  function stopEvents(stopped: readonly StoppedSession[] = []): SessionEvent[] {
    return stopped
      .flatMap((one) => [
        ...diffSessions([one], [], one.at),
        {
          id: `${one.id}@${one.at}:stopped`,
          at: one.at,
          sessionId: one.id,
          sessionName: one.name,
          kind: "stopped" as const,
          from: one.status,
          severity: "advisory" as const,
          by: "agent-lookout" as const,
        },
      ])
      .sort((a, b) => b.at - a.at);
  }

  /** Where the history held begins: the first start, or the clearing. */
  function sinceOf(clearedAt: number | null): HistorySince {
    return clearedAt === null
      ? { at: week.firstStart, by: "started" }
      : { at: clearedAt, by: "cleared" };
  }

  /**
   * What the answer of the wait adds to the log, at the moment it came: the
   * session going back to work, and, when the visitor answered it from the
   * dashboard, that Agent Lookout answered it, with what was pressed.
   */
  function answerEvents({ answer }: Place, decision?: AnswerDecision): SessionEvent[] {
    if (answer === null) return [];
    const moved = diffSessions(sessionsAt(answer - 1), sessionsAt(answer, answer), at(answer));
    const waiting = SESSIONS.find((hour) => hour.id === WAITING_SESSION);
    if (decision === undefined || !waiting) return moved;
    const id = WAITING_SESSION;
    return [
      ...moved,
      {
        id: `${id}@${at(answer)}:answered`,
        at: at(answer),
        sessionId: id,
        sessionName: waiting.name,
        kind: "answered",
        from: "needs-you",
        severity: "advisory",
        by: "agent-lookout",
        decision,
      },
    ];
  }

  function kept(): HistoryKept {
    return {
      where: "disk",
      folder: "~/.agent-lookout/history",
      bytes: KEPT_BYTES,
      maxBytes: MAX_BYTES,
      maxAgeMs: MAX_AGE_MS,
      canClear: true,
      problem: null,
    };
  }

  const feed: Feed = {
    t0,

    snapshot(shown, now) {
      const { offset, answer } = place(shown);
      const timeRules = shown.timeRules ?? DEFAULT_TIME_RULES;
      const gone = new Set((shown.stopped ?? []).map((one) => one.id));
      const sessions = sessionsAt(
        offset,
        answer,
        now,
        shown.pullRequests !== false,
        staleAfterMs(timeRules),
      ).filter((session) => !gone.has(session.id));
      const steps = new Map(SESSIONS.map((hour) => [hour.id, stepAt(hour, offset, answer)]));
      for (const session of sessions) {
        // What a waiting session asks, and the request held for it, are in this answer alone.
        const step = steps.get(session.id);
        if (session.status !== "needs-you" || !step) continue;
        if (step.waitingText) session.waitingText = step.waitingText;
        // Held for as long as the request lasts, which is never over while it is shown.
        if (step.ask) session.ask = { ...step.ask, until: now + HOLD_MS };
      }
      const files = sessions.filter((session) => session.source === "status-files").length;
      return {
        generatedAt: now,
        sources: sourcesAt(now, files, __APP_VERSION__),
        sessions,
        answering: { ...ANSWERING },
        timeRules,
        quiet: timeRules.quietHours.on && isQuietAt(timeRules.quietHours, now),
      };
    },

    events(shown, clearedAt = null) {
      const where = place(shown);
      const until = at(where.offset);
      const held = [...answerEvents(where, shown.decision), ...allEvents, ...week.events].filter(
        (event) => event.at <= until && (clearedAt === null || event.at > clearedAt),
      );
      const stops = stopEvents(shown.stopped).filter(
        (event) => clearedAt === null || event.at > clearedAt,
      );
      return [...stops, ...held];
    },

    history(shown, now, windowMs, clearedAt = null) {
      const { offset, answer } = place(shown);
      const until = at(offset);
      const from = Math.max(now - windowMs, clearedAt ?? -Infinity);
      const points = basePoints.filter((point) => point.at <= until && point.at >= from);
      // After the end of the hour and until the answer, the wait goes on.
      const waiting = historyPointFor(sessionsAt(0), 0);
      for (let point = t0 + POLL_MS; point < until && point <= now; point += POLL_MS) {
        if (point >= from) points.push({ ...waiting, at: point });
      }
      // The present goes on with the moment's counts, a poll every two seconds.
      const held = historyPointFor(sessionsAt(offset, answer), 0);
      const first = until > t0 ? until : until + POLL_MS;
      for (let point = first; point <= now; point += POLL_MS) {
        if (point >= from) points.push({ ...held, at: point });
      }
      if (clearedAt !== null) {
        return {
          points,
          startedAt: at(RESUMED_AT),
          since: sinceOf(clearedAt),
          kept: { ...kept(), bytes: 0 },
        };
      }
      return {
        points,
        startedAt: at(RESUMED_AT),
        since: sinceOf(null),
        kept: kept(),
        restarts: [...week.restarts, { at: at(RESUMED_AT), lastBefore: at(STOPPED_AT) }],
      };
    },

    waits(shown, now, clearedAt = null) {
      const snapshot = feed.snapshot(shown, now);
      const since = sinceOf(clearedAt);
      // The stretches measured: each day's run, and the hour's two, the second running on to now.
      const runs: Span[] = [
        ...week.runs,
        { from: at(WATCHING_SINCE), to: at(STOPPED_AT) },
        { from: at(RESUMED_AT), to: now },
      ];
      const measured = runs
        .map((run) => ({ from: Math.max(run.from, since.at), to: run.to }))
        .filter((run) => run.to > run.from);
      const totals = waitTotals({
        events: feed.events(shown, clearedAt).filter(isWaitEvent),
        measured,
        runStarts: [...week.runs.map((run) => run.from), at(WATCHING_SINCE), at(RESUMED_AT)],
        waitingNow: snapshot.sessions
          .filter((session) => session.status === "needs-you")
          .map((session) => ({ id: session.id, name: session.name })),
        names: new Map(snapshot.sessions.map((session) => [session.id, session.name])),
        since: since.at,
        now,
      });
      return { at: now, ...totals, since, where: "disk" };
    },

    lastMessage(id, shown, now) {
      const session = feed.snapshot(shown, now).sessions.find((listed) => listed.id === id);
      if (!session) return null;
      // As the collector answers: another agent, or another machine, is not read.
      if (session.source !== "claude-code") return { message: null, reason: "not-read" };
      const said = messageText(SESSIONS.find((hour) => hour.id === id)?.said);
      return said ? { message: said } : { message: null, reason: "nothing-yet" };
    },
  };
  return feed;
}
