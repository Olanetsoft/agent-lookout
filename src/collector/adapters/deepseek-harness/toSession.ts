import { createHash } from "node:crypto";

import type { DeepseekHarnessStatus } from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { DeepseekHarnessHeader } from "./lines.ts";

export const SOURCE_ID: SourceId = "deepseek-harness";

/** DeepSeek Harness writes a time a moment before it is on disk, and a disk can round a time down. */
export const WRITE_ORDER_SLACK_MS = 2_000;

/**
 * A session folder's name that is DeepSeek Harness's own ID as it stands: a
 * headless or new session's `session-<uuid>`, or a configured agent's
 * `<agent>-session-<uuid>` (core/agent-loop/src/index.ts:342,
 * bundle/headless/README.md:77). Any other name is made into a short hash.
 */
const PLAIN_ID =
  /^(?:[A-Za-z0-9_-]{1,64}-)?session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session's ID in Agent Lookout, from its folder's name. */
export function sessionIdOf(folderName: string): string {
  if (PLAIN_ID.test(folderName)) return `${SOURCE_ID}:${folderName}`;
  const hash = createHash("sha256").update(folderName).digest("hex").slice(0, 16);
  return `${SOURCE_ID}:h${hash}`;
}

/** When a log was last written, as a time that could be right and is not before the session began. */
export function lastWriteOf(
  writtenAt: number,
  createdAt: number | null,
  now: number,
): number | null {
  const at = plausibleTime(Math.floor(writtenAt), now);
  if (at !== null && createdAt !== null && at < createdAt - WRITE_ORDER_SLACK_MS) return null;
  return at;
}

export interface DeepseekHarnessSessionInput {
  /** The session folder's name. */
  folderName: string;
  header: DeepseekHarnessHeader;
  /** A title its model wrote or one marked as the person's, or null. */
  title: string | null;
  status: DeepseekHarnessStatus;
  /** When it or a subagent's log was last written, or null. */
  writtenAt: number | null;
  now: number;
}

/**
 * One DeepSeek Harness session in the shared model.
 *
 * - The status is `deepseekHarnessStatusOf`'s.
 * - The name is a title its model wrote or one marked as the person's, else
 *   its folder's, else its ID. Its first title, the first words of the
 *   person's first prompt, is never read.
 * - The folder is the one its header names, where it began.
 * - The last write is shown only while it works.
 * - The app is not known, and there is no pid, link, Jump or Stop.
 */
export function deepseekHarnessSession(input: DeepseekHarnessSessionInput): Session {
  const { header, title, status, writtenAt, now } = input;
  const id = sessionIdOf(input.folderName);
  const project = projectOf(header.cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(title ?? "") || sessionName(project ?? "") || id,
    cwd: header.cwd,
    project,
    status: status.status,
    startedAt: header.createdAt,
    statusSince: status.since,
    links: {},
    stale: false,
  };
  if (status.waitingReason !== undefined) session.waitingReason = status.waitingReason;
  session.stale = isStale(session, now);
  if (status.showsLastWrite && writtenAt !== null) session.lastWriteAt = writtenAt;
  return session;
}
