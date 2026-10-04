import type { HistoryResponse } from "@core/api";
import type {
  EventKind,
  EventSeverity,
  HistoryPoint,
  Session,
  SessionEvent,
  SessionsSnapshot,
  SessionStatus,
  SourceFact,
  SourceHealth,
  SourceId,
  SourceState,
  Surface,
  WaitingReason,
} from "@core/session";

/**
 * Reads what the API sent into the shapes the page draws.
 *
 * The page never trusts the shape of an answer. The collector is the same
 * program today, but a later adapter or host can get a field wrong, and one
 * wrong field must not take the whole page down. Each item is read on its own:
 * a field that is missing or of the wrong kind is replaced by the honest
 * "not known" value for that field, and an item that cannot be identified at all
 * is left out.
 *
 * A reader returns null when the answer as a whole is not what the route sends.
 */

const SURFACES: readonly Surface[] = [
  "terminal",
  "vscode",
  "desktop",
  "cloud",
  "browser",
  "unknown",
];
const STATUSES: readonly SessionStatus[] = [
  "needs-you",
  "working",
  "idle",
  "finished",
  "failed",
  "unknown",
];
const REASONS: readonly WaitingReason[] = ["permission", "question", "other"];
const SOURCE_STATES: readonly SourceState[] = ["ok", "searching", "unavailable", "error"];
const EVENT_KINDS: readonly EventKind[] = ["appeared", "status-changed", "ended"];
const SEVERITIES: readonly EventSeverity[] = ["advisory", "warning", "critical"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string with something in it, or null. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A finite number, or null. */
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/** Reads each item, leaves out the ones that cannot be read, and keeps the first of any id. */
function readList<T extends { id: string }>(
  values: readonly unknown[],
  read: (value: unknown) => T | null,
): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const value of values) {
    const item = read(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/** One session, or null when it has no id or no source to tell it apart by. */
export function readSession(value: unknown): Session | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const source = text(value.source);
  if (!id || !source) return null;

  const project = text(value.project);
  const status = oneOf(STATUSES, value.status) ?? "unknown";
  const session: Session = {
    id,
    // A source this build has never heard of is kept. Anything that looks a
    // source up by its id has to allow for one that is not there.
    source: source as SourceId,
    surface: oneOf(SURFACES, value.surface) ?? "unknown",
    name: text(value.name) ?? project ?? id,
    cwd: text(value.cwd),
    project,
    status,
    startedAt: number(value.startedAt),
    statusSince: number(value.statusSince),
    links: {},
    stale: value.stale === true,
  };

  if (status === "needs-you") {
    const reason = oneOf(REASONS, value.waitingReason);
    if (reason) session.waitingReason = reason;
    const detail = text(value.waitingDetail);
    if (detail) session.waitingDetail = detail;
  }
  const pid = number(value.pid);
  if (pid !== null) session.pid = pid;
  if (typeof value.alive === "boolean") session.alive = value.alive;
  if (isRecord(value.links)) {
    const open = text(value.links.open);
    if (open) session.links.open = open;
  }
  return session;
}

/** One source's health, or null when it has no id. */
export function readSource(value: unknown, generatedAt: number): SourceHealth | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (!id) return null;

  const source: SourceHealth = {
    id: id as SourceId,
    label: text(value.label) ?? id,
    // A state this page does not know is not reported as healthy.
    state: oneOf(SOURCE_STATES, value.state) ?? "error",
    checkedAt: number(value.checkedAt) ?? generatedAt,
  };
  const detail = text(value.detail);
  if (detail) source.detail = detail;
  if (Array.isArray(value.watching)) {
    const watching: SourceFact[] = [];
    for (const item of value.watching) {
      const fact = readFact(item);
      if (fact) watching.push(fact);
    }
    source.watching = watching;
  }
  const advice = text(value.advice);
  if (advice) source.advice = advice;
  return source;
}

/** One thing a source reads or runs. Both halves must be text, or it says nothing. */
function readFact(value: unknown): SourceFact | null {
  if (!isRecord(value)) return null;
  const label = text(value.label);
  const fact = text(value.value);
  return label && fact ? { label, value: fact } : null;
}

/** The answer of `/api/sessions`. */
export function readSnapshot(data: unknown): SessionsSnapshot | null {
  if (!isRecord(data) || !Array.isArray(data.sessions) || !Array.isArray(data.sources)) return null;
  const generatedAt = number(data.generatedAt);
  if (generatedAt === null) return null;

  return {
    generatedAt,
    sources: readList(data.sources, (value) => readSource(value, generatedAt)),
    sessions: readList(data.sessions, readSession),
  };
}

/** One event, or null when it has no id or no time. */
export function readEvent(value: unknown): SessionEvent | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const at = number(value.at);
  if (!id || at === null) return null;

  const sessionId = text(value.sessionId) ?? "";
  const event: SessionEvent = {
    id,
    at,
    sessionId,
    sessionName: text(value.sessionName) ?? (sessionId || "A session"),
    kind: oneOf(EVENT_KINDS, value.kind) ?? "status-changed",
    severity: oneOf(SEVERITIES, value.severity) ?? "advisory",
  };
  const from = oneOf(STATUSES, value.from);
  if (from) event.from = from;
  const to = oneOf(STATUSES, value.to);
  if (to) event.to = to;
  return event;
}

/** The answer of `/api/events`. */
export function readEvents(data: unknown): SessionEvent[] | null {
  if (!isRecord(data) || !Array.isArray(data.events)) return null;
  return readList(data.events, readEvent);
}

function readPoint(value: unknown): HistoryPoint | null {
  if (!isRecord(value)) return null;
  const at = number(value.at);
  const needsYou = number(value.needsYou);
  const working = number(value.working);
  const idle = number(value.idle);
  const total = number(value.total);
  if (at === null || needsYou === null || working === null || idle === null || total === null) {
    return null;
  }
  return { at, needsYou, working, idle, total };
}

/** The answer of `/api/history`. */
export function readHistory(data: unknown): HistoryResponse | null {
  if (!isRecord(data) || !Array.isArray(data.points)) return null;
  const startedAt = number(data.startedAt);
  if (startedAt === null) return null;

  const points: HistoryPoint[] = [];
  for (const value of data.points) {
    const point = readPoint(value);
    if (point) points.push(point);
  }
  return { points, startedAt };
}
