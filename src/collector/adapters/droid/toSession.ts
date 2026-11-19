import { mapDroidStatus } from "../../../core/mapping/droid/droidMapping.ts";
import { projectOf } from "../../../core/sessions/project.ts";
import type { Session, SourceId } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { plausibleTime } from "../../../core/time.ts";
import type { DroidSessionFile } from "./sessionFile.ts";

export const SOURCE_ID: SourceId = "droid";

export interface DroidSessionInput {
  file: DroidSessionFile;
  /** Whether Droid may have it open: a `droid` program runs, or whether one does is not known. */
  open: boolean;
  /** The file's modified time. */
  writtenAt: number;
  now: number;
}

/**
 * One Droid session in the shared model.
 *
 * - The status is unknown while Droid may have it open and finished once it
 *   cannot (`mapDroidStatus`). It never shows as working, as needing you or as
 *   failed.
 * - The name is its folder's, else its ID. Droid's own title is made from the
 *   first prompt, or from a rename, and is never kept.
 * - The status time of a finished session is the file's last write, the last
 *   thing known of it. An unknown status has no time. Its first line has no
 *   time of its own, so when it started is not known.
 * - The app is not known: the file does not say whether the terminal, an
 *   editor, Factory's app or `droid exec` wrote it. It has no pid, no link, no
 *   Jump and no Stop. There is no last write: the page says how quiet a
 *   working session is, and this is never one.
 */
export function droidSession({ file, open, writtenAt, now }: DroidSessionInput): Session {
  const status = mapDroidStatus(open);
  const id = `${SOURCE_ID}:${file.id}`;
  const project = projectOf(file.cwd);
  return {
    id,
    source: SOURCE_ID,
    surface: "unknown",
    // Cleaned and cut as every other agent's name is.
    name: sessionName(project ?? "") || id,
    cwd: file.cwd,
    project,
    status,
    startedAt: null,
    statusSince: status === "finished" ? plausibleTime(Math.floor(writtenAt), now) : null,
    links: {},
    stale: false,
  };
}
