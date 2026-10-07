import type { SessionsSnapshot } from "../sessions/session.ts";
import { STALE_THRESHOLD_MS } from "../sessions/staleness.ts";

/**
 * The time rules, each set and switched off on its own:
 *
 * - `longWait`: a reminder once a session has waited a number of minutes, sent
 *   once for each wait, the way its first notice went, and with `repeat` on,
 *   again every so many minutes while the wait goes on.
 * - `idle`: how long a session is idle before it is stale, in place of the
 *   built-in day. Stale marks and the sessions left running both go by it.
 * - `quietHours`: hours in which no notification, email or post goes, with one
 *   summary on each channel when they end.
 *
 * The collector keeps them, in its settings file, so they hold with no
 * dashboard open, and every snapshot carries the rules in force when it was
 * made, so the page and the collector decide by the same rules at the same
 * moment. Every rule is off until the person turns it on.
 */

/** The days of the week, as they are written in the file and the API. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface LongWaitRule {
  on: boolean;
  /** How long a wait lasts before the reminder, in whole minutes. */
  minutes: number;
  /**
   * Whether the reminder goes again while the wait goes on, and how often. A
   * rule without it, as in a file from before there was one, does not repeat.
   */
  repeat?: RepeatRule;
}

export interface RepeatRule {
  on: boolean;
  /** How long from one reminder of a wait to the next, in whole minutes. */
  minutes: number;
}

export interface IdleRule {
  on: boolean;
  /** How long a session is idle before it is stale, in whole hours. */
  hours: number;
}

export interface QuietHoursRule {
  on: boolean;
  /** When they begin, on the local clock, as `22:00`. */
  from: string;
  /** When they end, as `08:00`. Earlier than `from`, they run past midnight. */
  to: string;
  /** The days they begin on, in the order of `WEEKDAYS`. None is never. */
  days: Weekday[];
  /** Whether the summary leaves out the waits that were answered before the quiet hours ended. */
  leaveOutAnswered: boolean;
}

export interface TimeRules {
  longWait: LongWaitRule;
  idle: IdleRule;
  quietHours: QuietHoursRule;
}

/** The names of the rules, as they are written. */
export const TIME_RULE_NAMES = ["longWait", "idle", "quietHours"] as const;

export type TimeRuleName = (typeof TIME_RULE_NAMES)[number];

/** How long a wait may be set to last before its reminder. */
export const LONG_WAIT_MINUTES = { min: 1, max: 1_440, default: 10 } as const;

/** How long may be set between one reminder of a wait and the next: five minutes to a day. */
export const REPEAT_MINUTES = { min: 5, max: 1_440, default: 30 } as const;

/** How long a session may be set to be idle before it is stale: an hour to 30 days. */
export const IDLE_HOURS = { min: 1, max: 720, default: 48 } as const;

/** Every rule off, as before the person has set any. */
export const DEFAULT_TIME_RULES: TimeRules = {
  longWait: { on: false, minutes: LONG_WAIT_MINUTES.default },
  idle: { on: false, hours: IDLE_HOURS.default },
  quietHours: {
    on: false,
    from: "22:00",
    to: "08:00",
    days: [...WEEKDAYS],
    leaveOutAnswered: false,
  },
};

const HOUR_MS = 3_600_000;

/** A time on the clock as the rules write it: two digits, a colon and two digits. */
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The minutes since midnight of a time written `22:00`, or null when it is not one. */
export function clockMinutes(clock: string): number | null {
  const match = CLOCK.exec(clock);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object holds these keys and, when `exact`, no others. */
function holds(value: Record<string, unknown>, keys: readonly string[], exact: boolean): boolean {
  if (!keys.every((key) => key in value)) return false;
  return !exact || Object.keys(value).length === keys.length;
}

function wholeNumberIn(value: unknown, range: { min: number; max: number }): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= range.min && (value as number) <= range.max
  );
}

function readRepeat(value: unknown, exact: boolean): RepeatRule | null {
  if (!isRecord(value) || !holds(value, ["on", "minutes"], exact)) return null;
  const { on, minutes } = value;
  if (typeof on !== "boolean" || !wholeNumberIn(minutes, REPEAT_MINUTES)) return null;
  return { on, minutes };
}

function readLongWait(value: unknown, exact: boolean): LongWaitRule | null {
  if (!isRecord(value)) return null;
  // `repeat` may be left out, as from a file or a page from before it.
  const keys = value.repeat === undefined ? ["on", "minutes"] : ["on", "minutes", "repeat"];
  if (!holds(value, keys, exact)) return null;
  const { on, minutes } = value;
  if (typeof on !== "boolean" || !wholeNumberIn(minutes, LONG_WAIT_MINUTES)) return null;
  if (value.repeat === undefined) return { on, minutes };
  const repeat = readRepeat(value.repeat, exact);
  return repeat === null ? null : { on, minutes, repeat };
}

function readIdle(value: unknown, exact: boolean): IdleRule | null {
  if (!isRecord(value) || !holds(value, ["on", "hours"], exact)) return null;
  const { on, hours } = value;
  if (typeof on !== "boolean" || !wholeNumberIn(hours, IDLE_HOURS)) return null;
  return { on, hours };
}

function readDays(value: unknown): Weekday[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((day) => (WEEKDAYS as readonly unknown[]).includes(day))) return null;
  if (new Set(value).size !== value.length) return null;
  return WEEKDAYS.filter((day) => value.includes(day));
}

function readQuietHours(value: unknown, exact: boolean): QuietHoursRule | null {
  const keys = ["on", "from", "to", "days", "leaveOutAnswered"];
  if (!isRecord(value) || !holds(value, keys, exact)) return null;
  const { on, from, to, leaveOutAnswered } = value;
  if (typeof on !== "boolean" || typeof leaveOutAnswered !== "boolean") return null;
  if (typeof from !== "string" || typeof to !== "string") return null;
  const begins = clockMinutes(from);
  const ends = clockMinutes(to);
  if (begins === null || ends === null || begins === ends) return null;
  const days = readDays(value.days);
  if (days === null) return null;
  return { on, from, to, days, leaveOutAnswered };
}

const READERS: Record<TimeRuleName, (value: unknown, exact: boolean) => unknown> = {
  longWait: readLongWait,
  idle: readIdle,
  quietHours: readQuietHours,
};

/** What each rule must be, in the sentence that refuses a change that is not. */
const SHAPES: Record<TimeRuleName, string> = {
  longWait: `longWait must be {"on", "minutes"}, with minutes a whole number from ${LONG_WAIT_MINUTES.min} to ${LONG_WAIT_MINUTES.max}, and may have "repeat", {"on", "minutes"} with minutes a whole number from ${REPEAT_MINUTES.min} to ${REPEAT_MINUTES.max}.`,
  idle: `idle must be {"on", "hours"}, with hours a whole number from ${IDLE_HOURS.min} to ${IDLE_HOURS.max}.`,
  quietHours:
    'quietHours must be {"on", "from", "to", "days", "leaveOutAnswered"}, with from and to two different times written as 22:00 is, and days any of mon, tue, wed, thu, fri, sat and sun, each once.',
};

/** What the rules read as, and those that could not be read. */
export interface TimeRulesRead {
  rules: TimeRules;
  /** The rules that were there and could not be read, which are off. */
  unread: TimeRuleName[];
}

/**
 * The rules as a file or an answer holds them, read leniently: a key that is
 * not one of theirs is passed over, as a later version's would be, a rule that
 * is not there is off, and a rule that cannot be read whole is off too, with
 * its name in `unread`. A rule is never half read: quiet hours with a time
 * that cannot be read hold nothing back, rather than hold it back at the wrong
 * hours.
 */
export function readTimeRules(value: unknown): TimeRulesRead {
  const rules: TimeRules = {
    longWait: { ...DEFAULT_TIME_RULES.longWait },
    idle: { ...DEFAULT_TIME_RULES.idle },
    quietHours: { ...DEFAULT_TIME_RULES.quietHours, days: [...WEEKDAYS] },
  };
  const unread: TimeRuleName[] = [];
  if (!isRecord(value)) return { rules, unread: value === undefined ? [] : [...TIME_RULE_NAMES] };
  for (const name of TIME_RULE_NAMES) {
    if (value[name] === undefined) continue;
    const read = READERS[name](value[name], false);
    if (read === null) unread.push(name);
    else Object.assign(rules, { [name]: read });
  }
  return { rules, unread };
}

/**
 * The rules a change asks for, read strictly: exactly the three rules, each
 * with exactly its own fields, every one of them right. The long wait rule's
 * `repeat` may be left out, which is no repeat. Anything else is
 * refused with one sentence that says what was expected, and nothing of it is
 * taken, as no other route reads the part of a body that fits.
 */
export function timeRulesIn(
  value: unknown,
): { ok: true; rules: TimeRules } | { ok: false; problem: string } {
  if (!isRecord(value) || !holds(value, TIME_RULE_NAMES, true)) {
    return {
      ok: false,
      problem:
        "The body must be the three time rules, longWait, idle and quietHours, and nothing else.",
    };
  }
  const rules: Partial<TimeRules> = {};
  for (const name of TIME_RULE_NAMES) {
    const read = READERS[name](value[name], true);
    if (read === null) return { ok: false, problem: SHAPES[name] };
    Object.assign(rules, { [name]: read });
  }
  return { ok: true, rules: rules as TimeRules };
}

/** How long a session is idle before it is stale: the idle rule's, or the built-in day while it is off. */
export function staleAfterMs(rules: TimeRules | null | undefined): number {
  return rules?.idle.on ? rules.idle.hours * HOUR_MS : STALE_THRESHOLD_MS;
}

/** The rules a snapshot was made by. One from before there were any is every rule off. */
export function rulesOf(snapshot: Pick<SessionsSnapshot, "timeRules">): TimeRules {
  return snapshot.timeRules ?? DEFAULT_TIME_RULES;
}
