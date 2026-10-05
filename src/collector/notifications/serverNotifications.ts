import type { NotificationsSaid } from "../../core/api.ts";
import type { Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import { waitNotice } from "../../core/sessions/waiting.ts";
import {
  EMPTY_WAIT_MEMORY,
  waitChanges,
  type WaitMemory,
} from "../../core/sessions/waitChanges.ts";
import { heldWaitOutcome, noPageReports, type PageReports } from "./heldWait.ts";
import type { SystemNotifier } from "./systemNotifier.ts";

/**
 * The collector's own notifications: one when a session starts waiting for the
 * person and no dashboard page is going to show it.
 *
 * Which waits are announced is decided by `waitChanges` in the core, the rule
 * the dashboard page runs over the same snapshots: nothing for a session that
 * was already waiting when the collector started, and one notification for
 * each wait that begins after that.
 *
 * Whether they are on is not kept on disk. Each dashboard page says, in a
 * header on every request, whether its own notifications are on, and the last
 * thing a page said holds for as long as the collector runs. So the switch in
 * Settings turns these off too, at the page's next request. Until a page has
 * said anything they are off, unless `AGENT_LOOKOUT_NOTIFICATIONS=on` was set
 * when the collector started.
 *
 * A wait is held back for a moment before it is shown, so that a page that is
 * open shows it and the collector does not show it as well. `heldWait.ts` has
 * that timing.
 *
 * A notification shown here cannot be taken down again, so a wait that ends is
 * only forgotten.
 */
export interface ServerNotifications {
  /**
   * A dashboard page said, on a request, whether its notifications are on.
   * `fetchedSessions` is true when the request was for the sessions, which is
   * how a page learns of a wait.
   */
  pageSaid(said: NotificationsSaid, fetchedSessions: boolean): void;
  /** Takes each snapshot the poller produces, and decides the waits being held. */
  handle(snapshot: SessionsSnapshot): void;
}

/** The setting that, set to `on`, turns these on before any page has said anything. */
export const NOTIFICATIONS_ENV = "AGENT_LOOKOUT_NOTIFICATIONS";

/** Whether the environment turns notifications on from the start. */
export function notificationsOnAtStart(env: NodeJS.ProcessEnv): boolean {
  return env[NOTIFICATIONS_ENV]?.trim().toLowerCase() === "on";
}

export interface ServerNotificationsOptions {
  notifier: SystemNotifier;
  /** Whether notifications are on before any page has said anything. */
  onAtStart: boolean;
  now?: () => number;
}

/** A wait whose notification is being held back, and when it was first seen. */
interface HeldWait {
  session: Session;
  since: number;
}

export function createServerNotifications(
  options: ServerNotificationsOptions,
): ServerNotifications {
  const { notifier } = options;
  const now = options.now ?? Date.now;

  let memory: WaitMemory = EMPTY_WAIT_MEMORY;
  let pages: PageReports = noPageReports(options.onAtStart);
  /** The waits not yet shown or dropped, by session id. */
  const held = new Map<string, HeldWait>();

  function show(session: Session): void {
    try {
      notifier.show(waitNotice(session));
    } catch {
      // A notifier should not throw. One that does must not stop the poll.
    }
  }

  return {
    pageSaid(said, fetchedSessions) {
      const at = now();
      if (said === "off") {
        pages = { ...pages, on: false };
        return;
      }
      pages = {
        on: true,
        lastOnAt: at,
        lastOnSessionsAt: fetchedSessions ? at : pages.lastOnSessionsAt,
      };
    },

    handle(snapshot) {
      const at = now();
      // Waits are followed while notifications are off as well. Turning them on
      // then says nothing about a wait that had already begun.
      const changes = waitChanges(memory, snapshot);
      memory = changes.memory;

      // A wait that ended while it was held is never shown.
      for (const id of changes.stopped) held.delete(id);
      for (const session of changes.started) {
        if (pages.on) held.set(session.id, { session, since: at });
      }

      for (const [id, wait] of held) {
        const outcome = heldWaitOutcome(wait.since, pages, at);
        if (outcome === "hold") continue;
        held.delete(id);
        if (outcome === "show") show(wait.session);
      }
    },
  };
}
