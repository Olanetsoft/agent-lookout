/** Formatting for the facts the dashboard shows: durations and times. */

import {
  durationParts,
  formatDuration,
  joinParts,
  partsInWords,
  type DurationPart,
} from "@core/duration";

// The full form of a duration, its words and the clock live in the core, so the
// `agent-lookout` command and an email say a wait and a time as the page does.
export {
  clockAt,
  durationInWords,
  durationParts,
  formatClockMinutes,
  formatDay,
  formatDuration,
  startOfDay,
  type DurationPart,
} from "@core/duration";

const SECOND = 1_000;

/** Words with their first letter made a capital, to start a sentence: "the server answered 502" as "The server answered 502". */
export function sentenceStart(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
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

/** `shortDurationParts` as text: "34m". */
export function formatShortDuration(ms: number): string {
  return joinParts(shortDurationParts(ms));
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
