import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { parseKiroTime } from "./rows.ts";

/**
 * Reading a Kiro CLI session's header, the file beside its log that names it:
 * `session.json` in a V3 session's folder, `<uuid>.json` beside a V2
 * transcript. Built from Kiro's documentation and open-source readers of its
 * files, and not yet checked on a computer running Kiro CLI.
 *
 * - It is opened without following a link, and read only as an ordinary file
 *   of 4 MiB or less.
 * - Of a V3 header only `title`, the first of `workspacePaths`, `createdAt`,
 *   `createdReason` and `parentSessionId` are read. Of a V2 header only `cwd`,
 *   `created_at`, `parent_session_id` and `session_created_reason`. A V2
 *   header's `title` is never read: it is the first prompt word for word, so a
 *   V2 session takes its folder's name. The rest, such as the model, the usage
 *   and the V2 `session_state`, is dropped with the parsed file, never copied,
 *   kept or logged.
 * - A subagent's session is marked, to be left out: in V3 one whose
 *   `createdReason` is `subagent` and that names a `parentSessionId`, and in V2
 *   one that names a `parent_session_id`, unless `session_created_reason` says
 *   it is a `rewind` or a `tangent`, a conversation the person forked. V2 writes
 *   `subagent` there for top-level sessions too.
 * - A V3 title made only of spaces, and the literal `(no title)`, are no title.
 *
 * A header remembered is opened again only when its size, modified time or
 * identity changes.
 */

/** The most of a header read. */
export const MAX_HEADER_BYTES = 4 * 1024 * 1024;

/** The longest folder kept. A longer one is not a folder. */
const MAX_FOLDER_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** What Kiro writes when a session has no title yet, as one reader saw it. */
const NO_TITLE = "(no title)";

/** What is kept of a header. */
export interface KiroHeader {
  /** The title Kiro's model gave a V3 session or the person set, or null. Always null in V2. */
  title: string | null;
  /** The folder it was started in: an absolute path, or null when the header's is not one. */
  folder: string | null;
  /** When it was made, as the header says, or null. Whether it could be right is asked later. */
  createdAt: number | null;
  /** A subagent's session, which is not listed. */
  subagent: boolean;
}

export type HeaderRead =
  | { state: "ok"; header: KiroHeader }
  /** Gone, a link or anything else at its name, an open that failed, or not a JSON object. */
  | { state: "none" }
  /** Over `MAX_HEADER_BYTES`. */
  | { state: "too-large" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An absolute path on this system's rules, or null. */
export function folderOf(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_FOLDER_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? value : null;
}

function titleOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  return title === "" || title === NO_TITLE ? null : title;
}

/** Whether a value is text with more than spaces in it. */
function named(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function objectOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The kept fields of a V3 `session.json`, or null when it is not a JSON object. */
export function parseV3Header(text: string, platform: NodeJS.Platform): KiroHeader | null {
  const value = objectOf(text);
  if (value === null) return null;
  const paths = value.workspacePaths;
  return {
    title: titleOf(value.title),
    folder: Array.isArray(paths) ? folderOf(paths[0], platform) : null,
    createdAt: parseKiroTime(value.createdAt),
    subagent: value.createdReason === "subagent" && named(value.parentSessionId),
  };
}

/** The kept fields of a V2 `<uuid>.json`, or null when it is not a JSON object. */
export function parseV2Header(text: string, platform: NodeJS.Platform): KiroHeader | null {
  const value = objectOf(text);
  if (value === null) return null;
  const reason = value.session_created_reason;
  const forked = reason === "rewind" || reason === "tangent";
  return {
    title: null,
    folder: folderOf(value.cwd, platform),
    createdAt: parseKiroTime(value.created_at),
    subagent: named(value.parent_session_id) && !forked,
  };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface HeaderReader {
  /** What a header says, given this poll's `lstat` of it, opened only when that changed. */
  read(file: string, info: FileInfo, store: "v3" | "v2"): Promise<HeaderRead>;
  /** Forgets every header not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createHeaderReader(io: ReadOnlyIo, platform: NodeJS.Platform): HeaderReader {
  const kept = new Map<string, { info: FileInfo; read: HeaderRead }>();

  async function readFile(file: string, store: "v3" | "v2"): Promise<HeaderRead> {
    try {
      const handle = await io.openRegular(file);
      try {
        const { size } = handle.info;
        if (size > MAX_HEADER_BYTES) return { state: "too-large" };
        const data = await handle.read(0, size);
        const text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
        const header =
          store === "v3" ? parseV3Header(text, platform) : parseV2Header(text, platform);
        return header === null ? { state: "none" } : { state: "ok", header };
      } finally {
        await handle.close();
      }
    } catch {
      // Gone since its `lstat`, a link or a folder at its name, or any other
      // failure. It is remembered like any read, so a file that could not be
      // opened is not tried again until it changes.
      return { state: "none" };
    }
  }

  return {
    async read(file, info, store) {
      const before = kept.get(file);
      if (before && sameFile(before.info, info)) return before.read;
      const read = await readFile(file, store);
      kept.set(file, { info, read });
      return read;
    },
    keepOnly(files) {
      for (const file of kept.keys()) {
        if (!files.has(file)) kept.delete(file);
      }
    },
  };
}
