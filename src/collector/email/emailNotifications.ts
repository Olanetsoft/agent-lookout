import type { EmailOutcome, EmailStatusResponse } from "../../core/api.ts";
import type { Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
} from "../../core/sessions/waitChanges.ts";
import { overEmail, waitEmail, type EmailContent, type OverFacts } from "./emailMessage.ts";
import { maskAddress, type EmailSettings } from "./emailSettings.ts";
import { emailTiming, limitLiftsAt, sendsInLastHour, waitBegan } from "./emailTiming.ts";
import type { EmailSender } from "./smtpSender.ts";

/**
 * Email notifications: one short email for each of the events the person
 * chose, through the mail server they named. The collector builds this only
 * when email has been set up in the environment.
 *
 * What happened is decided by `sessionChanges` in the core, the rule the
 * dashboard and the collector's own notifications run over the same
 * snapshots: nothing for what was already true when the collector started,
 * and one for each change after that. A wait is emailed once it has lasted the
 * delay, if it is still open. A session that finished, failed or ended is
 * emailed at once. `emailTiming.ts` has the timing, and the hourly limit,
 * which covers every email. Each is tried once. One that could not be sent is
 * not tried again, and the status says why.
 *
 * Nothing here can stop a poll. `handle` never throws, and an email is sent
 * after the poll has moved on, one at a time.
 *
 * The browser notifications' switch in Settings does not cover this. Email is
 * turned off by starting the collector without its settings.
 */
export interface EmailNotifications {
  /** Takes each snapshot the poller produces, and sends what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** What `GET /api/email` answers. */
  status(): EmailStatusResponse;
  /** Resolves once every email handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export interface EmailNotificationsOptions {
  settings: EmailSettings;
  sender: EmailSender;
  now?: () => number;
}

/** What `GET /api/email` answers while email is off. */
export function emailOffStatus(problem: string | null): EmailStatusResponse {
  return {
    on: false,
    to: null,
    events: null,
    afterMs: null,
    problem,
    last: null,
    limitedUntil: null,
  };
}

/** The agent a session belongs to: a status file names its own, and every other source is its own agent. */
function agentOf(session: Session, snapshot: SessionsSnapshot): string | null {
  return (
    session.agent ?? snapshot.sources.find((source) => source.id === session.source)?.label ?? null
  );
}

export function createEmailNotifications(options: EmailNotificationsOptions): EmailNotifications {
  const { settings, sender } = options;
  const now = options.now ?? Date.now;

  const wanted = new Set(settings.events);
  let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
  /** The sessions that finished, failed or ended and are not yet emailed, oldest first. */
  const over: Omit<OverFacts, "now">[] = [];
  /** The waits not yet emailed, by session id, with when each began. */
  const open = new Map<string, number>();
  /**
   * The status time of the wait last seen for each session that is not to be
   * emailed: one already emailed, or one that was open when the collector
   * started. A session that misses a poll, or reads as another status for one,
   * comes back as a wait that started. With the same status time it is the
   * same wait, and is not emailed again. Entries are kept when a wait stops,
   * for that reason.
   */
  const done = new Map<string, number>();
  /** When each email of the last hour was tried. */
  let sentAt: number[] = [];
  let last: EmailOutcome | null = null;
  /** The emails go one after another, never side by side. */
  let queue: Promise<void> = Promise.resolve();

  function send(content: EmailContent): void {
    queue = queue
      .then(() => sender.send(content))
      .then(
        (outcome) => {
          last = outcome.sent
            ? { at: now(), sent: true }
            : { at: now(), sent: false, reason: outcome.reason };
        },
        () => {
          // A sender should not reject. One that does is a failure like any other.
          last = { at: now(), sent: false, reason: "the email could not be sent" };
        },
      );
  }

  return {
    handle(snapshot) {
      try {
        const at = now();
        const result = sessionChanges(memory, snapshot);
        memory = result.memory;

        for (const id of result.stopped) open.delete(id);
        for (const { event, session } of result.changes) {
          if (!wanted.has(event)) continue;
          if (event !== "needs-you") {
            over.push({ event, session, agent: agentOf(session, snapshot), seenAt: at });
            continue;
          }
          const since = session.statusSince;
          if (since !== null && done.get(session.id) === since) continue;
          // A wait not yet emailed that missed a poll comes back with the time it
          // began, and keeps its place.
          open.set(session.id, waitBegan(since, at));
        }

        sentAt = sendsInLastHour(sentAt, at);
        // Due as soon as they are seen. The hourly limit can hold them, and
        // then they go in turn as it lets each one go, before any wait.
        while (over.length > 0 && limitLiftsAt(sentAt, at) === null) {
          const facts = over.shift() as Omit<OverFacts, "now">;
          sentAt.push(at);
          send(overEmail({ ...facts, now: at }));
        }
        for (const [id, begunAt] of open) {
          // Still open as far as this snapshot shows. A session whose source did
          // not answer this time is not in it, and is held until it is.
          const session = snapshot.sessions.find(
            (candidate) => candidate.id === id && candidate.status === "needs-you",
          );
          if (!session || emailTiming(begunAt, settings.afterMs, sentAt, at) !== "send") continue;

          open.delete(id);
          sentAt.push(at);
          send(waitEmail({ session, agent: agentOf(session, snapshot), begunAt, now: at }));
        }

        // A wait seen now and not open was emailed, or was open at the start.
        for (const session of snapshot.sessions) {
          if (
            session.status === "needs-you" &&
            session.statusSince !== null &&
            !open.has(session.id)
          ) {
            done.set(session.id, session.statusSince);
          }
        }
      } catch {
        // Whatever went wrong is this module's. The poll's answer stands.
      }
    },

    status() {
      return {
        on: true,
        to: maskAddress(settings.to),
        events: [...settings.events],
        afterMs: settings.afterMs,
        problem: null,
        last,
        limitedUntil: limitLiftsAt(sentAt, now()),
      };
    },

    settled: () => queue,
  };
}
