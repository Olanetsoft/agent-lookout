import type {
  AutohandMode,
  MetadataFacts,
} from "../../../core/mapping/autohand-code/autohandCodeMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type {
  Session,
  SessionStatus,
  SourceId,
  Surface,
  WaitingReason,
} from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { plausibleTime } from "../../../core/time.ts";

export const SOURCE_ID: SourceId = "autohand-code";

/** A session's times and its file's are written a moment apart. A time this little before the start is the same moment. */
const WRITE_ORDER_SLACK_MS = 1_000;

/** What one Autohand Code session is shown from. */
export interface AutohandCodeSessionInput {
  sessionId: string;
  status: SessionStatus;
  waitingReason?: WaitingReason;
  statusSince: number | null;
  /** Its `metadata.json`, when it was read. */
  facts: MetadataFacts | null;
  /** When its `metadata.json` was last written, or null. */
  writtenAt: number | null;
  /** Of its heartbeat now, or as last seen: its folder, mode and when the session was made. */
  heartbeat: {
    workspaceRoot: string | null;
    mode: AutohandMode | null;
    startedAt: number | null;
  } | null;
  /** The process of the heartbeat chosen on this poll, with whether it runs. */
  process: { pid: number; alive: boolean } | null;
  now: number;
}

/**
 * The app a session runs in: VS Code when its `metadata.json` says so, else a
 * terminal for a heartbeat in a terminal or for one prompt, none known for one
 * that serves a client, and else a terminal when its `metadata.json` says so.
 */
function surfaceOf(facts: MetadataFacts | null, mode: AutohandMode | null | undefined): Surface {
  if (facts?.client === "vscode") return "vscode";
  if (mode === "interactive" || mode === "command") return "terminal";
  if (mode === "rpc") return "unknown";
  return facts?.client === "terminal" ? "terminal" : "unknown";
}

/**
 * One Autohand Code session in the shared model.
 *
 * - Its name is the one you gave it with `/rename` or `autohand --rename`,
 *   else its folder's, else its id. Autohand Code's own title is never looked for.
 * - Its folder is its `metadata.json`'s `projectPath`, else its heartbeat's
 *   `workspaceRoot`.
 * - It started when its `metadata.json` says it was made, else when its
 *   heartbeat says so.
 * - Its last write is when its `metadata.json` was last written, never the
 *   heartbeat's, which is rewritten every 5 seconds whatever the session does.
 * - It has its process only from this poll's heartbeat. It has no link, no
 *   Jump, no Stop and nothing it asks.
 */
export function autohandCodeSession(input: AutohandCodeSessionInput): Session {
  const { facts, heartbeat, now, status } = input;
  const id = `${SOURCE_ID}:${input.sessionId}`;
  const cwd = facts?.projectPath ?? heartbeat?.workspaceRoot ?? null;
  const project = projectOf(cwd);
  const startedAt =
    plausibleTime(facts?.createdAt ?? null, now) ??
    plausibleTime(heartbeat?.startedAt ?? null, now);
  const written = plausibleTime(input.writtenAt === null ? null : Math.floor(input.writtenAt), now);
  const lastWriteAt =
    written !== null && startedAt !== null && written < startedAt - WRITE_ORDER_SLACK_MS
      ? null
      : written;

  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: surfaceOf(facts, heartbeat?.mode),
    name: facts?.title ?? project ?? id,
    cwd,
    project,
    status,
    ...(status === "needs-you" && input.waitingReason !== undefined
      ? { waitingReason: input.waitingReason }
      : {}),
    startedAt,
    statusSince: input.statusSince,
    links: {},
    stale: isStale({ status, statusSince: input.statusSince }, now),
  };
  if (input.process !== null) {
    session.pid = input.process.pid;
    session.alive = input.process.alive;
  }
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  return session;
}
