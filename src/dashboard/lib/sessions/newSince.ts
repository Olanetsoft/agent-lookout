/**
 * What arrived in the events log while the person was away from it, worked out
 * from one time: the moment the log was last on screen.
 *
 * When the page comes back into sight after being hidden, the events newer than
 * that moment are new, and the log draws a line under them, "New since
 * 14:02:37", with the count beside its title. They are new until the line has
 * been in view for `NEW_SEEN_MS`, or until the person leaves the Overview for
 * another view.
 * Someone who never leaves the page never sees a line: only coming back draws
 * one.
 *
 * A page that has just loaded counts as coming back, so a reload, or a tab the
 * browser put away and opened again, starts from the time kept last.
 */

import type { SessionEvent } from "@core/sessions/session";

/** How long the line stays in view before it goes: long enough to read what is above it. */
export const NEW_SEEN_MS = 10_000;

export interface NewSince {
  /** Whether the log could not be seen at the last step: the page hidden, or nothing drawn yet. */
  away: boolean;
  /** Whether the Overview was showing at the last step. */
  overview: boolean;
  /** The moment the log was last on screen, or null while it never has been. */
  leftAt: number | null;
  /** Events after this moment are new, and the line sits under them. Null while there is no line. */
  since: number | null;
  /** Since when the line has been in view without a break. Null while it is not in view. */
  inViewFrom: number | null;
}

/** What the page is doing now. */
export interface Look {
  now: number;
  /** The page is in sight and the log has something to show. */
  visible: boolean;
  /** The Overview is the view showing, so the log is on the page. */
  overview: boolean;
  /** The line is in view, within the window and the log's own scrolling. */
  lineInView: boolean;
  /** When the newest event held happened, or null with none. */
  newestAt: number | null;
}

/**
 * Where a page begins: away, so its first look is a return, and with the time
 * kept from before, if any.
 */
export function startNewSince(lastLookedAt: number | null): NewSince {
  return { away: true, overview: false, leftAt: lastLookedAt, since: null, inViewFrom: null };
}

/**
 * The next state, from the last one and what the page is doing now. It returns
 * the same object when nothing has changed, and a second step with the same
 * look changes nothing.
 */
export function nextNewSince(state: NewSince, look: Look): NewSince {
  const wasOnScreen = !state.away && state.overview;
  const onScreen = look.visible && look.overview;
  let { leftAt, since, inViewFrom } = state;

  if (state.away && look.visible) {
    // Back. What arrived after the log was last on screen is new, and a line
    // that has not gone yet keeps its place, because what is above it is still
    // to be seen.
    const from = since ?? leftAt;
    since = from !== null && look.newestAt !== null && look.newestAt > from ? from : null;
    inViewFrom = null;
  } else if (state.overview && !look.overview && look.visible) {
    // Off to another view: the person has moved on from the log.
    since = null;
  }
  // Every event held by then was drawn while the log was on screen, even one
  // that came in after the clock's last tick.
  if (wasOnScreen && !onScreen) leftAt = Math.max(look.now, look.newestAt ?? look.now);

  // With nothing newer than the line, there is nothing above it.
  if (since !== null && (look.newestAt === null || look.newestAt <= since)) since = null;

  if (since !== null && onScreen && look.lineInView) {
    inViewFrom ??= look.now;
    if (look.now - inViewFrom >= NEW_SEEN_MS) since = null;
  } else {
    inViewFrom = null;
  }
  if (since === null) inViewFrom = null;

  const away = !look.visible;
  const overview = look.overview;
  if (
    away === state.away &&
    overview === state.overview &&
    leftAt === state.leftAt &&
    since === state.since &&
    inViewFrom === state.inViewFrom
  ) {
    return state;
  }
  return { away, overview, leftAt, since, inViewFrom };
}

/** How many events, newest first, came after `since`. */
export function countNew(events: readonly SessionEvent[], since: number | null): number {
  if (since === null) return 0;
  let count = 0;
  while (count < events.length && (events[count] as SessionEvent).at > since) count += 1;
  return count;
}
