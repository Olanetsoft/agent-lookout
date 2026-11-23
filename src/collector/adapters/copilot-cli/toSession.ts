import type { CopilotCliStatus } from "../../../core/mapping/copilot-cli/copilotCliMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { isStale } from "../../../core/sessions/staleness.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";

export const SOURCE_ID: SourceId = "copilot-cli";

/** A session's ID in the session model, from its folder's name, the session's own ID. */
export function copilotCliId(folderName: string): string {
  return `${SOURCE_ID}:${folderName}`;
}

export interface CopilotCliSessionInput {
  /** The session folder's name, its ID. */
  folderName: string;
  /** The working folder its newest `session.resume` or `session.start` names, or null. */
  cwd: string | null;
  /** Its first `session.start`'s time, or null. */
  startedAt: number | null;
  status: CopilotCliStatus;
  /** The log's last write, or null when that time cannot be right. */
  writtenAt: number | null;
  now: number;
}

/**
 * One Copilot CLI session in the shared model.
 *
 * - The status is `copilotCliStatusOf`'s.
 * - The name is the working folder's last part, else `copilot-cli:` and its
 *   ID. `workspace.yaml`, which holds the session's name, is never read:
 *   Copilot makes that name from the first prompt, a stored name has been
 *   seen holding the prompt word for word, and a name given with `--name` or
 *   `/rename` is typed by you.
 * - The app is not known: Copilot's app and VS Code's agent host keep their
 *   sessions in the same folder, and the file that tells them apart is not read.
 * - The last write is shown only while it works.
 * - There is no pid, link, Jump or Stop.
 */
export function copilotCliSession(input: CopilotCliSessionInput): Session {
  const { folderName, cwd, status, now } = input;
  const id = copilotCliId(folderName);
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(project ?? "") || id,
    cwd,
    project,
    status: status.status,
    startedAt: plausibleTime(input.startedAt, now),
    statusSince: status.since,
    links: {},
    stale: false,
  };
  if (status.waitingReason !== undefined) session.waitingReason = status.waitingReason;
  session.stale = isStale(session, now);
  const written = input.writtenAt === null ? null : plausibleTime(Math.floor(input.writtenAt), now);
  if (status.showsLastWrite && written !== null) session.lastWriteAt = written;
  return session;
}
