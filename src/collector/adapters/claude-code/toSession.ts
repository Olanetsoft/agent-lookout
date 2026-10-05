import {
  claudeCodeOpenLink,
  mapClaudeCodeStatus,
  mapClaudeCodeSurface,
  type ClaudeCodeOrigin,
} from "../../../core/mapping/claudeCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { TmuxPane } from "../../tmux/panes.ts";
import type { FeedEntry } from "./feed.ts";
import type { RegistryEntry } from "./registry.ts";

// It lived here before the second adapter needed it, and is still reached here.
export { projectOf };

export const SOURCE_ID: SourceId = "claude-code";

export interface SessionContext {
  /** Epoch milliseconds of this poll. */
  now: number;
  isAlive: (pid: number) => boolean;
  /** The tmux pane a process was last found in, when panes are looked for. */
  paneOf?: (pid: number) => TmuxPane | undefined;
}

/** Whether a process exists. A process owned by someone else still exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A session's start time and its first status time are written a moment apart,
 * and nothing promises which comes first. A status time this little before the
 * start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

interface Fields {
  pid?: number;
  sessionId?: string;
  /** The background job id, when there is one. */
  jobId?: string;
  cwd?: string;
  name?: string;
  startedAt?: number;
  status?: string;
  state?: string;
  waitingFor?: string;
  entrypoint?: string;
  statusUpdatedAt?: number;
}

function build(fields: Fields, origin: ClaudeCodeOrigin, context: SessionContext): Session {
  const id = `${SOURCE_ID}:${fields.sessionId ?? fields.jobId ?? fields.pid}`;
  const project = projectOf(fields.cwd);
  const surface = mapClaudeCodeSurface(fields.entrypoint);
  const mapped = mapClaudeCodeStatus(fields, origin);
  const open = claudeCodeOpenLink(surface, fields.sessionId);

  // A time that cannot be right is not known. Showing it would produce rows
  // that are impossible: idle since 1970, or stale a second after starting.
  const startedAt = plausibleTime(fields.startedAt, context.now);
  let statusSince = plausibleTime(fields.statusUpdatedAt, context.now);
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the session did.
    statusSince = null;
  }

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface,
    // A name made only of spaces is no name.
    name: fields.name?.trim() || project || id,
    cwd: fields.cwd ?? null,
    project,
    ...mapped,
    startedAt,
    statusSince,
    links: open ? { open } : {},
    stale: isStale({ status: mapped.status, statusSince }, context.now),
  };
  if (fields.pid !== undefined) {
    session.pid = fields.pid;
    session.alive = context.isAlive(fields.pid);
    // Only the place's name goes to the dashboard. The pane's id stays with
    // the collector, which is the one that acts on it.
    const pane = session.alive ? context.paneOf?.(fields.pid) : undefined;
    if (pane) session.jump = { kind: "tmux", place: pane.place };
  }
  return session;
}

/**
 * Whether a registry file describes the session the feed listed.
 *
 * The two are joined on the pid, and a pid alone can mislead: a file left by an
 * earlier process can carry the same number. So a file that names a different
 * session is not used. When the session cannot be compared by name, a file
 * whose status is older than the session itself is not used either.
 */
function describesSameSession(entry: FeedEntry, registry: RegistryEntry): boolean {
  if (entry.sessionId !== undefined && registry.sessionId !== undefined) {
    return entry.sessionId === registry.sessionId;
  }
  // Neither names the session to compare, so the times are the only evidence.
  if (
    entry.startedAt !== undefined &&
    registry.statusUpdatedAt !== undefined &&
    registry.statusUpdatedAt < entry.startedAt - WRITE_ORDER_SLACK_MS
  ) {
    return false;
  }
  return true;
}

/**
 * A session from the supported feed, enriched from its registry file when there
 * is one that describes the same session. The feed decides what the session is
 * and what it is doing; the registry only adds the app and, unless it gives a
 * different status, the time that status began. Used for the background jobs only
 * the feed knows, and for every session while the registry cannot be relied on.
 *
 * The feed's answer can be a few seconds old. When the registry has already
 * moved to another status, its time is when that one began, not the one the
 * feed still reports. Passing it on would move a waiting session's status time
 * while the feed still calls it waiting, which reads as a new wait. So the time
 * is left unknown until the two agree.
 */
export function sessionFromFeed(
  entry: FeedEntry,
  registry: RegistryEntry | undefined,
  context: SessionContext,
): Session {
  const enrichment =
    registry !== undefined && describesSameSession(entry, registry) ? registry : undefined;
  // A file with no status of its own contradicts nothing.
  const sameStatus =
    enrichment !== undefined &&
    (enrichment.status === undefined ||
      mapClaudeCodeStatus(enrichment, "registry").status ===
        mapClaudeCodeStatus(entry, "feed").status);
  return build(
    {
      pid: entry.pid,
      sessionId: entry.sessionId,
      jobId: entry.id,
      cwd: entry.cwd,
      name: entry.name,
      startedAt: entry.startedAt,
      status: entry.status,
      state: entry.state,
      waitingFor: entry.waitingFor,
      entrypoint: enrichment?.entrypoint,
      statusUpdatedAt: sameStatus ? enrichment.statusUpdatedAt : undefined,
    },
    "feed",
    context,
  );
}

/** A session from its registry file alone: the usual way a running session is read. */
export function sessionFromRegistry(entry: RegistryEntry, context: SessionContext): Session {
  return build(entry, "registry", context);
}

/**
 * Removes sessions that share an id, which Claude Code has been seen to produce
 * by listing one session twice. The copy with a live process is kept; failing
 * that, the first.
 */
export function uniqueById(sessions: Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const session of sessions) {
    const kept = byId.get(session.id);
    if (!kept || (kept.alive === false && session.alive === true)) byId.set(session.id, session);
  }
  return [...byId.values()];
}
