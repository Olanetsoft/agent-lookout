// Times arrive from files and commands this app does not control. A time that
// cannot be right is treated as not known, so the dashboard never shows a
// session that has been idle "since 1970" or that changed status tomorrow.

/**
 * The earliest moment a session time is believed: the start of 2020, before any
 * tool this app watches existed. A value below it is a mistake, such as a count
 * of seconds where milliseconds were expected.
 */
export const EARLIEST_PLAUSIBLE_TIME_MS = Date.UTC(2020, 0, 1);

/**
 * How far ahead of the collector's clock a time may sit and still be believed.
 * A poll notes its own time first and reads its sources afterwards, so a status
 * that changed during the poll is honestly a few seconds "in the future".
 */
export const CLOCK_SLACK_MS = 60_000;

/**
 * Returns an epoch-millisecond time when it could be real, and null when it
 * could not: not a whole number, before 2020, or further ahead of `now` than the
 * slack allows.
 */
export function plausibleTime(value: unknown, now: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  if (value < EARLIEST_PLAUSIBLE_TIME_MS) return null;
  if (value > now + CLOCK_SLACK_MS) return null;
  return value;
}
