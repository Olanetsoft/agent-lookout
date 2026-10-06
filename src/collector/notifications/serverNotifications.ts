import type { NotificationsSaid } from "../../core/api.ts";
import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { changeNotice } from "../../core/notices/waiting.ts";
import {
  DEFAULT_NOTICE_EVENTS,
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
  type NoticeEvent,
  type SessionChange,
} from "../../core/notices/sessionChanges.ts";
import { heldWaitOutcome, noPageReports, type PageReports } from "./heldWait.ts";
import type { SystemNotifier } from "./systemNotifier.ts";

/**
 * The collector's own notifications: one for each event the person chose, a
 * session starting to wait, finishing, failing or ending, that no dashboard
 * page is going to show.
 *
 * What happened is decided by `sessionChanges` in the core, the rule the
 * dashboard page runs over the same snapshots: nothing for what was already
 * true when the collector started, and one notification for each change after
 * that.
 *
 * Whether they are on, and for which events, is not kept on disk. Each
 * dashboard page says, in a header on every request, which events its own
 * notifications are on for, and the last thing a page said holds for as long
 * as the collector runs. So the switches in Settings cover these too, at the
 * page's next request. Until a page has said anything they are off, unless
 * `AGENT_LOOKOUT_NOTIFICATIONS=on` was set when the collector started, which
 * turns them on for a wait alone.
 *
 * Every notification is held back for a moment before it is shown, so that a
 * page that is open shows it and the collector does not show it as well.
 * `heldWait.ts` has that timing.
 *
 * A notification shown here cannot be taken down again, so a wait that ends is
 * only forgotten.
 */
export interface ServerNotifications {
  /**
   * A dashboard page said, on a request, which events its notifications are on
   * for. `fetchedSessions` is true when the request was for the sessions, which
   * is how a page learns of a change.
   */
  pageSaid(said: NotificationsSaid, fetchedSessions: boolean): void;
  /** Takes each snapshot the poller produces, and decides the notifications being held. */
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
  /** Whether notifications are on, for a wait alone, before any page has said anything. */
  onAtStart: boolean;
  now?: () => number;
}

/** A change whose notification is being held back, and when it was first seen. */
interface HeldChange {
  change: SessionChange;
  since: number;
}

/** One held notification for each event of each session. */
function heldKey(event: NoticeEvent, sessionId: string): string {
  return `${event} ${sessionId}`;
}

export function createServerNotifications(
  options: ServerNotificationsOptions,
): ServerNotifications {
  const { notifier } = options;
  const now = options.now ?? Date.now;

  let memory: ChangeMemory = EMPTY_CHANGE_MEMORY;
  let pages: PageReports = noPageReports(options.onAtStart);
  /** The events the last page chose, or what the environment said before any page did. */
  let chosen: ReadonlySet<NoticeEvent> = new Set(options.onAtStart ? DEFAULT_NOTICE_EVENTS : []);
  /** The notifications not yet shown or dropped. */
  const held = new Map<string, HeldChange>();

  function show(change: SessionChange): void {
    try {
      notifier.show(changeNotice(change));
    } catch {
      // A notifier should not throw. One that does must not stop the poll.
    }
  }

  return {
    pageSaid(said, fetchedSessions) {
      const at = now();
      chosen = new Set(said);
      if (said.length === 0) {
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
      // Changes are followed while notifications are off as well. Turning them
      // on then says nothing about what had already happened.
      const result = sessionChanges(memory, snapshot);
      memory = result.memory;

      // A wait that ended while it was held is never shown.
      for (const id of result.stopped) held.delete(heldKey("needs-you", id));
      for (const change of result.changes) {
        if (pages.on && chosen.has(change.event)) {
          held.set(heldKey(change.event, change.session.id), { change, since: at });
        }
      }

      // Every event is handed over to a page the same way, so a page that is
      // open and the collector never both announce one.
      for (const [key, { change, since }] of held) {
        const outcome = chosen.has(change.event) ? heldWaitOutcome(since, pages, at) : "drop";
        if (outcome === "hold") continue;
        held.delete(key);
        if (outcome === "show") show(change);
      }
    },
  };
}
