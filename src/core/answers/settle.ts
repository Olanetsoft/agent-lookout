/**
 * How long a permission request is shown before Allow or Deny takes a press:
 * on the dashboard, in a notification of the Mac app and in its menu bar. A
 * press aimed at the request before it, or at another session's that moved
 * into the same place, lands in this time and is not sent. On the dashboard it
 * starts again when the buttons move or the page comes back into sight.
 */
export const ANSWER_SETTLE_MS = 1_000;

/**
 * Whether a press at `now` is taken, of a request first shown at `shownAt`,
 * or not yet known to be shown at all, `null`. One shown a second or more later
 * than now was shown before the clock was set back, and takes it too.
 */
export function settled(shownAt: number | null, now: number): boolean {
  return shownAt !== null && Math.abs(now - shownAt) >= ANSWER_SETTLE_MS;
}
