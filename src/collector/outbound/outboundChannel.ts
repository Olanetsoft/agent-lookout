import type { SendResult } from "../../core/api.ts";
import type { Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
  type NoticeEvent,
} from "../../core/sessions/waitChanges.ts";
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
  /** When the wait began. */
  begunAt: number;
  /** When the email or post is written. */
  now: number;
}

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
  /** What is sent for a wait. */
  waitMessage(facts: WaitFacts): Content;
  /** What is sent for a session that finished, failed or ended. */
  overMessage(facts: OverFacts): Content;
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

/** The agent a session belongs to: a status file names its own, and every other source is its own agent. */
function agentOf(session: Session, snapshot: SessionsSnapshot): string | null {
  return (
    session.agent ?? snapshot.sources.find((source) => source.id === session.source)?.label ?? null
  );
}

export function createOutboundChannel<Content>(
  options: OutboundChannelOptions<Content>,
): OutboundChannel {
  const { afterMs, waitMessage, overMessage, failure } = options;
  const now = options.now ?? Date.now;

  const wanted = new Set(options.events);
  let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
  /** The sessions that finished, failed or ended and are not yet sent, oldest first. */
  const over: Omit<OverFacts, "now">[] = [];
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
          // A wait not yet sent that missed a poll comes back with the time it
          // began, and keeps its place.
          open.set(session.id, waitBegan(since, at));
        }

        sentAt = sendsInLastHour(sentAt, at);
        // Due as soon as they are seen. The hourly limit can hold them, and
        // then they go in turn as it lets each one go, before any wait.
        while (over.length > 0 && limitLiftsAt(sentAt, at) === null) {
          const facts = over.shift() as Omit<OverFacts, "now">;
          sentAt.push(at);
          send(overMessage({ ...facts, now: at }));
        }
        for (const [id, begunAt] of open) {
          // Still open as far as this snapshot shows. A session whose source did
          // not answer this time is not in it, and is held until it is.
          const session = snapshot.sessions.find(
            (candidate) => candidate.id === id && candidate.status === "needs-you",
          );
          if (!session || sendTiming(begunAt, afterMs, sentAt, at) !== "send") continue;

          open.delete(id);
          sentAt.push(at);
          send(waitMessage({ session, agent: agentOf(session, snapshot), begunAt, now: at }));
        }

        // A wait seen now and not open was sent, or was open at the start.
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

    last: () => last,
    limitedUntil: () => limitLiftsAt(sentAt, now()),
    settled: () => queue,
  };
}
