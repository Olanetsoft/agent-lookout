import {
  grokBuildFinishedAt,
  type GrokBuildStatus,
} from "../../../core/mapping/grok-build/grokBuildMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { TerminalTab } from "../../terminal/terminalTabs.ts";
import type { TmuxPane } from "../../tmux/panes.ts";
import type { RegistryEntry } from "./registry.ts";

export const SOURCE_ID: SourceId = "grok-build";

/** A session's ID in the session model. */
export function grokBuildId(sessionId: string): string {
  return `${SOURCE_ID}:${sessionId}`;
}

/** What the parts of a session that do not hang on its status have in common. */
function base(entry: RegistryEntry, title: string | null, now: number) {
  const id = grokBuildId(entry.sessionId);
  const project = projectOf(entry.cwd);
  return {
    id,
    source: SOURCE_ID,
    surface: "terminal" as const,
    // Cleaned and cut as every other agent's name is.
    name: sessionName(title ?? "") || sessionName(project ?? "") || id,
    cwd: entry.cwd,
    project,
    startedAt: plausibleTime(entry.openedAt, now),
    pid: entry.pid,
    links: {},
  };
}

export interface GrokBuildSessionInput {
  entry: RegistryEntry;
  /** A title its `summary.json` marks as set by the person, or null. */
  title: string | null;
  status: GrokBuildStatus;
  /** The event log's modified time, or null. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Grok Build session whose process runs, in the shared model.
 *
 * - The status is `mapGrokBuildStatus`'s, a waiting one's time kept by the
 *   adapter for as long as the wait lasts. It never has a `waitingText`: what
 *   Grok Build asks is never read.
 * - Its name is a title marked as set by the person, else its folder's, else
 *   its ID. A title Grok Build made is never read.
 * - Its folder is the one Grok Build's list names, and it began when Grok
 *   Build listed it.
 * - Its last write is its event log's modified time, when that could be right.
 * - It has its process's ID, and no link or Stop. Its Jump is added by
 *   `withJump`, once the adapter has found where its process runs.
 */
export function grokBuildSession(input: GrokBuildSessionInput): Session {
  const { entry, status, now } = input;
  const session: Session = {
    ...base(entry, input.title, now),
    status: status.status,
    statusSince: status.since,
    alive: true,
    stale: false,
  };
  if (status.waitingReason !== undefined) session.waitingReason = status.waitingReason;
  session.stale = isStale(session, now);
  const writtenAt =
    input.writtenAt === null ? null : plausibleTime(Math.floor(input.writtenAt), now);
  if (writtenAt !== null) session.lastWriteAt = writtenAt;
  return session;
}

/**
 * The session with the place Jump reaches it in: the tmux pane its process was
 * found in, or else its tab of Terminal or iTerm2, as for Qwen Code. Only the
 * place's name goes to the dashboard.
 */
export function withJump(
  session: Session,
  pane: TmuxPane | undefined,
  tab: TerminalTab | undefined,
): Session {
  if (pane) return { ...session, jump: { kind: "tmux", place: pane.place } };
  if (tab) return { ...session, jump: { kind: "terminal", app: tab.app, place: tab.app } };
  return session;
}

/** What is kept of a session that has ended, to show it for a day. */
export interface FinishedGrokBuild {
  entry: RegistryEntry;
  title: string | null;
  /** Its event log's modified time, as written, or null. */
  writtenAt: number | null;
  /** When Agent Lookout first saw it end, for when neither of its own times could be right. */
  noticedAt: number;
  /**
   * Whether its process runs on with another session, as after /new: then it
   * names no process, since that one has not ended.
   */
  processRunsOn: boolean;
}

/** When a session that ended ended, judged against the clock now. */
export function finishedAtOf(record: FinishedGrokBuild, now: number): number {
  return grokBuildFinishedAt(record.entry.openedAt, record.writtenAt, now) ?? record.noticedAt;
}

/**
 * A session that has ended, in the shared model: finished since the later of
 * when Grok Build listed it and when its event log was last written, as for a
 * session a crash left listed. Its wait, if it was in one, ends with it.
 */
export function finishedGrokBuildSession(record: FinishedGrokBuild, now: number): Session {
  const { pid: _pid, ...rest } = base(record.entry, record.title, now);
  const session: Session = {
    ...rest,
    status: "finished",
    statusSince: finishedAtOf(record, now),
    stale: false,
  };
  const writtenAt =
    record.writtenAt === null ? null : plausibleTime(Math.floor(record.writtenAt), now);
  if (writtenAt !== null) session.lastWriteAt = writtenAt;
  if (record.processRunsOn) return session;
  return { ...session, pid: record.entry.pid, alive: false };
}
