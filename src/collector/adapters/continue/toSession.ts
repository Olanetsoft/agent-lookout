import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { IndexedSession } from "./sessionIndex.ts";

export const SOURCE_ID: SourceId = "continue";

/**
 * One Continue session in the shared model.
 *
 * - The status is always unknown, with no time. Continue writes nothing that says
 *   a session runs or has ended, and `cn` shows in `ps` as `node`, so there is no
 *   mapping of its states: no state of a session is read. It never shows as
 *   working, as needing you or as finished.
 * - It is named by its folder's name, else its id. Continue's title can be a line
 *   of the first prompt, so it is not kept (`sessionIndex.ts`).
 * - The app is not known. An editor's session can be told from `cn`'s by the form
 *   of its folder, and nothing is shown from that.
 * - It has no pid, no link, no Jump and no Stop. There is no last write: the page
 *   says how quiet a working session is, and this is never one.
 */
export function continueSession(session: IndexedSession, now: number): Session {
  const id = `${SOURCE_ID}:${session.id}`;
  const project = projectOf(session.folder);
  return {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    name: project ?? id,
    cwd: session.folder,
    project,
    status: "unknown",
    startedAt: plausibleTime(session.createdAt, now),
    statusSince: null,
    links: {},
    stale: false,
  };
}
