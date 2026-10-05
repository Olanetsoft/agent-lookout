/**
 * When a wait is emailed. It is all here, in functions of a few times, so it
 * can be tested without a clock.
 *
 * A wait is emailed once, when it has lasted the delay the person set and is
 * still open. A wait answered before then sends nothing. On top of that, at
 * most `EMAILS_PER_HOUR` emails are tried in any hour. A wait that is due while
 * that many have gone is held, and is emailed once the hour lets another go, if
 * it is still open then.
 */

import { EMAILS_PER_HOUR } from "../../core/api.ts";

export const HOUR_MS = 3_600_000;

/**
 * send     the wait has lasted long enough, and the hourly limit lets it go.
 * wait     it has not lasted long enough yet.
 * limited  it has, and the hourly limit holds it back.
 */
export type EmailTiming = "send" | "wait" | "limited";

/** The emails tried in the hour before `now`, oldest first. Only these count against the limit. */
export function sendsInLastHour(sentAt: readonly number[], now: number): number[] {
  return sentAt.filter((at) => now - at < HOUR_MS).sort((a, b) => a - b);
}

/**
 * When the hourly limit next lets an email go: an hour after the oldest of the
 * emails that fill it. Null while it is not full.
 */
export function limitLiftsAt(sentAt: readonly number[], now: number): number | null {
  const recent = sendsInLastHour(sentAt, now);
  if (recent.length < EMAILS_PER_HOUR) return null;
  return (recent[recent.length - EMAILS_PER_HOUR] as number) + HOUR_MS;
}

/**
 * What to do at `now` with a wait that began at `begunAt` and has not been
 * emailed, given the delay and the times of the emails already tried.
 */
export function emailTiming(
  begunAt: number,
  afterMs: number,
  sentAt: readonly number[],
  now: number,
): EmailTiming {
  if (now - begunAt < afterMs) return "wait";
  return limitLiftsAt(sentAt, now) === null ? "send" : "limited";
}

/**
 * When a wait began, as far as the collector can tell: the status time its
 * source gave it, or, when there is none or it lies ahead of the clock, the
 * moment the collector first saw it.
 */
export function waitBegan(statusSince: number | null, seenAt: number): number {
  return statusSince !== null && statusSince <= seenAt ? statusSince : seenAt;
}
