import type { SendResult } from "../../core/api.ts";
import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
  type NoticeEvent,
} from "../../core/notices/sessionChanges.ts";
import {
  agentName,
  withoutWaitingText,
  type Session,
  type SessionsSnapshot,
} from "../../core/sessions/session.ts";
import { waitingText } from "../../core/text.ts";
import {
  createQuietHold,
  type QuietSummary,
  type SummaryItem,
} from "../../core/time-rules/quietHold.ts";
import { quietOf } from "../../core/time-rules/quietHours.ts";
import { createReminderWatch, reminderSchedule } from "../../core/time-rules/reminders.ts";
import { rulesOf } from "../../core/time-rules/timeRules.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";
import { limitLiftsAt, sendsInLastHour, sendTiming, waitBegan } from "./outboundTiming.ts";

/**
 * One way of sending notices off this computer, by the rules email and the
 * webhook share. Each supplies only what one says and how it is sent; the
 * rules of what is sent and when are all here, so the two cannot drift.
 *
 * What happened is decided by `sessionChanges` in the core, the rule the
 * dashboard and the collector's own notifications run over the same
 * snapshots: nothing for what was already true when the collector started,
 * and one for each change after that. A wait is sent once it has lasted the
 * delay, if it is still open. A session that finished, failed or ended is sent
 * at once. `outboundTiming.ts` has the timing, and the hourly limit, which
 * covers everything this channel sends and nothing another sends. Each is
 * tried once. One that could not be sent is not tried again, and `last` says
 * why.
 *
 * What a waiting session is asking goes only in the message for its wait, and
 * only when the channel's setting says so: it can hold a command, a web address
 * or a file's full path. It is taken from the snapshot of the poll at which the
 * wait is sent, cleaned and cut by `waitingText`, the rule the line the
 * dashboard shows was made by, so the two say the same. Nothing here keeps it:
 * a wait not yet sent is held by its id and the time it began alone, and every
 * session handed to a message, or held for one, is handed over without it.
 *
 * The time rules each snapshot carries are followed here too. With the long
 * wait reminder on, a wait that has been sent, or was open when the collector
 * started, is reminded of once it has lasted the rule's minutes, by
 * `reminders.ts` in the core: once for each wait, and with the repeat on,
 * again each time the repeat's minutes pass while it waits, never before its
 * own email or post has gone. During quiet hours nothing is sent: a wait that
 * comes due, a reminder, which is held as its wait, and a session that
 * finishes, fails or ends are held, by `quietHold.ts`, and when they end, a
 * wait still open is sent as usual, or reminded of when it was sent before
 * them, and the rest goes in one summary. Each counts against the hourly
 * limit as one.
 *
 * A wait whose permission request Agent Lookout answered is over from the
 * moment of the answer, as the snapshot marks it, though its source can say
 * it waits for a second or two more: nothing more is sent for it, and one a
 * rule answered before any poll saw it is never sent at all.
 *
 * Nothing here can stop a poll. `handle` never throws, and each is sent after
 * the poll has moved on, one at a time.
 */

/** How one email or post went: sent, or not sent, with a short reason in plain words. */
export type SendOutcome = { sent: true } | { sent: false; reason: string };

/** A wait that has lasted the delay and is still open. */
export interface WaitFacts {
  session: Pick<Session, "id" | "name" | "project" | "surface" | "waitingReason">;
  /** The agent, as its source calls itself: "Claude Code". Null when not known. */
  agent: string | null;
  /**
   * What the session is asking, as the dashboard shows it: "Run: npm test".
   * Null unless the channel's setting is on and the session's agent says.
   */
  asking: string | null;
  /** When the wait began. */
  begunAt: number;
  /** When the email or post is written. */
  now: number;
}

/** A wait that has lasted the long wait reminder's threshold and is still open. */
export interface ReminderFacts extends WaitFacts {
  /** The threshold it has lasted, in milliseconds. */
  thresholdMs: number;
  /** How long from one reminder to the next while the repeat is on, in milliseconds, or null. */
  everyMs: number | null;
  /**
   * Which reminder of the wait it is, by how long it has waited: 0 for the
   * first, at the threshold, and from 1 a repeat (`reminderNumber`).
   */
  repeat: number;
}

/** One item of a summary, with its session's agent. */
export type SummaryFacts = Omit<QuietSummary, "items"> & {
  items: (SummaryItem & { agent: string | null })[];
  /** When the email or post is written. */
  now: number;
};

/** A session that finished, failed or ended. */
export interface OverFacts {
  event: Exclude<NoticeEvent, "needs-you">;
  session: Pick<Session, "id" | "name" | "project" | "surface">;
  /** The agent, as its source calls itself: "Claude Code". Null when not known. */
  agent: string | null;
  /** When the collector saw it happen. */
  seenAt: number;
  /** When the email or post is written. */
  now: number;
}

export interface OutboundChannelOptions<Content> {
  /** The events that are sent. */
  events: readonly NoticeEvent[];
  /** How long a wait lasts before it is sent, in milliseconds. */
  afterMs: number;
  /** Whether what is sent for a wait says what the session is asking. */
  asking: boolean;
  /** What is sent for a wait. */
  waitMessage(facts: WaitFacts): Content;
  /** What is sent for a session that finished, failed or ended. */
  overMessage(facts: OverFacts): Content;
  /** What is sent to remind of a long wait. */
  reminderMessage(facts: ReminderFacts): Content;
  /** What is sent when quiet hours end, of what they held. */
  summaryMessage(facts: SummaryFacts): Content;
  /** Sends one. It should never reject; one that does, or throws, has failed. */
  send(content: Content): Promise<SendOutcome>;
  /** The reason given when `send` throws or rejects. */
  failure: string;
  now?: () => number;
}

export interface OutboundChannel {
  /** Takes each snapshot the poller produces, and sends what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** The last one that was tried, or null when none has been. */
  last(): SendResult | null;
  /** While the hourly limit holds them back, when the next may go. */
  limitedUntil(): number | null;
  /** Resolves once every one handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export function createOutboundChannel<Content>(
  options: OutboundChannelOptions<Content>,
): OutboundChannel {
  const { afterMs, asking, waitMessage, overMessage, reminderMessage, summaryMessage, failure } =
    options;
  const now = options.now ?? Date.now;

  const wanted = new Set(options.events);
  let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
  /**
   * What is due and not yet sent, oldest first: the sessions that finished,
   * failed or ended, and a summary of quiet hours. Each is written when it goes.
   */
  const ready: ((now: number) => Content)[] = [];
  /** The waits not yet sent, by session id, with when each began. */
  const open = new Map<string, number>();
  /**
   * The status time of the wait last seen for each session that is not to be
   * sent: one already sent, or one that was open when the collector started.
   * A session that misses a poll, or reads as another status for one, comes
   * back as a wait that started. With the same status time it is the same
   * wait, and is not sent again. Entries are kept when a wait stops, for that
   * reason.
   */
  const done = new Map<string, number>();
  /** When each of the last hour was tried. */
  let sentAt: number[] = [];
  /** The waits that could be reminded of, and those already reminded. */
  const reminders = createReminderWatch();
  /** What quiet hours hold back. */
  const hold = createQuietHold();
  let last: SendResult | null = null;
  /** They go one after another, never side by side. */
  let queue: Promise<void> = Promise.resolve();

  function send(content: Content): void {
    queue = queue
      .then(() => options.send(content))
      .then(
        (outcome) => {
          last = outcome.sent
            ? { at: now(), sent: true }
            : { at: now(), sent: false, reason: outcome.reason };
        },
        () => {
          // A sender should not reject. One that does is a failure like any other.
          last = { at: now(), sent: false, reason: failure };
        },
      );
  }

  return {
    handle(snapshot) {
      try {
        const at = now();
        const rules = rulesOf(snapshot);
        // As the collector said when it made the snapshot, which every channel goes by.
        const quiet = quietOf(snapshot);
        const result = sessionChanges(memory, snapshot);
        memory = result.memory;

        for (const id of result.stopped) {
          open.delete(id);
          hold.waitEnded(id, at);
        }
        reminders.observe(snapshot, result.stopped, at);

        if (hold.holding() && !quiet) {
          // The quiet hours are over. What they held goes first, as one.
          const end = hold.end(snapshot, at, rules.quietHours.leaveOutAnswered);
          const { summary } = end;
          if (summary) {
            const items = summary.items.map((item) => ({
              ...item,
              agent: agentName(item.session, snapshot.sources),
            }));
            ready.push((sentNow) => summaryMessage({ ...summary, items, now: sentNow }));
          }
          // A wait still open is sent as any other wait is, below.
          for (const { session, begunAt } of end.open) open.set(session.id, begunAt);
        }
        if (quiet) hold.begin(at);

        for (const { event, session } of result.changes) {
          if (!wanted.has(event)) continue;
          if (event !== "needs-you") {
            if (quiet) {
              hold.holdOver(event, session, at);
              continue;
            }
            const facts: Omit<OverFacts, "now"> = {
              event,
              session: withoutWaitingText(session),
              agent: agentName(session, snapshot.sources),
              seenAt: at,
            };
            ready.push((sentNow) => overMessage({ ...facts, now: sentNow }));
            continue;
          }
          const since = session.statusSince;
          if (since !== null && done.get(session.id) === since) continue;
          // A wait not yet sent that missed a poll comes back with the time it
          // began, and keeps its place.
          open.set(session.id, waitBegan(since, at));
        }

        sentAt = sendsInLastHour(sentAt, at);
        // Due as soon as they are seen. The hourly limit can hold them, and
        // then they go in turn as it lets each one go, before any wait. One
        // the limit held when quiet hours began waits for them to end.
        while (!quiet && ready.length > 0 && limitLiftsAt(sentAt, at) === null) {
          const write = ready.shift() as (sentNow: number) => Content;
          sentAt.push(at);
          send(write(at));
        }
        const schedule = reminderSchedule(rules.longWait);
        for (const [id, begunAt] of open) {
          // Still open as far as this snapshot shows. A session whose source did
          // not answer this time is not in it, and is held until it is.
          const session = snapshot.sessions.find(
            (candidate) => candidate.id === id && needsYou(candidate),
          );
          if (!session) continue;
          const timing = sendTiming(begunAt, afterMs, sentAt, at);
          if (timing === "wait") continue;
          if (quiet) {
            // Due, in quiet hours: held, and sent when they end if it is still open.
            open.delete(id);
            hold.holdWait(session, begunAt);
            continue;
          }
          if (timing === "limited") continue;

          open.delete(id);
          sentAt.push(at);
          send(
            waitMessage({
              session: withoutWaitingText(session),
              agent: agentName(session, snapshot.sources),
              // Read now, from this poll's snapshot, and only when it is to go.
              asking: asking ? (waitingText(session.waitingText) ?? null) : null,
              begunAt,
              now: at,
            }),
          );
          // What it says has the time it has waited, so a reminder would say nothing new.
          if (rules.longWait.on) reminders.told(id, at);
        }

        if (rules.longWait.on && wanted.has("needs-you")) {
          // Only a wait already sent, or open when the collector started, is reminded of.
          for (const due of reminders.due(snapshot, at, schedule, (id) => !open.has(id))) {
            if (quiet) {
              // Held as its wait, and reminded of when they end if it is still open.
              hold.holdReminder(due.session, due.begunAt);
              continue;
            }
            if (limitLiftsAt(sentAt, at) !== null) break;
            sentAt.push(at);
            reminders.told(due.session.id, at);
            send(
              reminderMessage({
                session: withoutWaitingText(due.session),
                agent: agentName(due.session, snapshot.sources),
                asking: asking ? (waitingText(due.session.waitingText) ?? null) : null,
                begunAt: due.begunAt,
                now: at,
                thresholdMs: schedule.thresholdMs,
                everyMs: schedule.everyMs,
                repeat: due.repeat,
              }),
            );
          }
        }

        // A wait seen now and not open was sent, or was open at the start.
        for (const session of snapshot.sessions) {
          if (needsYou(session) && session.statusSince !== null && !open.has(session.id)) {
            done.set(session.id, session.statusSince);
          }
        }
      } catch {
        // Whatever went wrong is this module's. The poll's answer stands.
      }
    },

    last: () => last,
    limitedUntil: () => limitLiftsAt(sentAt, now()),
    settled: () => queue,
  };
}
