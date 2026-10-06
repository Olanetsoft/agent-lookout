// How the history is written on disk: the names of its files and the one line
// each record takes. Pure, with no Node API, so it is tested on its own.
//
// The files are JSON lines, one record a line, appended to and never rewritten.
// A file holds one UTC day, `v1-2026-10-06.jsonl`, and a day that outgrows a
// file goes on in `v1-2026-10-06-2.jsonl`, and so on. The `v1` is the format:
// a later format writes names of its own, which this one leaves alone.
//
// A record is one of four, each an object with one field:
//
//   {"start":1791204000000}                      Agent Lookout started writing
//   {"cleared":1791204000000}                    the history was cleared
//   {"point":[1791204000000,1,2,3,6]}            a history point: at, needs you, working, idle, total
//   {"event":{"id":"…","at":…,"sessionId":…}}    a session event, its own fields and no others
//
// Only what the in-memory stores hold is written. An event is written field by
// field from the ones a `SessionEvent` has, so nothing else a session carries,
// such as what a waiting session is asking, can reach a file.

import {
  ANSWER_DECISIONS,
  EVENT_ACTORS,
  EVENT_KINDS,
  EVENT_SEVERITIES,
  SESSION_STATUSES,
  type EventKind,
  type EventSeverity,
  type HistoryPoint,
  type SessionEvent,
  type SessionStatus,
} from "../../core/sessions/session.ts";

/** The format this version writes and reads. */
export const HISTORY_FORMAT_VERSION = 1;

/** The longest line read. A record is far shorter: an event is well under 2 KB. */
export const MAX_LINE_LENGTH = 8 * 1024;

/** The longest text of an event's that is read: its id, its session's id and its session's name. */
const MAX_FIELD_LENGTH = 1024;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A file's name, read: the format it is in, its UTC day and which of that day's files it is. */
export interface HistoryFileName {
  name: string;
  version: number;
  /** The day, as `2026-10-06`. */
  day: string;
  /** When that day began, UTC. */
  dayStart: number;
  /** 1 for the day's first file, 2 for the one after it, and so on. */
  part: number;
}

const FILE_NAME = /^v([1-9]\d{0,3})-(\d{4})-(\d{2})-(\d{2})(?:-([1-9]\d{0,3}))?\.jsonl$/;

/** The UTC day a moment falls on, as `2026-10-06`. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** The name of a day's file in this format: `v1-2026-10-06.jsonl`, then `v1-2026-10-06-2.jsonl`. */
export function historyFileName(day: string, part = 1): string {
  const suffix = part > 1 ? `-${part}` : "";
  return `v${HISTORY_FORMAT_VERSION}-${day}${suffix}.jsonl`;
}

/** A name read as a history file's, in any format, or null when it is not one. */
export function readHistoryFileName(name: string): HistoryFileName | null {
  const match = FILE_NAME.exec(name);
  if (!match) return null;
  const [, version, year, month, date, part] = match;
  const day = `${year}-${month}-${date}`;
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  // A name such as 2026-02-31 is not a day.
  if (!Number.isFinite(dayStart) || dayOf(dayStart) !== day) return null;
  return { name, version: Number(version), day, dayStart, part: part ? Number(part) : 1 };
}

/** Oldest first: by day, then by part. */
export function byFileOrder(a: HistoryFileName, b: HistoryFileName): number {
  return a.dayStart - b.dayStart || a.part - b.part;
}

/** When a file's day ended, UTC: nothing in it is newer. */
export function dayEnd(file: Pick<HistoryFileName, "dayStart">): number {
  return file.dayStart + DAY_MS;
}

/** One record of the history, as it is read back. */
export type HistoryRecord =
  | { kind: "start"; at: number }
  | { kind: "cleared"; at: number }
  | { kind: "point"; point: HistoryPoint }
  | { kind: "event"; event: SessionEvent };

/** When a record happened. */
export function recordAt(record: HistoryRecord): number {
  if (record.kind === "point") return record.point.at;
  if (record.kind === "event") return record.event.at;
  return record.at;
}

/** A record as its line, with the line break that ends it. */
export function encodeRecord(record: HistoryRecord): string {
  return `${JSON.stringify(recordValue(record))}\n`;
}

function recordValue(record: HistoryRecord): unknown {
  switch (record.kind) {
    case "start":
      return { start: record.at };
    case "cleared":
      return { cleared: record.at };
    case "point": {
      const { at, needsYou, working, idle, total } = record.point;
      return { point: [at, needsYou, working, idle, total] };
    }
    case "event":
      return { event: eventFields(record.event) };
  }
}

/** An event's own fields and nothing else, in a fixed order. */
function eventFields(event: SessionEvent): SessionEvent {
  const { id, at, sessionId, sessionName, kind, from, to, severity, by, decision } = event;
  return {
    id,
    at,
    sessionId,
    sessionName,
    kind,
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    severity,
    ...(by !== undefined && { by }),
    ...(decision !== undefined && { decision }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A moment: a whole number of milliseconds after 1970. */
function moment(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function field(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_FIELD_LENGTH
    ? value
    : null;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | null {
  return list.find((item) => item === value) ?? null;
}

function readPoint(value: unknown): HistoryPoint | null {
  if (!Array.isArray(value) || value.length !== 5) return null;
  const at = moment(value[0]);
  const [needsYou, working, idle, total] = value.slice(1).map(count);
  if (at === null || needsYou == null || working == null || idle == null || total == null) {
    return null;
  }
  return { at, needsYou, working, idle, total };
}

function readEvent(value: unknown): SessionEvent | null {
  if (!isRecord(value)) return null;
  const id = field(value.id);
  const at = moment(value.at);
  const sessionId = field(value.sessionId);
  const sessionName = field(value.sessionName);
  const kind: EventKind | null = oneOf(EVENT_KINDS, value.kind);
  const severity: EventSeverity | null = oneOf(EVENT_SEVERITIES, value.severity);
  if (!id || at === null || !sessionId || !sessionName || !kind || !severity) return null;
  const from: SessionStatus | null = oneOf(SESSION_STATUSES, value.from);
  const to: SessionStatus | null = oneOf(SESSION_STATUSES, value.to);
  // A status that is there and is not one of the statuses spoils the event,
  // and so does a doer that is not one this version knows.
  if ((value.from !== undefined && !from) || (value.to !== undefined && !to)) return null;
  const by = oneOf(EVENT_ACTORS, value.by);
  if (value.by !== undefined && !by) return null;
  const decision = oneOf(ANSWER_DECISIONS, value.decision);
  if (value.decision !== undefined && !decision) return null;
  return {
    id,
    at,
    sessionId,
    sessionName,
    kind,
    ...(from && { from }),
    ...(to && { to }),
    severity,
    ...(by && { by }),
    ...(decision && { decision }),
  };
}

/**
 * One line read as a record, or null when it is not one: empty, cut short by a
 * write that never finished, not JSON, too long, or a record this version does
 * not know. A line that is not a record is passed over, never fatal.
 */
export function parseRecord(line: string): HistoryRecord | null {
  if (line === "" || line.length > MAX_LINE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if ("point" in value) {
    const point = readPoint(value.point);
    return point && { kind: "point", point };
  }
  if ("event" in value) {
    const event = readEvent(value.event);
    return event && { kind: "event", event };
  }
  if ("start" in value) {
    const at = moment(value.start);
    return at === null ? null : { kind: "start", at };
  }
  if ("cleared" in value) {
    const at = moment(value.cleared);
    return at === null ? null : { kind: "cleared", at };
  }
  return null;
}

/**
 * Each start that followed history kept from before it, oldest first, with
 * the newest moment that history holds: `starts` are when Agent Lookout
 * started writing, and `times` when every record was made, starts included,
 * in any order. A start with nothing before it began the history, and is not
 * one.
 */
export function restartsAmong(
  starts: readonly number[],
  times: readonly number[],
): { at: number; lastBefore: number }[] {
  const ordered = [...times].sort((a, b) => a - b);
  const restarts: { at: number; lastBefore: number }[] = [];
  let next = 0;
  let lastBefore: number | null = null;
  for (const at of [...new Set(starts)].sort((a, b) => a - b)) {
    while (next < ordered.length && (ordered[next] as number) < at) {
      lastBefore = ordered[next] as number;
      next += 1;
    }
    if (lastBefore !== null) restarts.push({ at, lastBefore });
  }
  return restarts;
}

/** What one file held: its records in the order they were written, and how many lines were passed over. */
export interface ParsedFile {
  records: HistoryRecord[];
  skipped: number;
}

/** Every record in a file's text. A last line with no line break after it may have been cut short, and is read only if it parses. */
export function parseHistoryText(text: string): ParsedFile {
  const records: HistoryRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line.trim());
    if (record) records.push(record);
    else skipped += 1;
  }
  return { records, skipped };
}
