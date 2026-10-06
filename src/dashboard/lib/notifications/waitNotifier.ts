import {
  withoutWaitingText,
  type Session,
  type SessionsSnapshot,
  type SourceId,
} from "@core/sessions/session";
import { changeNotice, type Notice } from "@core/notices/waiting";
import {
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
  type NoticeEvent,
  type SessionChange,
} from "@core/notices/sessionChanges";
import { createQuietHold } from "@core/time-rules/quietHold";
import { quietOf } from "@core/time-rules/quietHours";
import { createReminderWatch } from "@core/time-rules/reminders";
import { rulesOf } from "@core/time-rules/timeRules";
import { reminderNotice, summaryNotice } from "@core/time-rules/timeRulesWords";
import type {
  NotificationHost,
  ShownNotification,
} from "@dashboard/lib/notifications/notificationHost";

/**
 * Turns the snapshots the page receives into notifications: one when a session
 * starts waiting for the person, taken down when that session moves on, and
 * one when a session finishes, fails or ends, which stays until the person
 * clears it. A session has one notification at a time: a later one for it
 * takes the place of the earlier.
 *
 * What happened, and which wait's notification to take down, is decided by
 * `sessionChanges` in the core. This only carries it out. It has no DOM in it,
 * so it runs the same under any notification host.
 *
 * A session of a source that stops answering keeps the notification of its
 * wait, because nobody knows whether it still waits. It is taken down when the
 * source answers again without it, when notifications are turned off, or when
 * the page closes.
 *
 * A collector that has been stopped and started again under a page left open is
 * a new beginning. What it finds waiting was waiting before it began, so
 * nothing in its first answers is announced, exactly as when the page itself
 * has just opened.
 *
 * The time rules each snapshot carries apply on top of the switches, at the
 * snapshot's own moment, by the rules the collector follows for its own
 * notifications, and quiet hours by what the collector said of them in the
 * snapshot, by its own clock. With the long wait reminder on, a wait this page saw before it
 * had lasted the rule's minutes is reminded of once it has, in the place of
 * its notification. During quiet hours nothing is shown: what would have been
 * is held, and when they end a wait still open is shown as usual and the rest
 * in one notification, "While quiet", which stays until the person clears it.
 * A page opened during quiet hours sums up what it has seen since.
 */

export interface WaitNotifierOptions {
  host: Pick<NotificationHost, "show">;
  /** Whether a notification of this event may be sent, asked at the moment one would be. */
  isOn: (event: NoticeEvent) => boolean;
}

export interface WaitNotifier {
  /**
   * Takes the page's latest snapshot. Null, from before the first answer, is
   * ignored.
   *
   * `collectorStartedAt` is when the collector that gave the answer began, or
   * null while that is not known. When it is no longer what it was, another
   * collector has taken the place of the last one, and this starts again from
   * its answers.
   */
  handle(snapshot: SessionsSnapshot | null, collectorStartedAt?: number | null): void;
  /**
   * Takes down every notification of a wait still on show, and says which
   * sessions they were for. A notification that a session finished, failed or
   * ended is the person's to clear, and is left.
   */
  closeAll(): string[];
  /**
   * Shows the notifications of these sessions again, for those that are still
   * waiting as far as this page knows. It is for the notifications another page
   * at this address had on show and took down as it left. A session that has
   * moved on, or that this page has never seen, is passed over.
   */
  showAgain(sessionIds: readonly string[]): void;
}

/** The tag of the one notification that sums up quiet hours. */
export const SUMMARY_TAG = "agent-lookout:while-quiet";

/** A notification of a wait on show, and the source its session came from. */
interface OpenNotification {
  notification: ShownNotification;
  source: SourceId;
}

/**
 * One notification per session, so the same wait seen from two tabs shows
 * once, and a session that finishes after it waited has the one notification.
 */
function tagFor(session: Session): string {
  return `agent-lookout:${session.id}`;
}

function closeSafely(notification: ShownNotification): void {
  try {
    notification.close();
  } catch {
    // A host should not throw. One that does must not stop the others being closed.
  }
}

export function createWaitNotifier({ host, isOn }: WaitNotifierOptions): WaitNotifier {
  let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
  /** When the collector whose answers are remembered began. Null until that is known. */
  let collector: number | null = null;
  /** The last snapshot taken: the name and the reason of a session shown again come from it. */
  let latest: SessionsSnapshot | null = null;
  /** The notifications of waits on show, by session id. */
  const open = new Map<string, OpenNotification>();
  /**
   * The last notification that a session finished, failed or ended, by session
   * id, while it is on show. Only a later notification for the same session
   * takes it down.
   */
  const over = new Map<string, ShownNotification>();
  /** The waits that could be reminded of, and those already reminded. */
  const reminders = createReminderWatch();
  /** What quiet hours hold back. */
  const quiet = createQuietHold();
  /** Whether the last snapshot fell in quiet hours. */
  let quietLast = false;

  function close(id: string): void {
    const shown = open.get(id);
    if (!shown) return;
    open.delete(id);
    closeSafely(shown.notification);
  }

  function show(change: SessionChange, notice: Notice = changeNotice(change)): void {
    const { session } = change;
    // A session has one notification at a time. The one on show is taken down
    // first, because a browser that puts a notification in the place of
    // another with the same tag does it silently, and the new one would make
    // no sound.
    close(session.id);
    const earlier = over.get(session.id);
    if (earlier) {
      over.delete(session.id);
      closeSafely(earlier);
    }
    let shown: ShownNotification | null;
    try {
      // The name, and the reason in the words the Needs you panel uses with
      // what the session is asking when that is known, or what happened. The
      // collector's own notification says the same.
      shown = host.show({ ...notice, tag: tagFor(session) });
    } catch {
      // A host should not throw. One that does must not stop the next notification.
      shown = null;
    }
    if (!shown) return;
    const notification = shown;
    if (change.event !== "needs-you") {
      // Left for the person to clear, unless the session has news again first.
      over.set(session.id, notification);
      notification.onClosed(() => {
        if (over.get(session.id) === notification) over.delete(session.id);
      });
      return;
    }
    // A wait's notification is also taken down when the wait ends.
    open.set(session.id, { notification, source: session.source });
    // Once the person has dismissed it there is nothing left to take down.
    notification.onClosed(() => {
      if (open.get(session.id)?.notification === notification) open.delete(session.id);
    });
  }

  /** The one notification that sums up quiet hours, left for the person to clear. */
  function showSummary(notice: Notice): void {
    try {
      host.show({ ...notice, tag: SUMMARY_TAG });
    } catch {
      // As above: the next notification still goes.
    }
  }

  /** Holds a change back through quiet hours. */
  function holdQuietly(change: SessionChange, at: number): void {
    const { event, session } = change;
    if (event === "needs-you") {
      const since = session.statusSince;
      quiet.holdWait(session, since !== null && since <= at ? since : at);
    } else {
      quiet.holdOver(event, withoutWaitingText(session), at);
    }
  }

  return {
    handle(snapshot, collectorStartedAt = null) {
      if (!snapshot) return;
      latest = snapshot;
      if (collectorStartedAt !== null) {
        // Another collector. Forgetting what the last one said makes each
        // source's next answer its first, which announces nothing.
        if (collector !== null && collector !== collectorStartedAt) {
          memory = EMPTY_CHANGE_MEMORY;
          reminders.clear();
        }
        collector = collectorStartedAt;
      }

      const at = snapshot.generatedAt;
      const rules = rulesOf(snapshot);
      // By the collector's clock, as it said in the snapshot, not this browser's.
      const quietNow = quietOf(snapshot);
      quietLast = quietNow;
      const thresholdMs = rules.longWait.minutes * 60_000;

      // Changes are followed while notifications are off as well. Turning them
      // on then says nothing about what had already happened.
      const result = sessionChanges(memory, snapshot);
      memory = result.memory;
      for (const id of result.stopped) {
        close(id);
        quiet.waitEnded(id, at);
      }
      reminders.observe(snapshot, result.stopped, at);
      // A notification left from before a new collector began is not among
      // those. It goes once its source has answered without its session waiting.
      for (const [id, { source }] of open) {
        const waiting = memory.waits.get(source);
        if (waiting && !waiting.has(id)) close(id);
      }

      if (quiet.holding() && !quietNow) {
        // The quiet hours are over: one summary, and each wait still open as usual.
        const end = quiet.end(snapshot, at, rules.quietHours.leaveOutAnswered);
        const items = end.summary?.items.filter((item) => isOn(item.event)) ?? [];
        if (items.length > 0) showSummary(summaryNotice(items));
        if (isOn("needs-you")) {
          for (const { session } of end.open) {
            show({ event: "needs-you", session });
            if (rules.longWait.on) reminders.toldLate(session.id, at, thresholdMs);
          }
        }
      }
      if (quietNow) quiet.begin(at);

      for (const change of result.changes) {
        if (!isOn(change.event)) continue;
        if (quietNow) holdQuietly(change, at);
        else show(change);
      }

      if (!quietNow && rules.longWait.on && isOn("needs-you")) {
        for (const due of reminders.due(snapshot, at, thresholdMs)) {
          reminders.reminded(due.session.id, thresholdMs);
          // In the place of the wait's own notification, and taken down when the wait ends.
          show(
            { event: "needs-you", session: due.session },
            reminderNotice(due.session, due.waitedMs),
          );
        }
      }
    },

    closeAll() {
      const ids = [...open.keys()];
      const notifications = [...open.values()];
      open.clear();
      for (const { notification } of notifications) closeSafely(notification);
      return ids;
    },

    showAgain(sessionIds) {
      // In quiet hours nothing is shown. A wait still open when they end is.
      if (!latest || quietLast) return;
      const wanted = new Set(sessionIds);
      for (const session of latest.sessions) {
        if (!wanted.has(session.id) || session.status !== "needs-you") continue;
        // Waiting at its source's last answer, which is what would keep it on show here.
        if (!memory.waits.get(session.source)?.has(session.id)) continue;
        wanted.delete(session.id);
        if (isOn("needs-you")) show({ event: "needs-you", session });
      }
    },
  };
}
