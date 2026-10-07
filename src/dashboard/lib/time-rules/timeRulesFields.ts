import {
  clockMinutes,
  IDLE_HOURS,
  LONG_WAIT_MINUTES,
  REPEAT_MINUTES,
  WEEKDAYS,
  type LongWaitRule,
  type Weekday,
} from "@core/time-rules/timeRules";

/**
 * What the Time rules card reads from what is typed in its fields, and how it
 * shows what the app holds. A field is read when the person leaves it or
 * presses Enter, and what cannot be read is never sent: the field goes back
 * to what the app holds, and a line says what it takes.
 */

/** Each rule's name, beside its switch and for assistive technology. */
export const RULE_NAMES = {
  longWait: "Remind me of a long wait",
  idle: "Mark idle sessions stale",
  quietHours: "Quiet hours",
} as const;

/** The name of the switch that repeats the long wait reminder while the wait goes on. */
export const REMIND_AGAIN = "Remind again while it waits";

/** The name of the switch that leaves answered waits out of the summary. */
export const LEAVE_OUT = "Leave answered waits out of the summary";

/** A whole number typed in a field, within a range, or null. */
export function readWholeNumber(text: string, range: { min: number; max: number }): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= range.min && value <= range.max ? value : null;
}

/** The minutes of the long wait reminder, typed. */
export function readMinutes(text: string): number | null {
  return readWholeNumber(text, LONG_WAIT_MINUTES);
}

/** What the minutes field takes. */
export const MINUTES_TAKE = `Type a whole number of minutes from ${LONG_WAIT_MINUTES.min} to ${LONG_WAIT_MINUTES.max}.`;

/** The minutes between one reminder and the next, typed. */
export function readRepeatMinutes(text: string): number | null {
  return readWholeNumber(text, REPEAT_MINUTES);
}

/** What the repeat's field takes. */
export const REPEAT_TAKE = `Type a whole number of minutes from ${REPEAT_MINUTES.min} to ${REPEAT_MINUTES.max}.`;

/**
 * The repeat as the card shows it: off, with the minutes it would take, when
 * the rule has none, as one from a file from before there was a repeat.
 */
export function repeatShown(rule: LongWaitRule): { on: boolean; minutes: number } {
  return rule.repeat ?? { on: false, minutes: REPEAT_MINUTES.default };
}

/** The long wait rule with its repeat switched, keeping its minutes. */
export function withRepeat(
  rule: LongWaitRule,
  change: { on?: boolean; minutes?: number },
): LongWaitRule {
  return { ...rule, repeat: { ...repeatShown(rule), ...change } };
}

/** The unit the idle rule is shown in. */
export type IdleUnit = "hours" | "days";

/** The most days the idle rule can be set to. */
const MAX_IDLE_DAYS = IDLE_HOURS.max / 24;

/** The idle rule's hours as the card shows them: in days when they are whole days, else in hours. */
export function idleShown(hours: number): { value: number; unit: IdleUnit } {
  return hours % 24 === 0 ? { value: hours / 24, unit: "days" } : { value: hours, unit: "hours" };
}

/** The idle rule's hours from what is typed, in the unit chosen. */
export function readIdleHours(text: string, unit: IdleUnit): number | null {
  if (unit === "hours") return readWholeNumber(text, IDLE_HOURS);
  const days = readWholeNumber(text, { min: 1, max: MAX_IDLE_DAYS });
  return days === null ? null : days * 24;
}

/** What the idle field takes. */
export const IDLE_TAKES = `Type a whole number of hours from ${IDLE_HOURS.min} to ${IDLE_HOURS.max}, or of days from 1 to ${MAX_IDLE_DAYS}.`;

/**
 * Said when the person asks for days while the hours in force are not whole
 * days. The unit only changes how they are shown, so they stay in hours, and
 * nothing is rounded or sent.
 */
export function notWholeDays(hours: number): string {
  return `${hours} ${hours === 1 ? "hour is" : "hours is"} not a whole number of days.`;
}

/**
 * A time typed in a field, as the rules write it, or null: "22:00", and also
 * "8:00", "08", "8" or "0830", which the card writes back as "08:00" and
 * "08:30".
 */
export function readClock(text: string): string | null {
  const trimmed = text.trim();
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(trimmed);
  if (!match) return null;
  const clock = `${(match[1] as string).padStart(2, "0")}:${match[2] ?? "00"}`;
  return clockMinutes(clock) === null ? null : clock;
}

/** What a time field takes. */
export const CLOCK_TAKES = "Type a time on the 24-hour clock, such as 22:00.";

/** Said under the times while quiet hours hold, as the app says they do: "Quiet now, until 08:00. ..." */
export function quietNowLine(to: string): string {
  return `Quiet now, until ${to}. Notifications, emails and posts are held.`;
}

/** Said when both ends of the quiet hours are the same time. */
export const SAME_TIMES = "Quiet hours must begin and end at different times.";

/** Each day's short name, beside its tick. */
export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** Each day's whole name, for assistive technology. */
export const WEEKDAY_NAME: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** The days with one ticked or unticked, in the order of the week. */
export function withDay(days: readonly Weekday[], day: Weekday, ticked: boolean): Weekday[] {
  return WEEKDAYS.filter((one) => (one === day ? ticked : days.includes(one)));
}
