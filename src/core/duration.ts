// How a length of time reads, wherever Agent Lookout shows one: on the page,
// through `src/dashboard/lib/format.ts`, and in the `agent-lookout` command.

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
