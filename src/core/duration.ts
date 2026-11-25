// How a length of time, and a time on the clock, read wherever Agent Lookout
// shows one: on the page, through `src/dashboard/lib/format.ts`, in an email,
// and in the `agent-lookout` command.

import { localDate } from "./time-rules/localTime.ts";

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

/** Parts as text: "4m 12s". */
export function joinParts(parts: readonly DurationPart[]): string {
  return parts.map((part) => `${part.value}${part.unit}`).join(" ");
}

export function formatDuration(ms: number): string {
  return joinParts(durationParts(ms));
}

const UNIT_NAMES = { s: "second", m: "minute", h: "hour", d: "day" } as const;

/**
 * Parts in words: "4 minutes 12 seconds". A smaller unit that is zero is left
 * out, so a wait of an hour is "1 hour", and never "1 hour 0 minutes".
 */
export function partsInWords(parts: readonly DurationPart[]): string {
  const said = parts.filter((part, index) => index === 0 || Number(part.value) !== 0);
  return said
    .map((part) => {
      const count = Number(part.value);
      return `${count} ${UNIT_NAMES[part.unit]}${count === 1 ? "" : "s"}`;
    })
    .join(" ");
}

/** A duration in words, read out on the page and written in an email: "4 minutes 12 seconds". */
export function durationInWords(ms: number): string {
  return partsInWords(durationParts(ms));
}

/** Local wall-clock time to the minute, 24-hour: `10:42`. */
export function formatClockMinutes(at: number): string {
  const date = localDate(at);
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/** The start of a moment's day on the local clock. Two moments on one day share it. */
export function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** These write a day `localDate` gives, whose UTC fields hold it. */
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const dayAndYearFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A day: `Sep 30`, with the year only when it is not this one. */
export function formatDay(at: number, now: number): string {
  const date = localDate(at);
  const sameYear = date.getUTCFullYear() === localDate(now).getUTCFullYear();
  return (sameYear ? dayFormat : dayAndYearFormat).format(date);
}

/** A time on the clock, with the day when it is not today: "14:02", or "14:02 on Oct 4". */
export function clockAt(at: number, now: number): string {
  const time = formatClockMinutes(at);
  const day = (moment: number) => Math.floor(localDate(moment).getTime() / DAY);
  return day(at) === day(now) ? time : `${time} on ${formatDay(at, now)}`;
}
