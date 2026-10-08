import path from "node:path";

import type { Session } from "../../../../core/sessions/session.ts";
import type { FileInfo, ReadOnlyIo } from "../../../files/readOnlyIo.ts";

/**
 * Where a Claude Code session's transcript is, and how its end is read.
 *
 * A session's transcript is `<claude home>/projects/<folder>/<sessionId>.jsonl`,
 * where the folder is the session's folder with every character that is not a
 * letter or a digit made a `-`: `/Users/a/b.c` is kept in `-Users-a-b-c`. None
 * of this is documented (seen on Claude Code 2.1.28x), so when the file is not
 * in that folder every folder in `projects` is looked in for it.
 *
 * The file is opened with the same care as a registry file: a link is not
 * followed and a pipe or a device is not read (`openRegularFile` in
 * `src/collector/files/readOnlyIo.ts`). The folders above it are followed when
 * they are links, as Codex's are. A transcript can run to many megabytes, so
 * only its last 256 KB are read, by position.
 */

/** The most of a transcript's end that is read, in bytes. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

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

/** What is known of a transcript when its end was last read, so it is not read again unchanged. */
export interface TranscriptStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

export type TailRead =
  /** The file is as it was. Nothing was read. */
  | { unchanged: true; stamp: TranscriptStamp }
  | {
      unchanged: false;
      stamp: TranscriptStamp;
      /** The end of the file, decoded. */
      tail: string;
      /** Whether that is the whole file, so its first line is whole too. */
      fromStart: boolean;
    };

function stampOf(info: FileInfo): TranscriptStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino };
}

function sameStamp(a: TranscriptStamp, b: TranscriptStamp): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Reads the end of a transcript: at most its last 256 KB, by position. When
 * the file is as `known` says, by its size, its modified time and its identity
 * on disk, nothing is read.
 *
 * Rejects for a file that is not there, and for a link, a pipe, a device or a
 * folder, which `openRegular` will not open.
 */
export async function readTranscriptTail(
  file: string,
  io: Pick<ReadOnlyIo, "openRegular">,
  known: TranscriptStamp | null,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<TailRead> {
  const open = await io.openRegular(file);
  try {
    const stamp = stampOf(open.info);
    if (known !== null && sameStamp(known, stamp)) return { unchanged: true, stamp };
    const start = Math.max(0, stamp.size - maxBytes);
    const bytes = await open.read(start, stamp.size - start);
    // A letter cut in two at the start is in the first line, which is not read.
    return {
      unchanged: false,
      stamp,
      tail: new TextDecoder("utf-8").decode(bytes),
      fromStart: start === 0,
    };
  } finally {
    await open.close();
  }
}
