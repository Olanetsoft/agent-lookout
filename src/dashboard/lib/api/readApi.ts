import {
  HISTORY_BEGINNINGS,
  isWebhookHost,
  type EmailStatusResponse,
  type HistoryKept,
  type HistoryResponse,
  type HistoryRestart,
  type HistorySince,
  type SendResult,
  type SessionWaitTotal,
  type WaitDay,
  type WaitPeriod,
  type WaitsResponse,
  type WaitTotal,
  type WebhookStatusResponse,
} from "@core/api";
import {
  CAPABILITIES,
  EVENT_KINDS,
  EVENT_SEVERITIES,
  SESSION_STATUSES,
  SOURCE_STATES,
  SURFACES,
  TERMINAL_APPS,
  WAITING_REASONS,
  type CapabilityCell,
  type GitHead,
  type GitRepository,
  type HistoryPoint,
  type JumpTarget,
  type Session,
  type SessionEvent,
  type SessionsSnapshot,
  type SourceCapabilities,
  type SourceFact,
  type SourceHealth,
  type SourceId,
} from "@core/sessions/session";
import { NOTICE_EVENTS, type NoticeEvent } from "@core/notices/sessionChanges";
import { MAX_NAME_LENGTH } from "@core/text";

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
  const status = oneOf(SESSION_STATUSES, value.status) ?? "unknown";
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
    const reason = oneOf(WAITING_REASONS, value.waitingReason);
    if (reason) session.waitingReason = reason;
    const detail = text(value.waitingDetail);
    if (detail) session.waitingDetail = detail;
    const asking = text(value.waitingText);
    if (asking) session.waitingText = asking;
  }
  const agent = text(value.agent);
  if (agent) session.agent = agent;
  const lastWriteAt = number(value.lastWriteAt);
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  const pid = number(value.pid);
  if (pid !== null) session.pid = pid;
  if (typeof value.alive === "boolean") session.alive = value.alive;
  if (isRecord(value.links)) {
    const open = text(value.links.open);
    if (open) session.links.open = open;
  }
  const jump = readJump(value.jump);
  if (jump) session.jump = jump;
  const git = readGit(value.git);
  if (git) session.git = git;
  return session;
}

/** The longest branch shown: the collector cuts one as it cuts a session's name. */
const MAX_BRANCH_LENGTH = MAX_NAME_LENGTH;

/** A commit's ID in short, as the collector sends it, or longer. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/;

/** A repository's id, as the collector makes it: lower-case hexadecimal, or longer. */
const REPOSITORY_ID = /^[0-9a-f]{16,64}$/;

/**
 * What a session's folder has checked out: a branch, as text, or a commit, as
 * an ID, with the repository when that can be read. Null for anything else,
 * and for both at once. A repository that cannot be read leaves the branch.
 */
function readGit(value: unknown): GitHead | null {
  if (!isRecord(value)) return null;
  const head = readHead(value);
  if (head === null) return null;
  const repository = readRepository(value.repository);
  return repository === null ? head : { ...head, repository };
}

function readHead(value: Record<string, unknown>): GitHead | null {
  if (value.commit === undefined) {
    const branch = text(value.branch);
    return branch !== null && Array.from(branch).length <= MAX_BRANCH_LENGTH ? { branch } : null;
  }
  if (value.branch !== undefined) return null;
  const { commit } = value;
  return typeof commit === "string" && COMMIT_ID.test(commit) ? { commit } : null;
}

/** The repository a folder belongs to: its id and its name, as text no longer than a session's name. */
function readRepository(value: unknown): GitRepository | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  if (name === null || Array.from(name).length > MAX_NAME_LENGTH) return null;
  const { id } = value;
  return typeof id === "string" && REPOSITORY_ID.test(id) ? { id, name } : null;
}

/** The longest place a label carries. The collector cuts a long name well short of this. */
const MAX_PLACE_LENGTH = 200;

/**
 * Where the collector can take the person, or null when the answer names no
 * kind of place this page knows, names a terminal app it does not know, or
 * names the place with anything but a short text.
 */
function readJump(value: unknown): JumpTarget | null {
  if (!isRecord(value)) return null;
  const place = text(value.place);
  if (!place || place.length > MAX_PLACE_LENGTH) return null;
  if (value.kind === "tmux") return { kind: "tmux", place };
  const app = value.kind === "terminal" ? oneOf(TERMINAL_APPS, value.app) : null;
  return app ? { kind: "terminal", app, place } : null;
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
  const basis = text(value.basis);
  if (basis) source.basis = basis;
  const capabilities = readCapabilities(value.capabilities);
  if (capabilities) source.capabilities = capabilities;
  return source;
}

/** One cell of what a source can report: yes, or no or partly with the reason why. */
function readCapability(value: unknown): CapabilityCell | null {
  if (!isRecord(value)) return null;
  if (value.level === "yes") return { level: "yes" };
  const level = oneOf(["no", "partly"] as const, value.level);
  const reason = text(value.reason);
  return level && reason ? { level, reason } : null;
}

/**
 * What a source can report, or null unless every capability this page knows
 * reads as a cell. Half a row would leave blanks to be read as yes or as no.
 */
function readCapabilities(value: unknown): SourceCapabilities | null {
  if (!isRecord(value)) return null;
  const read: Partial<Record<keyof SourceCapabilities, CapabilityCell>> = {};
  for (const capability of CAPABILITIES) {
    const cell = readCapability(value[capability]);
    if (!cell) return null;
    read[capability] = cell;
  }
  return read as SourceCapabilities;
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
    severity: oneOf(EVENT_SEVERITIES, value.severity) ?? "advisory",
  };
  const from = oneOf(SESSION_STATUSES, value.from);
  if (from) event.from = from;
  const to = oneOf(SESSION_STATUSES, value.to);
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

/** Where the history begins, or null when the answer does not say in a way the page can read. */
function readSince(value: unknown): HistorySince | null {
  if (!isRecord(value)) return null;
  const at = number(value.at);
  const by = oneOf(HISTORY_BEGINNINGS, value.by);
  return at === null || by === null ? null : { at, by };
}

/** The longest folder or sentence the History card shows. The collector's own are far shorter. */
const MAX_KEPT_TEXT = 1024;

function keptText(value: unknown): string | null {
  const words = text(value);
  return words && words.length <= MAX_KEPT_TEXT ? words : null;
}

/** A count of bytes or of milliseconds: a whole number, not below zero. */
function amount(value: unknown): number | null {
  const read = number(value);
  return read !== null && read >= 0 && Number.isInteger(read) ? read : null;
}

/**
 * Where the history is kept, or null when it cannot be read. On disk it is
 * read only with its folder named, and it can be cleared only when the answer
 * says so in so many words.
 */
function readKept(value: unknown): HistoryKept | null {
  if (!isRecord(value)) return null;
  const where = oneOf(["disk", "memory"] as const, value.where);
  const maxBytes = amount(value.maxBytes);
  const maxAgeMs = amount(value.maxAgeMs);
  if (where === null || maxBytes === null || maxAgeMs === null) return null;
  const folder = where === "disk" ? keptText(value.folder) : null;
  if (where === "disk" && folder === null) return null;
  return {
    where,
    folder,
    bytes: where === "disk" ? amount(value.bytes) : null,
    maxBytes,
    maxAgeMs,
    canClear: where === "disk" && value.canClear === true,
    problem: keptText(value.problem),
  };
}

/** The most restarts read from one answer. The collector sends far fewer. */
const MAX_RESTARTS = 1_000;

/** A restart, or null when it is not one: the moment before it must come before it. */
function readRestart(value: unknown): HistoryRestart | null {
  if (!isRecord(value)) return null;
  const at = number(value.at);
  const lastBefore = number(value.lastBefore);
  return at === null || lastBefore === null || lastBefore >= at ? null : { at, lastBefore };
}

/** The restarts an answer lists, oldest first, or none when it lists none the page can read. */
function readRestarts(value: unknown): HistoryRestart[] {
  if (!Array.isArray(value)) return [];
  const restarts: HistoryRestart[] = [];
  for (const item of value.slice(0, MAX_RESTARTS)) {
    const restart = readRestart(item);
    if (restart) restarts.push(restart);
  }
  return restarts.sort((a, b) => a.at - b.at);
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
  const since = readSince(data.since);
  const kept = readKept(data.kept);
  const restarts = readRestarts(data.restarts);
  return {
    points,
    startedAt,
    ...(since !== null && { since }),
    ...(kept !== null && { kept }),
    ...(restarts.length > 0 && { restarts }),
  };
}

/** The most days and sessions read from one period. The collector sends seven days and ten sessions. */
const MAX_WAIT_ITEMS = 50;

/** How long was waited in a stretch, or null unless every figure is a count of milliseconds or of waits. */
function readWaitTotal(value: Record<string, unknown>): WaitTotal | null {
  const waitedMs = amount(value.waitedMs);
  const openMs = amount(value.openMs);
  const waits = amount(value.waits);
  const measuredMs = amount(value.measuredMs);
  if (waitedMs === null || openMs === null || waits === null || measuredMs === null) return null;
  // The part still open is part of the whole.
  return { waitedMs, openMs: Math.min(openMs, waitedMs), waits, measuredMs };
}

function readWaitDay(value: unknown): WaitDay | null {
  if (!isRecord(value)) return null;
  const day = text(value.day);
  const from = number(value.from);
  const to = number(value.to);
  const total = readWaitTotal(value);
  if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(day) || from === null || to === null) return null;
  return total && to >= from ? { day, from, to, ...total } : null;
}

function readSessionWait(value: unknown): SessionWaitTotal | null {
  if (!isRecord(value)) return null;
  const sessionId = text(value.sessionId);
  const waitedMs = amount(value.waitedMs);
  const waits = amount(value.waits);
  if (sessionId === null || waitedMs === null || waits === null) return null;
  const name = text(value.name);
  return {
    sessionId,
    name: name !== null && Array.from(name).length <= MAX_NAME_LENGTH ? name : sessionId,
    waitedMs,
    waits,
    open: value.open === true,
  };
}

function readWaitPeriod(value: unknown): WaitPeriod | null {
  if (!isRecord(value) || !Array.isArray(value.days) || !Array.isArray(value.sessions)) return null;
  const from = number(value.from);
  const to = number(value.to);
  const total = readWaitTotal(value);
  const sessionCount = amount(value.sessionCount);
  if (from === null || to === null || to < from || total === null || sessionCount === null) {
    return null;
  }
  const days: WaitDay[] = [];
  for (const item of value.days.slice(0, MAX_WAIT_ITEMS)) {
    const day = readWaitDay(item);
    if (day) days.push(day);
  }
  const sessions: SessionWaitTotal[] = [];
  const seen = new Set<string>();
  for (const item of value.sessions.slice(0, MAX_WAIT_ITEMS)) {
    const session = readSessionWait(item);
    if (!session || seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);
    sessions.push(session);
  }
  return {
    from,
    to,
    ...total,
    days: days.sort((a, b) => a.from - b.from),
    sessions: sessions.sort((a, b) => b.waitedMs - a.waitedMs),
    sessionCount: Math.max(sessionCount, sessions.length),
  };
}

/** The answer of `/api/waits`, or null when it is not one: both periods, where the history begins and where it is kept. */
export function readWaits(data: unknown): WaitsResponse | null {
  if (!isRecord(data)) return null;
  const at = number(data.at);
  const today = readWaitPeriod(data.today);
  const sevenDays = readWaitPeriod(data.sevenDays);
  const since = readSince(data.since);
  const where = oneOf(["disk", "memory"] as const, data.where);
  if (at === null || !today || !sevenDays || !since || !where) return null;
  return { at, today, sevenDays, since, where };
}

/** The longest reason or problem the page shows. The collector's own are far shorter. */
const MAX_EMAIL_WORDS = 300;

/** A short sentence from the collector, or null. */
function shortText(value: unknown): string | null {
  const words = text(value);
  return words && words.length <= MAX_EMAIL_WORDS ? words : null;
}

/** How the last email or post went. A reason that cannot be read is the plain one given. */
function readSendResult(value: unknown, plainReason: string): SendResult | null {
  if (!isRecord(value)) return null;
  const at = number(value.at);
  if (at === null) return null;
  if (value.sent === true) return { at, sent: true };
  return { at, sent: false, reason: shortText(value.reason) ?? plainReason };
}

/** The events that are emailed or posted, in their own order. A name the page does not know is passed over. Null when none is known. */
function readSentEvents(value: unknown): NoticeEvent[] | null {
  if (!Array.isArray(value)) return null;
  const named = value.filter((name): name is string => typeof name === "string");
  const events = NOTICE_EVENTS.filter((event) => named.includes(event));
  return events.length > 0 ? events : null;
}

/**
 * The answer of `/api/email`. Email counts as on only when the answer says so
 * and gives the address, the events and the delay, so a broken answer never
 * claims that emails are going out.
 */
export function readEmailStatus(data: unknown): EmailStatusResponse | null {
  if (!isRecord(data) || typeof data.on !== "boolean") return null;
  const to = shortText(data.to);
  const events = readSentEvents(data.events);
  const afterMs = number(data.afterMs);
  const on = data.on && to !== null && events !== null && afterMs !== null && afterMs >= 0;
  return {
    on,
    to: on ? to : null,
    events: on ? events : null,
    afterMs: on ? afterMs : null,
    // A version of the app that does not say never sends it.
    asking: on ? data.asking === true : null,
    problem: on ? null : shortText(data.problem),
    last: on ? readSendResult(data.last, "the email could not be sent") : null,
    limitedUntil: on ? number(data.limitedUntil) : null,
  };
}

/**
 * The answer of `/api/webhook`. The webhook counts as on only when the answer
 * says so and gives a host, the events and the delay, so a broken answer never
 * claims that posts are going out. A host that is more than a host is not
 * shown: the page never shows a path. The collector takes a host by the same
 * rule, `isWebhookHost`, so it never posts to one that this reads as off.
 */
export function readWebhookStatus(data: unknown): WebhookStatusResponse | null {
  if (!isRecord(data) || typeof data.on !== "boolean") return null;
  const host = shortText(data.host);
  const events = readSentEvents(data.events);
  const afterMs = number(data.afterMs);
  const on =
    data.on &&
    host !== null &&
    isWebhookHost(host) &&
    events !== null &&
    afterMs !== null &&
    afterMs >= 0;
  return {
    on,
    host: on ? host : null,
    events: on ? events : null,
    afterMs: on ? afterMs : null,
    asking: on ? data.asking === true : null,
    problem: on ? null : shortText(data.problem),
    last: on ? readSendResult(data.last, "the post could not be sent") : null,
    limitedUntil: on ? number(data.limitedUntil) : null,
  };
}
