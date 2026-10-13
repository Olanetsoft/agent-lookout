import path from "node:path";

import type { Session } from "../../../../core/sessions/session.ts";
import type { ReadOnlyIo } from "../../../files/readOnlyIo.ts";

/**
 * Where a Claude Code session's transcript is.
 *
 * A session's transcript is `<claude home>/projects/<folder>/<sessionId>.jsonl`,
 * where the folder is the session's folder with every character that is not a
 * letter or a digit made a `-`: `/Users/a/b.c` is kept in `-Users-a-b-c`. None
 * of this is documented (seen on Claude Code 2.1.28x), so when the file is not
 * in that folder every folder in `projects` is looked in for it.
 *
 * The folders above it are followed when they are links, as Codex's are. Its
 * end is read by `readTranscriptTail` in `src/collector/files/transcriptTail.ts`,
 * which opens only an ordinary file and reads at most its last 256 KB.
 */

/** A Claude Code session id. Nothing else is ever made part of a path. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a session id that may name a transcript. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** The id a Claude Code session is given in the session model, before its own. */
const ID_PREFIX = "claude-code:";

/**
 * A Claude Code session's own id, from its id in the session model, when it
 * has one that may name a transcript. Null for any other session, and for a
 * background job known only by its job id.
 */
export function sessionIdOf(session: Pick<Session, "id" | "source">): string | null {
  if (session.source !== "claude-code" || !session.id.startsWith(ID_PREFIX)) return null;
  const id = session.id.slice(ID_PREFIX.length);
  return isSessionId(id) ? id : null;
}

/**
 * The folder Claude Code keeps a session's transcript in, named for the
 * session's folder: every character that is not a letter or a digit becomes a
 * `-`. What it gives cannot name a folder above `projects`.
 */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The transcript's name in its folder. */
function fileName(sessionId: string): string {
  return `${sessionId}.jsonl`;
}

/**
 * Finds a session's transcript: in the folder named for its folder first, and
 * otherwise in every folder in `projects`. Null when it is in none of them, or
 * when the session id is not one.
 */
export async function findTranscript(
  projectsDir: string,
  sessionId: string,
  cwd: string | null,
  io: Pick<ReadOnlyIo, "readdir" | "lstat">,
): Promise<string | null> {
  if (!isSessionId(sessionId)) return null;
  const name = fileName(sessionId);

  const isFile = async (file: string) => {
    try {
      return (await io.lstat(file)).kind === "file";
    } catch {
      return false;
    }
  };

  if (cwd !== null && cwd !== "") {
    const likely = path.join(projectsDir, projectFolderName(cwd), name);
    if (await isFile(likely)) return likely;
  }

  let folders: string[];
  try {
    folders = await io.readdir(projectsDir);
  } catch {
    return null;
  }
  const candidates = folders
    .filter((folder) => folder !== "" && !folder.startsWith("."))
    .sort()
    .map((folder) => path.join(projectsDir, folder, name));
  const found = await Promise.all(candidates.map(isFile));
  return candidates.find((_, index) => found[index]) ?? null;
}
