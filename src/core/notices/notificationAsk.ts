import { CLOCK_SLACK_MS, EARLIEST_PLAUSIBLE_TIME_MS } from "../time.ts";

// Whether the Overview may ask again to turn notifications on, after the
// person pressed Not now. The record is a count of Not now and the time of the
// last one, or that it will not ask again. It holds nothing about a session,
// since the question is the same for all of them.
//
// Each wait is counted from the last Not now, not from when the question came
// back, so a question ignored for a week still waits its full time after the
// next press. A time ahead of the clock, as after the clock was set back,
// cannot be waited from, so the question is due again and the count still
// holds: it stops after the fourth Not now and never stays silent for years.

const DAY_MS = 86_400_000;

/** How long after each Not now the Overview asks again: about a day, then 3 days, then a week. After the fourth, never. */
export const ASK_AGAIN_AFTER_MS: readonly number[] = Object.freeze([
  DAY_MS,
  3 * DAY_MS,
  7 * DAY_MS,
]);

/**
 * Where the question stands:
 *
 * unasked  nothing is stored: it asks when the Overview is drawn
 * put-off  Not now was pressed `times` times, 1 to 3, the last at `at`
 * stopped  it never asks again
 */
export type NotificationAsk =
  { kind: "unasked" } | { kind: "put-off"; times: number; at: number } | { kind: "stopped" };

/** A record as it is stored: put off, or stopped. Nothing stored is unasked. */
export type StoredNotificationAsk = Exclude<NotificationAsk, { kind: "unasked" }>;

export const UNASKED: NotificationAsk = Object.freeze({ kind: "unasked" });
export const STOPPED: StoredNotificationAsk = Object.freeze({ kind: "stopped" });

/** How many Not now there can be before the question stops. */
const MOST_PUT_OFFS = ASK_AGAIN_AFTER_MS.length;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The record from what was stored. Nothing stored, or anything that cannot be
 * read, is as nothing stored, so the worst a damaged value does is ask once
 * more. `stopped` wins over everything else, and a count past the last wait is
 * stopped too.
 */
export function readNotificationAsk(text: string | null): NotificationAsk {
  if (text === null) return UNASKED;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return UNASKED;
  }
  if (!isPlainObject(value)) return UNASKED;
  if (value.stopped === true) return STOPPED;
  const { notNow, at } = value;
  if (typeof notNow !== "number" || !Number.isSafeInteger(notNow)) return UNASKED;
  if (notNow > MOST_PUT_OFFS) return STOPPED;
  if (notNow < 1) return UNASKED;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < EARLIEST_PLAUSIBLE_TIME_MS) {
    return UNASKED;
  }
  return { kind: "put-off", times: notNow, at };
}

/** The text stored for a record: `{"notNow":2,"at":1791000000000}`, or `{"stopped":true}`. */
export function writeNotificationAsk(ask: StoredNotificationAsk): string {
  if (ask.kind === "stopped") return JSON.stringify({ stopped: true });
  return JSON.stringify({ notNow: ask.times, at: ask.at });
}

/** Whether the question may be asked at `now`. */
export function notificationAskDue(ask: NotificationAsk, now: number): boolean {
  if (ask.kind === "unasked") return true;
  if (ask.kind === "stopped") return false;
  // A time ahead of the clock cannot be waited from.
  if (ask.at > now + CLOCK_SLACK_MS) return true;
  const wait = ASK_AGAIN_AFTER_MS[ask.times - 1];
  if (wait === undefined) return false;
  return now - ask.at >= wait;
}

/** The record after Not now at `now`: put off once more, from now, or stopped after the last wait. */
export function afterNotNow(ask: NotificationAsk, now: number): StoredNotificationAsk {
  if (ask.kind === "unasked") return { kind: "put-off", times: 1, at: now };
  if (ask.kind === "stopped") return STOPPED;
  return ask.times < MOST_PUT_OFFS ? { kind: "put-off", times: ask.times + 1, at: now } : STOPPED;
}
