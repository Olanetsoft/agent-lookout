import type { Session, SessionsSnapshot, SourceId } from "@core/sessions/session";
import { EMPTY_WAIT_MEMORY, waitChanges, type WaitMemory } from "@core/sessions/waitChanges";
import type {
  NotificationHost,
  ShownNotification,
} from "@dashboard/lib/notifications/notificationHost";
import { waitingLabel } from "@dashboard/lib/sessions/status";

/**
 * Turns the snapshots the page receives into notifications: one when a session
 * starts waiting for the person, taken down when that session moves on.
 *
 * Which change deserves a notification, and which notification to take down,
 * is decided by `waitChanges` in the core. This only carries it out. It has no
 * DOM in it, so it runs the same under any notification host.
 *
 * A session of a source that stops answering keeps its notification, because
 * nobody knows whether it still waits. It is taken down when the source answers
 * again without it, when notifications are turned off, or when the page closes.
 *
 * A collector that has been stopped and started again under a page left open is
 * a new beginning. What it finds waiting was waiting before it began, so
 * nothing in its first answers is announced, exactly as when the page itself
 * has just opened.
 */

export interface WaitNotifierOptions {
  host: Pick<NotificationHost, "show">;
  /** Whether a notification may be sent, asked at the moment one would be. */
  isOn: () => boolean;
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
  /** Takes down every notification still on show, and says which sessions they were for. */
  closeAll(): string[];
  /**
   * Shows the notifications of these sessions again, for those that are still
   * waiting as far as this page knows. It is for the notifications another page
   * at this address had on show and took down as it left. A session that has
   * moved on, or that this page has never seen, is passed over.
   */
  showAgain(sessionIds: readonly string[]): void;
}

/** A notification on show, and the source its session came from. */
interface OpenNotification {
  notification: ShownNotification;
  source: SourceId;
}

/** One notification per session, so the same wait seen from two tabs shows once. */
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
  let memory: WaitMemory = EMPTY_WAIT_MEMORY;
  /** When the collector whose answers are remembered began. Null until that is known. */
  let collector: number | null = null;
  /** The last snapshot taken: the name and the reason of a session shown again come from it. */
  let latest: SessionsSnapshot | null = null;
  /** The notifications on show, by session id. */
  const open = new Map<string, OpenNotification>();

  function close(id: string): void {
    const shown = open.get(id);
    if (!shown) return;
    open.delete(id);
    closeSafely(shown.notification);
  }

  function show(session: Session): void {
    // A session has one notification at a time.
    close(session.id);
    let shown: ShownNotification | null;
    try {
      // The name, and the reason in the words the Needs you panel uses.
      shown = host.show({
        title: session.name,
        body: waitingLabel(session),
        tag: tagFor(session),
      });
    } catch {
      // A host should not throw. One that does must not stop the next notification.
      shown = null;
    }
    if (!shown) return;
    const notification = shown;
    open.set(session.id, { notification, source: session.source });
    // Once the person has dismissed it there is nothing left to take down.
    notification.onClosed(() => {
      if (open.get(session.id)?.notification === notification) open.delete(session.id);
    });
  }

  return {
    handle(snapshot, collectorStartedAt = null) {
      if (!snapshot) return;
      latest = snapshot;
      if (collectorStartedAt !== null) {
        // Another collector. Forgetting what the last one said makes each
        // source's next answer its first, which announces nothing.
        if (collector !== null && collector !== collectorStartedAt) memory = EMPTY_WAIT_MEMORY;
        collector = collectorStartedAt;
      }

      // Waits are followed while notifications are off as well. Turning them on
      // then says nothing about a wait that had already begun.
      const changes = waitChanges(memory, snapshot);
      memory = changes.memory;
      for (const id of changes.stopped) close(id);
      // A notification left from before a new collector began is not among
      // those. It goes once its source has answered without its session waiting.
      for (const [id, { source }] of open) {
        const waiting = memory.get(source);
        if (waiting && !waiting.has(id)) close(id);
      }
      for (const session of changes.started) {
        if (isOn()) show(session);
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
      if (!latest) return;
      const wanted = new Set(sessionIds);
      for (const session of latest.sessions) {
        if (!wanted.has(session.id) || session.status !== "needs-you") continue;
        // Waiting at its source's last answer, which is what would keep it on show here.
        if (!memory.get(session.source)?.has(session.id)) continue;
        wanted.delete(session.id);
        if (isOn()) show(session);
      }
    },
  };
}
