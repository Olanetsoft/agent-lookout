import type { NotificationsSaid } from "../../core/api.ts";
import { withoutWaitingText, type SessionsSnapshot } from "../../core/sessions/session.ts";
import { changeNotice, type Notice } from "../../core/notices/waiting.ts";
import {
  DEFAULT_NOTICE_EVENTS,
  EMPTY_CHANGE_MEMORY,
  sessionChanges,
  type ChangeMemory,
  type NoticeEvent,
  type SessionChange,
} from "../../core/notices/sessionChanges.ts";
import { createQuietHold, type QuietSummary } from "../../core/time-rules/quietHold.ts";
import { quietOf } from "../../core/time-rules/quietHours.ts";
import {
  createReminderWatch,
  reminderSchedule,
  type DueReminder,
} from "../../core/time-rules/reminders.ts";
import { rulesOf } from "../../core/time-rules/timeRules.ts";
import { reminderNotice, summaryNotice } from "../../core/time-rules/timeRulesWords.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";
import { waitBegan } from "../outbound/outboundTiming.ts";
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
 *
 * The time rules each snapshot carries are followed as the page follows them,
 * by the same rules in the core and at the same poll, so a page that is open
 * makes the same reminder and the same summary, and the hand-over decides
 * which of the two shows it. With the long wait reminder on, a wait seen
 * before it had lasted the rule's minutes is reminded of once it has, and with
 * the repeat on, again each time the repeat's minutes pass while it waits.
 * During quiet hours nothing is shown: what would have been is held, a
 * reminder as its wait, and when they end a wait still open is shown as
 * usual, or reminded of when it was told of before them, and the rest in one
 * summary, "While quiet".
 *
 * A wait whose permission request Agent Lookout answered is over from the
 * moment of the answer, as the snapshot marks it for the page too: one
 * being held is dropped, no reminder comes for it, and one a rule answered
 * before any poll saw it is never shown.
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

/** What is said at start when the setting is on and nothing here can show a notification. */
export const NOTIFICATIONS_NOT_SHOWN_LINE = `${NOTIFICATIONS_ENV} is on, but Agent Lookout shows notifications itself on macOS only, so it shows none here. A dashboard tab with notifications on still shows them.`;

/**
 * The one line to say at start about `AGENT_LOOKOUT_NOTIFICATIONS`, or null.
 * With the setting on and a notifier that shows nothing, as on Linux, the
 * setting does nothing, and the person who set it is told so rather than left
 * waiting for a notification that will never come.
 */
export function notificationsAtStartLine(
  env: NodeJS.ProcessEnv,
  notifierShows: boolean,
): string | null {
  return notificationsOnAtStart(env) && !notifierShows ? NOTIFICATIONS_NOT_SHOWN_LINE : null;
}

export interface ServerNotificationsOptions {
  notifier: SystemNotifier;
  /** Whether notifications are on, for a wait alone, before any page has said anything. */
  onAtStart: boolean;
  now?: () => number;
}

/**
 * A notification being held back for a page, and when it was first due: a
 * change, a reminder of a long wait, or the summary of quiet hours.
 */
type Held =
  | { kind: "change"; change: SessionChange; since: number }
  | { kind: "reminder"; reminder: DueReminder; since: number }
  | { kind: "summary"; summary: QuietSummary; since: number };

/** The key the one summary of quiet hours is held by. */
const SUMMARY_KEY = "summary";

/** The key a session's reminder is held by. */
function reminderKey(sessionId: string): string {
  return `reminder ${sessionId}`;
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
  const held = new Map<string, Held>();
  /** The waits that could be reminded of, and those already reminded. */
  const reminders = createReminderWatch();
  /** What quiet hours hold back. */
  const quiet = createQuietHold();

  function show(notice: Notice): void {
    try {
      notifier.show(notice);
    } catch {
      // A notifier should not throw. One that does must not stop the poll.
    }
  }

  /** What a page has chosen to be shown of an event, as the collector knows it. */
  const wants = (event: NoticeEvent) => pages.on && chosen.has(event);

  /** Holds a change back through quiet hours. */
  function holdQuietly(change: SessionChange, at: number): void {
    const { event, session } = change;
    if (event === "needs-you") quiet.holdWait(session, waitBegan(session.statusSince, at));
    else quiet.holdOver(event, withoutWaitingText(session), at);
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
      const rules = rulesOf(snapshot);
      // As the snapshot says, which the page that reads it goes by too.
      const quietNow = quietOf(snapshot);
      const schedule = reminderSchedule(rules.longWait);
      // Changes are followed while notifications are off as well. Turning them
      // on then says nothing about what had already happened.
      const result = sessionChanges(memory, snapshot);
      memory = result.memory;

      // A wait that ended while it was held is never shown, nor is its reminder.
      for (const id of result.stopped) {
        held.delete(heldKey("needs-you", id));
        held.delete(reminderKey(id));
        quiet.waitEnded(id, at);
      }
      reminders.observe(snapshot, result.stopped, at);

      if (quiet.holding() && !quietNow) {
        // The quiet hours are over: one summary, and each wait still open as usual.
        const end = quiet.end(snapshot, at, rules.quietHours.leaveOutAnswered);
        // Only of the events still chosen, as the page sums up only those.
        const items = end.summary?.items.filter((item) => wants(item.event)) ?? [];
        if (end.summary && items.length > 0) {
          held.set(SUMMARY_KEY, {
            kind: "summary",
            summary: { ...end.summary, items },
            since: at,
          });
        }
        for (const { session } of end.open) {
          if (!wants("needs-you")) continue;
          held.set(heldKey("needs-you", session.id), {
            kind: "change",
            change: { event: "needs-you", session },
            since: at,
          });
          if (rules.longWait.on) reminders.told(session.id, at);
        }
      }
      if (quietNow) quiet.begin(at);

      for (const change of result.changes) {
        if (!wants(change.event)) continue;
        if (quietNow) holdQuietly(change, at);
        else
          held.set(heldKey(change.event, change.session.id), { kind: "change", change, since: at });
      }

      if (rules.longWait.on && wants("needs-you")) {
        for (const reminder of reminders.due(snapshot, at, schedule)) {
          if (quietNow) {
            // Held as its wait, as the page holds it, and reminded of when they end if it is still open.
            quiet.holdReminder(reminder.session, reminder.begunAt);
            continue;
          }
          reminders.told(reminder.session.id, at);
          held.set(reminderKey(reminder.session.id), { kind: "reminder", reminder, since: at });
        }
      }

      // A wait being held is shown as the session is now, so what it is asking
      // can be said when its transcript was read a poll after the wait was seen.
      const listed = new Map(snapshot.sessions.map((session) => [session.id, session]));
      for (const entry of held.values()) {
        if (entry.kind === "summary") continue;
        const session = entry.kind === "change" ? entry.change.session : entry.reminder.session;
        const current = listed.get(session.id);
        if (current === undefined || !needsYou(current)) continue;
        if (entry.kind === "reminder") entry.reminder = { ...entry.reminder, session: current };
        else if (entry.change.event === "needs-you")
          entry.change = { ...entry.change, session: current };
      }

      // Everything is handed over to a page the same way, so a page that is
      // open and the collector never both announce one.
      for (const [key, entry] of held) {
        const event = entry.kind === "change" ? entry.change.event : "needs-you";
        const outcome =
          entry.kind === "summary" || chosen.has(event)
            ? heldWaitOutcome(entry.since, pages, at)
            : "drop";
        if (outcome === "hold") continue;
        held.delete(key);
        if (outcome !== "show") continue;
        // Quiet hours that began while it was held hold it on. A reminder is
        // held as its wait, which is told of as usual when they end.
        if (quietNow) {
          if (entry.kind === "change") holdQuietly(entry.change, at);
          else if (entry.kind === "reminder") {
            quiet.holdWait(entry.reminder.session, entry.reminder.begunAt);
          }
          continue;
        }
        if (entry.kind === "change") show(changeNotice(entry.change));
        else if (entry.kind === "reminder") {
          show(reminderNotice(entry.reminder.session, at - entry.reminder.begunAt));
        } else show(summaryNotice(entry.summary.items));
      }
    },
  };
}
