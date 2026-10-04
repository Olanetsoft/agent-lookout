/** Formatting for the facts the dashboard shows: durations and times. */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DurationPart {
  value: string;
  unit: "s" | "m" | "h" | "d";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A duration as its two most significant units, so it stays short at any age:
 * `42s`, `4m 12s`, `1h 04m`, `6d 02h`. The smaller unit is zero-padded so the
 * text keeps its width while it ticks.
 */
export function durationParts(ms: number): DurationPart[] {
  const total = Math.max(0, Math.floor(ms));
  if (total < MINUTE) {
    return [{ value: String(Math.floor(total / SECOND)), unit: "s" }];
  }
  if (total < HOUR) {
    return [
      { value: String(Math.floor(total / MINUTE)), unit: "m" },
      { value: pad2(Math.floor((total % MINUTE) / SECOND)), unit: "s" },
    ];
  }
  if (total < DAY) {
    return [
      { value: String(Math.floor(total / HOUR)), unit: "h" },
      { value: pad2(Math.floor((total % HOUR) / MINUTE)), unit: "m" },
    ];
  }
  return [
    { value: String(Math.floor(total / DAY)), unit: "d" },
    { value: pad2(Math.floor((total % DAY) / HOUR)), unit: "h" },
  ];
}

/**
 * A duration as a row of a table says it, coarser than a timer: `42s`, `34m`,
 * `1h 04m`, `6d`. Seconds count only in the first minute, and days stand alone,
 * so a list of sessions reads at a glance; the exact start is in the row's
 * tooltip. Never rounded up, so it never says more time than has passed.
 */
export function shortDurationParts(ms: number): DurationPart[] {
  const parts = durationParts(ms);
  const first = parts[0];
  if (!first) return parts;
  return first.unit === "m" || first.unit === "d" ? [first] : parts;
}

function joinParts(parts: readonly DurationPart[]): string {
  return parts.map((part) => `${part.value}${part.unit}`).join(" ");
}

export function formatDuration(ms: number): string {
  return joinParts(durationParts(ms));
}

/** `shortDurationParts` as text: "34m". */
export function formatShortDuration(ms: number): string {
  return joinParts(shortDurationParts(ms));
}

function partsInWords(parts: readonly DurationPart[]): string {
  const names = { s: "second", m: "minute", h: "hour", d: "day" } as const;
  return parts
    .map((part) => {
      const count = Number(part.value);
      return `${count} ${names[part.unit]}${count === 1 ? "" : "s"}`;
    })
    .join(" ");
}

/** A duration in words, for screen readers: "4 minutes 12 seconds". */
export function durationInWords(ms: number): string {
  return partsInWords(durationParts(ms));
}

/** The short form in words, so what is read out is what is shown: "34 minutes". */
export function shortDurationInWords(ms: number): string {
  return partsInWords(shortDurationParts(ms));
}

/** "2s ago", or "just now" inside the first second. */
export function formatAgo(ms: number): string {
  return ms < SECOND ? "just now" : `${formatDuration(ms)} ago`;
}

/** Local wall-clock time, 24-hour: `10:42:07`. */
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** Local wall-clock time to the minute, 24-hour: `10:42`. For the ticks of a time axis. */
export function formatClockMinutes(at: number): string {
  const date = new Date(at);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function sameLocalDay(a: number, b: number): boolean {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

/** The start of a moment's day on the local clock. Two moments on one day share it. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * A day, for a heading in a list of times: `Sep 30`, with the year only when it
 * is not this one.
 */
export function formatDay(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? dayFormat : dateFormat).format(new Date(at));
}

/**
 * A full local date and time, for a tooltip: `Sep 30, 2026 14:12:24`. The clock
 * is the same 24-hour clock as everywhere else on the page.
 */
export function formatFullTime(at: number): string {
  return `${dateFormat.format(new Date(at))} ${formatClock(at)}`;
}

/**
 * When something began, for a tooltip beside a duration. Today it is the clock
 * alone. Before today it carries the date, because "since 14:12" says nothing
 * about a status that has lasted five days.
 */
export function formatSince(at: number, now: number): string {
  return sameLocalDay(at, now) ? formatClock(at) : formatFullTime(at);
}
