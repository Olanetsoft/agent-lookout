import {
  claudeCodeOpenLink,
  mapClaudeCodeStatus,
  mapClaudeCodeSurface,
  type ClaudeCodeOrigin,
} from "../../../core/mapping/claudeCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { EditorWindow } from "../../editor/editorWindows.ts";
import { isFolderPath } from "../../editor/openFolder.ts";
import type { TerminalTab } from "../../terminal/terminalTabs.ts";
import type { TmuxPane } from "../../tmux/panes.ts";
import type { FeedEntry } from "./feed.ts";
import type { RegistryEntry } from "./registry.ts";

export const SOURCE_ID: SourceId = "claude-code";

export interface SessionContext {
  /** Epoch milliseconds of this poll. */
  now: number;
  isAlive: (pid: number) => boolean;
  /** The tmux pane a process was last found in, when panes are looked for. */
  paneOf?: (pid: number) => TmuxPane | undefined;
  /** The Terminal or iTerm2 tab a process was found in, when tabs are looked for. */
  tabOf?: (pid: number) => TerminalTab | undefined;
  /** The editor a process was found under, when editors are looked for. */
  editorOf?: (pid: number) => EditorWindow | undefined;
  /**
   * The person's home folder, which is never opened in an editor, as it is
   * named and with its links followed (`homeFolders`). Without it no session is
   * reached through its editor.
   */
  homeDirs?: readonly [string, ...string[]];
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
    // A name made only of spaces is no name. It is cleaned and cut as every other agent's is.
    name: sessionName(fields.name ?? "") || project || id,
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
    // Only the place's name goes to the dashboard. The pane's id, the tab's
    // terminal and the path of the editor's app stay with the collector, which
    // is the one that acts on them. A session of the VS Code extension is
    // reached through the window of the editor its process runs under, when
    // its folder is one an editor may be handed. For any other a pane comes
    // first: a session in tmux is reached through tmux.
    const editor =
      session.alive &&
      surface === "vscode" &&
      context.homeDirs !== undefined &&
      isFolderPath(session.cwd, ...context.homeDirs)
        ? context.editorOf?.(fields.pid)
        : undefined;
    const pane = session.alive && !editor ? context.paneOf?.(fields.pid) : undefined;
    const tab = session.alive && !editor && !pane ? context.tabOf?.(fields.pid) : undefined;
    if (editor) session.jump = { kind: "editor", app: editor.app, place: editor.app };
    else if (pane) session.jump = { kind: "tmux", place: pane.place };
    else if (tab) session.jump = { kind: "terminal", app: tab.app, place: tab.app };
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

/** The last answer the command gave, and when it was asked. */
export interface FeedAnswer {
  askedAt: number;
  entries: readonly FeedEntry[];
}

/**
 * How the command says a live background job stands, which the job's registry
 * file does not hold. It is used only while the file has said idle since before
 * the command was asked, and the command called the process idle too, so a
 * state from before a newer turn is never used.
 */
function jobStateOf(
  entry: RegistryEntry,
  answer: FeedAnswer,
  now: number,
): Pick<FeedEntry, "state" | "waitingFor"> | undefined {
  if (entry.status !== "idle" || entry.state !== undefined) return undefined;
  const since = plausibleTime(entry.statusUpdatedAt, now);
  if (since === null || since > answer.askedAt) return undefined;
  const job = answer.entries.find(
    (listed) => listed.pid === entry.pid && describesSameSession(listed, entry),
  );
  return job?.status === "idle" && job.state !== undefined
    ? { state: job.state, waitingFor: job.waitingFor }
    : undefined;
}

/**
 * A session from its registry file, the usual way a running session is read,
 * with the state of a background job from the command's last answer, if any.
 */
export function sessionFromRegistry(
  entry: RegistryEntry,
  context: SessionContext,
  answer: FeedAnswer | null = null,
): Session {
  const state = answer === null ? undefined : jobStateOf(entry, answer, context.now);
  return build({ ...entry, ...state }, "registry", context);
}

/** How much a status says of which copy of a session to show. */
const COPY_RANK = new Map<Session["status"], number>([
  ["needs-you", 2],
  ["working", 1],
]);

/** Whether one copy of a session is shown in place of another. */
function shownBefore(copy: Session, kept: Session): boolean {
  if (copy.alive !== true || kept.alive !== true) return copy.alive === true;
  const rank = (session: Session) => COPY_RANK.get(session.status) ?? 0;
  return rank(copy) === rank(kept)
    ? (copy.statusSince ?? 0) > (kept.statusSince ?? 0)
    : rank(copy) > rank(kept);
}

/**
 * Keeps one copy of each session. Two Claude Code processes can have one
 * session open, as when it is resumed in a second terminal, and Claude Code has
 * been seen to list one session twice. A copy with a live process comes first.
 * Of those, the one that needs the person, then one that works, then the rest,
 * and of two alike the one whose status began last. Its process is the one Jump,
 * Stop and an answer act on. Failing all that, the first is kept.
 */
export function uniqueById(sessions: Session[]): Session[] {
  const byId = new Map<string, Session>();
  for (const session of sessions) {
    const kept = byId.get(session.id);
    if (!kept || shownBefore(session, kept)) byId.set(session.id, session);
  }
  return [...byId.values()];
}

/** The ids of the sessions two live processes have open. */
export function openTwice(sessions: readonly Session[]): Set<string> {
  const pids = new Map<string, number>();
  const twice = new Set<string>();
  for (const { id, pid, alive } of sessions) {
    if (alive !== true || pid === undefined) continue;
    if ((pids.get(id) ?? pid) !== pid) twice.add(id);
    pids.set(id, pid);
  }
  return twice;
}
