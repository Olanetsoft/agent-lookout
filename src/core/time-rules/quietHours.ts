import type { SessionsSnapshot } from "../sessions/session.ts";
import { clockMinutes, rulesOf, type QuietHoursRule, type Weekday } from "./timeRules.ts";

/** Each day as `Date.getDay` numbers it, from Sunday. */
const DAY_OF_WEEK: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Whether a moment falls in the quiet hours, on the local clock.
 *
 * Quiet hours run from `from` up to `to`, and when `to` is the earlier of the
 * two they run past midnight into the next day. They begin only on the days
 * ticked, so 22:00 to 08:00 on Monday to Friday is quiet from Monday night to
 * Saturday morning, and Saturday and Sunday nights are not. With no day
 * ticked, or the rule off, nothing is quiet.
 *
 * The clock is read as it is at that moment, so on the night the clocks
 * change, quiet hours still begin and end at the times they say.
 */
export function isQuietAt(rule: QuietHoursRule, at: number): boolean {
  if (!rule.on) return false;
  const from = clockMinutes(rule.from);
  const to = clockMinutes(rule.to);
  if (from === null || to === null || from === to) return false;

  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  const today = DAY_OF_WEEK[date.getDay()] as Weekday;
  if (from < to) return minute >= from && minute < to && rule.days.includes(today);
  if (minute >= from) return rule.days.includes(today);
  if (minute < to) {
    const yesterday = DAY_OF_WEEK[(date.getDay() + 6) % 7] as Weekday;
    return rule.days.includes(yesterday);
  }
  return false;
}

/**
 * Whether a snapshot was made in quiet hours: what the collector that made it
 * said, by its own clock, or, from one that did not say, its rules at the
 * moment it was made. Every channel decides by this, so all of them hold at
 * the same poll, wherever the page that reads it is.
 */
export function quietOf(
  snapshot: Pick<SessionsSnapshot, "generatedAt" | "timeRules" | "quiet">,
): boolean {
  return snapshot.quiet ?? isQuietAt(rulesOf(snapshot).quietHours, snapshot.generatedAt);
}
