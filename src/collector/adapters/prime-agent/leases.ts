import path from "node:path";

import { validPid } from "../../processes/pids.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { INSTANT, SESSION_ID } from "../pi/sessionFile.ts";
import { createFolderLister } from "./folders.ts";

/**
 * Reading Prime Agent's session leases, which say which process has each
 * session open. Built from Prime Agent's source at v0.10.3 and not yet checked
 * on a computer running it.
 *
 * A process that opens a session takes its lease first: a folder
 * `session-leases/<SHA-256 of the session file's path>.lock` in Prime Agent's
 * agent folder, which it makes under another name with `owner.json` written
 * whole inside, and then renames into place (`acquire_runtime_session_lease`
 * in `crates/pa-daemon/src/lease.rs`). It gives the lease up by renaming the
 * folder to `.lock.stale-<pid>-<id>` and removing it. A crash leaves it.
 * `owner.json` is written by `serde_json::to_string_pretty`:
 *
 * `{ "version": 1, "token": "…", "pid": N, "processStartId": "…",
 *    "activeSessionId": "…", "sessionPath": "…", "createdAt": "…" }`
 *
 * So the reader:
 *
 * - lists `session-leases/` (`folders.ts`), and looks at each name of the form
 *   `<64 hex digits>.lock`, which leaves out `.lock.guard`,
 *   `.lock.candidate-*` and `.lock.stale-*`;
 * - looks each one up with `lstat`, and its `owner.json`, which must be an
 *   ordinary file of at most 8 KiB, and opens that only when its size, time
 *   or identity changed, without following a link;
 * - parses it, and keeps the pid, when the lease was taken, the start of its
 *   process as Prime Agent wrote it, the worker's ID, and the name of the
 *   session's file without its folders. The `token`, which Prime Agent
 *   compares only when it gives the lease up, the folders of `sessionPath`
 *   and anything else are dropped with the parsed file. A parse that fails
 *   keeps nothing of its error, whose words could hold the file's bytes.
 *
 * A lease that cannot be read, or whose fields are not what Prime Agent
 * writes, is kept as one that cannot be told whose it is, with its folder's
 * modified time.
 */

/** The name of a lease's folder: the SHA-256 of the session file's path, as hex. */
export const LEASE_NAME = /^[0-9a-f]{64}\.lock$/;

/** The file in a lease's folder that names its process. */
export const OWNER_FILE = "owner.json";

/** The most of `owner.json` read. Prime Agent's is a few hundred bytes. */
export const MAX_OWNER_BYTES = 8 * 1024;

/** The only version of `owner.json` Prime Agent writes. */
const OWNER_VERSION = 1;

/** A process's start as Prime Agent writes one, on Linux, on macOS and other Unix systems, and on Windows. */
const PROCESS_START_ID = /^(proc:\d{1,20}|ps:[\x20-\x7e]{1,64}|win:\d{1,20})$/;

/** A worker's ID. Prime Agent's are 12 lowercase hex digits (`new_display_id` in `util.rs`). */
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** What is kept of one lease. */
export interface Lease {
  pid: number;
  /** When the lease was taken, in epoch milliseconds. */
  createdAt: number;
  /** The start of the lease's process, as Prime Agent wrote it: `proc:…`, `ps:…` or `win:…`. */
  processStartId?: string;
  /** The ID of the worker that holds it, which names its journal. None for a print or RPC run. */
  activeSessionId?: string;
}

/** A lease that cannot be told whose it is, with why, and its folder's modified time. */
export interface StrayLease {
  name: string;
  reason: string;
  folderMtimeMs: number;
}

/** What `session-leases/` says. */
export type LeaseRead =
  | {
      state: "listed";
      /** The leases, by the ID of the session whose file each names. */
      byId: ReadonlyMap<string, readonly Lease[]>;
      stray: readonly StrayLease[];
    }
  | { state: "missing" }
  | { state: "unlistable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ID of the session a lease's `sessionPath` names, from its last name, or null. */
function sessionIdOf(sessionPath: unknown): string | null {
  if (typeof sessionPath !== "string") return null;
  const name = sessionPath.slice(
    Math.max(sessionPath.lastIndexOf("/"), sessionPath.lastIndexOf("\\")) + 1,
  );
  if (!name.endsWith(".jsonl")) return null;
  const id = name.slice(0, -".jsonl".length);
  return SESSION_ID.test(id) ? id : null;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** A lease kept, with its session's ID, or why it cannot be. */
type Parsed = { sessionId: string; lease: Lease } | { reason: string };

/**
 * What is kept of one `owner.json`, from its text. Only the fields named in
 * `Lease` are kept, each only when it is what Prime Agent writes.
 */
export function parseOwner(text: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "bad JSON" };
  }
  if (!isRecord(value)) return { reason: "bad JSON" };
  if (value.version !== OWNER_VERSION) return { reason: "another version" };
  const pid = validPid(value.pid);
  const sessionId = sessionIdOf(value.sessionPath);
  const createdAt = timeOf(value.createdAt);
  if (pid === undefined || sessionId === null || createdAt === null) {
    return { reason: "bad fields" };
  }
  const lease: Lease = { pid, createdAt };
  const start = value.processStartId;
  if (typeof start === "string" && PROCESS_START_ID.test(start)) lease.processStartId = start;
  const worker = value.activeSessionId;
  if (typeof worker === "string" && WORKER_ID.test(worker)) lease.activeSessionId = worker;
  return { sessionId, lease };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface LeaseReader {
  /** What `session-leases/` holds now. Never rejects. */
  read(now: number): Promise<LeaseRead>;
}

/** A reader of the leases in `<agent folder>/session-leases`, which keeps each until it changes. */
export function createLeaseReader(agentDir: string, io: ReadOnlyIo, sweepMs?: number): LeaseReader {
  const dir = path.join(agentDir, "session-leases");
  const folder = createFolderLister(dir, io, sweepMs);
  /** What each lease's `owner.json` said when it was last read, by the lease's name. */
  let remembered = new Map<string, { info: FileInfo; parsed: Parsed }>();

  async function lookUp(target: string): Promise<FileInfo | "missing" | "failed"> {
    try {
      return await io.lstat(target);
    } catch (error) {
      return isMissing(error) ? "missing" : "failed";
    }
  }

  async function readOwner(file: string): Promise<Parsed> {
    const open = await io.openRegular(file);
    try {
      if (open.info.size > MAX_OWNER_BYTES) return { reason: "too large" };
      const bytes = await open.read(0, MAX_OWNER_BYTES + 1);
      if (bytes.byteLength > MAX_OWNER_BYTES) return { reason: "too large" };
      return parseOwner(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"),
      );
    } finally {
      await open.close();
    }
  }

  /** One lease's folder: its lease, why it cannot be told, or null for one that went. */
  async function leaseIn(
    name: string,
    kept: Map<string, { info: FileInfo; parsed: Parsed }>,
  ): Promise<(Parsed & { folderMtimeMs: number }) | null> {
    const leaseDir = path.join(dir, name);
    const folderInfo = await lookUp(leaseDir);
    if (folderInfo === "missing") return null;
    if (folderInfo === "failed") return { reason: "cannot be looked up", folderMtimeMs: Infinity };
    const folderMtimeMs = folderInfo.mtimeMs;
    // A link at a lease's name is not followed: it would lead out of the folder.
    if (folderInfo.kind !== "directory") return { reason: "not a folder", folderMtimeMs };
    const file = path.join(leaseDir, OWNER_FILE);
    const info = await lookUp(file);
    if (info === "missing") {
      // Given up since it was listed, or a lease with no owner.
      return (await lookUp(leaseDir)) === "missing"
        ? null
        : { reason: "no owner.json", folderMtimeMs };
    }
    if (info === "failed") return { reason: "cannot be looked up", folderMtimeMs };
    if (info.kind !== "file") return { reason: "not a file", folderMtimeMs };
    if (info.size > MAX_OWNER_BYTES) return { reason: "too large", folderMtimeMs };
    const known = remembered.get(name);
    if (known && sameFile(known.info, info)) {
      kept.set(name, known);
      return { ...known.parsed, folderMtimeMs };
    }
    let parsed: Parsed;
    try {
      parsed = await readOwner(file);
    } catch {
      // Given up since its lookup, or not to be read: tried again on the next poll.
      return (await lookUp(leaseDir)) === "missing"
        ? null
        : { reason: "cannot be read", folderMtimeMs };
    }
    kept.set(name, { info, parsed });
    return { ...parsed, folderMtimeMs };
  }

  return {
    async read(now) {
      const listing = await folder.list(now);
      if (listing.state !== "listed") {
        remembered = new Map();
        return listing;
      }
      const kept = new Map<string, { info: FileInfo; parsed: Parsed }>();
      const byId = new Map<string, Lease[]>();
      const stray: StrayLease[] = [];
      for (const name of listing.names) {
        if (!LEASE_NAME.test(name)) continue;
        const found = await leaseIn(name, kept);
        if (found === null) continue;
        if ("reason" in found) {
          stray.push({ name, reason: found.reason, folderMtimeMs: found.folderMtimeMs });
          continue;
        }
        const leases = byId.get(found.sessionId) ?? [];
        leases.push(found.lease);
        byId.set(found.sessionId, leases);
      }
      remembered = kept;
      return { state: "listed", byId, stray };
    },
  };
}
