/**
 * The timing of a notification the collector holds back: whether to show it,
 * go on holding it, or drop it. It is all here, in one function of three times
 * and a switch, so it can be tested without a clock.
 *
 * A dashboard page that has notifications on shows a wait itself, a moment
 * after it fetches the sessions. The collector sees the wait first, because
 * the page learns of it from the collector. So the collector holds its own
 * notification back for a short while, and lets it go only when no page turns
 * up to show it. A wait is announced once that way while an open page keeps
 * asking on time, and a wait with no page open is still announced. A page that
 * goes more than about four seconds between two fetches of the sessions is not
 * waited for, and shows the wait as well when it next fetches.
 */

/**
 * How long a wait is held for a page to show it. A page asks for the sessions
 * every two seconds, so this leaves it one full turn and a second to spare. The
 * collector decides on each of its own polls, two seconds apart, so a wait no
 * page takes is announced on the second poll after it was seen: about four
 * seconds, and under five while the polls are on time.
 */
export const HANDOVER_GRACE_MS = 3_000;

/**
 * A page that has asked for nothing for this long is taken to be closed. An
 * open one asks every two seconds, so this is two missed turns and a second.
 */
export const PAGE_GONE_AFTER_MS = 5_000;

/** What the dashboard pages have told the collector, in the header on their requests. */
export interface PageReports {
  /**
   * Whether notifications are on: the last thing a page said, or, before any
   * page has said anything, what the environment said when the collector started.
   */
  on: boolean;
  /** When a page that said "on" last asked for anything. Null when none has. */
  lastOnAt: number | null;
  /** When a page that said "on" last fetched the sessions. Null when none has. */
  lastOnSessionsAt: number | null;
}

/** Before any page has asked for anything. */
export function noPageReports(on: boolean): PageReports {
  return { on, lastOnAt: null, lastOnSessionsAt: null };
}

/**
 * "show": no page is going to, so the collector shows the notification.
 * "hold": a page may yet show it. Ask again later.
 * "drop": a page has it, or notifications are off. The collector shows nothing.
 */
export type HeldWaitOutcome = "show" | "hold" | "drop";

/**
 * What to do, at `now`, with a wait the collector first saw at `since`.
 *
 * - Notifications off, by the last thing a page said: dropped. Turning them off
 *   in Settings covers a wait that is being held as well.
 * - A page that said "on" has fetched the sessions since the wait was seen: it
 *   has the wait and shows it, so it is dropped. A fetch in the same millisecond
 *   is not counted, because it may have been answered just before the wait was
 *   seen. That page's next fetch settles it. A page that has only just loaded
 *   is the exception: its first answer is a baseline and announces nothing, so
 *   a wait that begins within a poll of a reload is announced by neither.
 * - No page that said "on" has asked for anything in the last few seconds:
 *   there is nobody to wait for, so it is shown at once.
 * - Otherwise it is held until the grace period is over, and then shown.
 *
 * A wait that ends while it is held is not this function's business: the
 * caller forgets it.
 */
export function heldWaitOutcome(since: number, pages: PageReports, now: number): HeldWaitOutcome {
  if (!pages.on) return "drop";
  if (pages.lastOnSessionsAt !== null && pages.lastOnSessionsAt > since) return "drop";
  if (pages.lastOnAt === null || now - pages.lastOnAt > PAGE_GONE_AFTER_MS) return "show";
  return now - since >= HANDOVER_GRACE_MS ? "show" : "hold";
}
