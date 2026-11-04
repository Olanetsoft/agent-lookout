import path from "node:path";

import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";

/**
 * Reading the manifest Cline's runtime keeps for each session, for the little
 * this adapter needs. Built from the source of Cline's CLI at cli-v3.0.74 and
 * not yet checked on a computer running it.
 *
 * Each session has a folder, `<sessions folder>/<session id>/`, with its
 * manifest in `<session id>.json` beside `<session id>.messages.json`, which
 * holds the whole conversation (`services/session-artifacts.ts:63-96`). Cline
 * makes a manifest at a session's first prompt, and its desktop app makes one
 * for each session it imports, already ended. Cline rewrites a manifest each
 * time the session's status, title or settings change
 * (`session/stores/session-manifest-store.ts:112-119`).
 *
 * - A manifest is opened without following a link and only inside a real
 *   folder, and read only as an ordinary file of 1 MiB or less: it holds the
 *   session's first prompt, which can be as long as what was pasted.
 * - Only `session_id`, `pid`, `started_at`, `ended_at`, `status` and `cwd` are
 *   kept. `prompt`, `provider`, `model`, `metadata`, which holds the title and
 *   can hold a system prompt, and anything Cline adds are dropped with the
 *   parsed file, never copied, kept or logged. The folder's other files are
 *   never opened.
 * - The title is dropped because it is by default the first line of the first
 *   prompt, and no field says when it is not. Comparing it with `prompt` does
 *   not tell: a fork or a restored session keeps the title it came with while
 *   its manifest holds a later prompt.
 * - A manifest of a newer format, `version` above 1, is left out, and the card
 *   says so.
 * - Cline writes a manifest in place, not through a temporary file, so a read
 *   can catch one half written. What was read of it before stands in, once.
 *
 * Each file is opened only when its size, modified time or identity changes.
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a manifest read. A session's first prompt is in it, and Cline sets no limit. */
export const MAX_MANIFEST_BYTES = 1024 * 1024;

/** The one format this reads. A higher one is a newer Cline's. */
export const MANIFEST_VERSION = 1;

/** A session's id as a folder's name: never `.` or `..`, and nothing that could leave the folder. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A time as Cline writes one, with `Date.toISOString()`. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** The longest status kept. A longer one is not a word of Cline's. */
const MAX_STATUS_LENGTH = 32;

/** The longest folder kept. A longer one is not a folder. */
const MAX_CWD_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** What is kept of one manifest. */
export interface Manifest {
  sessionId: string;
  /** The process that hosts the session, when the manifest names one that could be. */
  pid: number | null;
  /** `status` as written, or null when it has none that is a short text. */
  status: string | null;
  /** The session's folder: an absolute path, or null when the manifest's is not one. */
  cwd: string | null;
  /** `started_at` in epoch milliseconds, or null when it is not a time. */
  startedAt: number | null;
  /** `ended_at` in epoch milliseconds, or null when it is not a time. */
  endedAt: number | null;
}

export type ManifestRead =
  | {
      state: "ok";
      manifest: Manifest;
      /** The file's modified time when its status was first read as it is now. */
      statusWrittenAt: number;
    }
  /** No ordinary file in a real folder, as for a link or a session that went, or an open that failed. */
  | { state: "none" }
  /** Not a manifest this reads: broken, wrong types where it counts, or another session's. */
  | { state: "broken" }
  /** Of a newer format than this reads. */
  | { state: "newer" }
  /** Over `MAX_MANIFEST_BYTES`. */
  | { state: "too-large" };

export function isSessionFolderName(name: string): boolean {
  return SESSION_ID.test(name);
}

export function manifestPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId, `${sessionId}.json`);
}

export function messagesPath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, sessionId, `${sessionId}.messages.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function folder(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? value : null;
}

/**
 * The kept fields of a manifest, `"newer"` for one of a newer format, or null
 * for anything else: not a JSON object, or another session's. A bad value in a
 * field is treated as none.
 */
export function parseManifest(
  content: string,
  sessionId: string,
  platform: NodeJS.Platform,
): Manifest | "newer" | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { version, status } = value;
  if (typeof version !== "number") return null;
  if (version > MANIFEST_VERSION) return "newer";
  if (version !== MANIFEST_VERSION || value.session_id !== sessionId) return null;
  return {
    sessionId,
    pid: validPid(value.pid) ?? null,
    status: typeof status === "string" && status.length <= MAX_STATUS_LENGTH ? status : null,
    cwd: folder(value.cwd, platform),
    startedAt: timeOf(value.started_at),
    endedAt: timeOf(value.ended_at),
  };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface ManifestReader {
  /** What a session's manifest says, given its `lstat`, opened only when that changed. */
  read(sessionId: string, info: FileInfo): Promise<ManifestRead>;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

interface Remembered {
  info: FileInfo;
  read: ManifestRead;
  /** True once this read has stood in for a file that did not parse. */
  stoodIn: boolean;
}

/** A reader of manifests, which keeps what it read of each until it changes. */
export function createManifestReader(
  sessionsDir: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): ManifestReader {
  const remembered = new Map<string, Remembered>();

  /** The text of a manifest, `"too-large"`, or null when it is no ordinary file in a real folder. */
  async function textOf(sessionId: string): Promise<string | "too-large" | null> {
    // A link at the folder's name would lead out of the sessions folder, and
    // opening a file does not look at the names before its own.
    if ((await io.lstat(path.join(sessionsDir, sessionId))).kind !== "directory") return null;
    const handle = await io.openRegular(manifestPath(sessionsDir, sessionId));
    try {
      const { size } = handle.info;
      if (size > MAX_MANIFEST_BYTES) return "too-large";
      const bytes = await handle.read(0, size);
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async function readFile(
    sessionId: string,
    info: FileInfo,
    known: Remembered | undefined,
  ): Promise<ManifestRead> {
    let text: string | "too-large" | null;
    try {
      text = await textOf(sessionId);
    } catch {
      // Gone since its `lstat`, a link, a pipe or a folder at its name, or any
      // other failure, such as a read error: this is remembered like any read,
      // so a file that could not be opened is not tried again until it changes.
      return { state: "none" };
    }
    if (text === null) return { state: "none" };
    if (text === "too-large") return { state: "too-large" };
    const parsed = parseManifest(text, sessionId, platform);
    if (parsed === "newer") return { state: "newer" };
    if (parsed === null) return { state: "broken" };
    const before = known?.read.state === "ok" ? known.read : null;
    return {
      state: "ok",
      manifest: parsed,
      // A file rewritten with the same status keeps the time that status began,
      // so a wait stays one wait while its title or settings change.
      statusWrittenAt:
        before?.manifest.status === parsed.status ? before.statusWrittenAt : info.mtimeMs,
    };
  }

  return {
    async read(sessionId, info) {
      const known = remembered.get(sessionId);
      if (known && sameFile(known.info, info)) return known.read;
      const read = await readFile(sessionId, info, known);
      // Half written, as a read can catch it: what was read before stands in, once.
      if (read.state === "broken" && known?.read.state === "ok" && !known.stoodIn) {
        known.stoodIn = true;
        return known.read;
      }
      remembered.set(sessionId, { info, read, stoodIn: false });
      return read;
    },
    keepOnly(sessionIds) {
      for (const sessionId of remembered.keys()) {
        if (!sessionIds.has(sessionId)) remembered.delete(sessionId);
      }
    },
  };
}
