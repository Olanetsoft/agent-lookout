import type { NoticeEvent } from "../notices/sessionChanges.ts";
import { withoutWaitingText, type Session, type SessionsSnapshot } from "../sessions/session.ts";
import { needsYou } from "../waits/answeredWaits.ts";

/**
 * What one channel holds back during quiet hours, and what it says when they
 * end. Each channel keeps its own: the page's notifications, the collector's,
 * email, the webhook, ntfy and Pushover. Each holds what it would have sent, by its own
 * rules: a wait email only once the wait has lasted the email's delay, a
 * notification at once.
 *
 * When the quiet hours end, a wait that is still open is told of as usual,
 * and the rest goes in one summary: the waits that were answered, with how
 * long each waited, unless the person leaves those out, and every session
 * that finished, failed or ended. A session that waited and then finished,
 * failed or ended is one item. With nothing to say, there is no summary.
 *
 * A wait is still open when its session waits now with the status time the
 * wait began at, even one that was seen to end: a session that reads as
 * another status for one poll, or that a poll misses, comes back so. It is
 * told of once, and is not in the summary. A wait Agent Lookout answered is
 * not open, whatever its source still says (`needsYou` in `answeredWaits.ts`).
 *
 * A long wait's reminder that comes due in quiet hours, for a wait told of
 * before them, holds that wait too, once however many come due. Answered or
 * ended before they end, it is in the summary as one item, as any wait held.
 * Still open, it is left to its reminder, which says how long it has waited
 * by then, and is not told of again as a wait.
 *
 * Nothing held keeps what a waiting session was asking. A wait still open at
 * the end is told of from the session as it is then.
 */

type OverEvent = Exclude<NoticeEvent, "needs-you">;

/** One line of a summary: a session's waits, or its finish, failure or end. */
export type SummaryItem =
  | {
      event: "needs-you";
      session: Session;
      /** When its first wait in the quiet hours began. */
      at: number;
      /** How long its waits lasted, in all. */
      waitedMs: number;
      /** How many times it waited. */
      times: number;
      /** What it did after its last wait began, when it finished, failed or ended in the quiet hours. */
      then?: { event: OverEvent; at: number };
    }
  | {
      event: OverEvent;
      session: Session;
      /** When it was seen to happen. */
      at: number;
    };

/** What was held through one stretch of quiet hours, as a summary says it. */
export interface QuietSummary {
  /** When this channel saw quiet hours begin. A wait that began before them can be older. */
  from: number;
  /** When it saw them end. */
  to: number;
  /** Oldest first. Never empty. */
  items: SummaryItem[];
}

/** What a channel does when quiet hours end. */
export interface QuietEnd {
  /** The summary to send, or null when there is nothing to say. */
  summary: QuietSummary | null;
  /**
   * The waits held that are still open, each to be told of as usual: the
   * session as it is now. A wait held for its reminder alone is not among them.
   */
  open: { session: Session; begunAt: number }[];
}

export interface QuietHold {
  /** Whether quiet hours are under way, as this channel has seen them. */
  holding(): boolean;
  /** Notes that this moment is in quiet hours. The first such moment begins them. */
  begin(at: number): void;
  /** Holds back a wait, which began at `begunAt`. */
  holdWait(session: Session, begunAt: number): void;
  /**
   * Holds back a reminder of a wait told of before quiet hours, which began at
   * `begunAt`. A wait held already is held as it was.
   */
  holdReminder(session: Session, begunAt: number): void;
  /** Holds back a session that finished, failed or ended, seen at `at`. */
  holdOver(event: OverEvent, session: Session, at: number): void;
  /** A session's wait ended, at `at`. A held wait of it is answered. */
  waitEnded(sessionId: string, at: number): void;
  /** Whether a wait of this session is held and has not ended. */
  holdsWait(sessionId: string): boolean;
  /** The quiet hours are over: what to tell, worked out from the snapshot now. Forgets it all. */
  end(snapshot: SessionsSnapshot, at: number, leaveOutAnswered: boolean): QuietEnd;
}

interface HeldWait {
  session: Session;
  begunAt: number;
  endedAt: number | null;
  /** Held for its reminder alone: told of before quiet hours, so not told of again as a wait. */
  reminderOnly: boolean;
}

export function createQuietHold(): QuietHold {
  let since: number | null = null;
  let waits: HeldWait[] = [];
  let over: { event: OverEvent; session: Session; at: number }[] = [];

  const openWaitOf = (sessionId: string) =>
    waits.find((wait) => wait.session.id === sessionId && wait.endedAt === null);
  const lastWaitOf = (sessionId: string) => {
    for (let index = waits.length - 1; index >= 0; index -= 1) {
      const wait = waits[index] as HeldWait;
      if (wait.session.id === sessionId) return wait;
    }
    return undefined;
  };

  return {
    holding: () => since !== null,

    begin(at) {
      since ??= at;
    },

    holdWait(session, begunAt) {
      // The same wait seen again, as after a poll its source missed or one in
      // which it read as another status, is held once, and is open again.
      const last = lastWaitOf(session.id);
      if (last?.begunAt === begunAt) {
        last.endedAt = null;
        last.reminderOnly = false;
        return;
      }
      if (last && last.endedAt === null) last.endedAt = begunAt;
      waits.push({
        session: withoutWaitingText(session),
        begunAt,
        endedAt: null,
        reminderOnly: false,
      });
    },

    holdReminder(session, begunAt) {
      // Each reminder that comes due is the same wait, held once.
      const last = lastWaitOf(session.id);
      if (last?.begunAt === begunAt) {
        last.endedAt = null;
        return;
      }
      if (last && last.endedAt === null) last.endedAt = begunAt;
      waits.push({
        session: withoutWaitingText(session),
        begunAt,
        endedAt: null,
        reminderOnly: true,
      });
    },

    holdOver(event, session, at) {
      over.push({ event, session: withoutWaitingText(session), at });
    },

    waitEnded(sessionId, at) {
      const held = openWaitOf(sessionId);
      if (held) held.endedAt = at;
    },

    holdsWait: (sessionId) => openWaitOf(sessionId) !== undefined,

    end(snapshot, at, leaveOutAnswered) {
      const listed = new Map(snapshot.sessions.map((session) => [session.id, session]));
      // Each session's wait still open: one whose end was not seen, or one
      // seen to end that is back with the status time it began at.
      const stillOpen = new Map<string, HeldWait>();
      for (const wait of waits) {
        const now = listed.get(wait.session.id);
        if (now === undefined || !needsYou(now)) continue;
        if (wait.endedAt === null || now.statusSince === wait.begunAt) {
          stillOpen.set(wait.session.id, wait);
        }
      }
      const open: QuietEnd["open"] = [];
      for (const [id, wait] of stillOpen) {
        // Its reminder tells of it, as one held for a reminder alone.
        if (wait.reminderOnly) continue;
        open.push({ session: listed.get(id) as Session, begunAt: wait.begunAt });
      }

      const answered = new Map<string, Extract<SummaryItem, { event: "needs-you" }>>();
      /** When each session's last wait in the summary began. */
      const lastBegun = new Map<string, number>();
      for (const wait of waits) {
        // Told of as usual, however many times it was held.
        if (stillOpen.get(wait.session.id)?.begunAt === wait.begunAt) continue;
        if (leaveOutAnswered) continue;
        // A wait whose end nobody saw, as when its source stopped answering, is counted to now.
        const waitedMs = Math.max(0, (wait.endedAt ?? at) - wait.begunAt);
        lastBegun.set(wait.session.id, wait.begunAt);
        const item = answered.get(wait.session.id);
        if (item) {
          item.waitedMs += waitedMs;
          item.times += 1;
        } else {
          answered.set(wait.session.id, {
            event: "needs-you",
            session: wait.session,
            at: wait.begunAt,
            waitedMs,
            times: 1,
          });
        }
      }

      // A session that waited and then finished, failed or ended is said once:
      // "checkout-flow waited 25 minutes then ended".
      const rest: SummaryItem[] = [];
      for (const item of over) {
        const waited = answered.get(item.session.id);
        const begun = lastBegun.get(item.session.id);
        if (waited && waited.then === undefined && begun !== undefined && item.at >= begun) {
          waited.then = { event: item.event, at: item.at };
        } else {
          rest.push(item);
        }
      }

      const items: SummaryItem[] = [...answered.values(), ...rest].sort((a, b) => a.at - b.at);
      const from = since ?? at;
      since = null;
      waits = [];
      over = [];
      return { summary: items.length > 0 ? { from, to: at, items } : null, open };
    },
  };
}
