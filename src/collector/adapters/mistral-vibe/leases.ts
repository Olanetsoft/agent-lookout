import path from "node:path";

import { SUBAGENT_ID_PREFIX, VIBE_SESSION_ID } from "../../../core/mapping/mistralVibeMapping.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { isRecord } from "./envelope.ts";

/**
 * The folder where Vibe keeps a lease for each session a Vibe program has
 * open: `<session folder>/active/` (harness/.../vibe/_storage.py,
 * `SessionLease`, at 2.26.1).
 *
 * To take a lease, Vibe makes `<id>.lock` under a lock on the folder itself
 * (`.registry`), locks it with the system's file lock, then writes
 * `<id>.lock.json`:
 * `{"acquired_at":"<UTC time>","lease_version":1,"process_id":<pid>,"session_id":"<id>"}`.
 * To let it go, it unlocks and deletes `<id>.lock`, then `<id>.lock.json`. A
 * program that crashes leaves both behind. The folder also holds short-lived
 * `.watch-<hex>` files of Vibe's own, and the lease Vibe takes while it
 * clears old process output, `process-output-cleanup`, which is no session's.
 *
 * Vibe's own programs tell a held lease by trying its lock. This adapter
 * never does: it lists the folder and reads `<id>.lock.json` alone, and never
 * opens, locks or makes anything else there. So it cannot tell a lease a
 * crashed program left behind from a held one but by the pid the `.json`
 * names: a pid that runs is held, one that does not is left behind.
 */
export const LEASE_DIR = "active";

/** The lease Vibe takes while it clears the output of processes it ran: no session's. */
export const NOT_A_SESSION_LEASE = "process-output-cleanup";

/** The most of a `.lock.json` read. Vibe writes about a hundred bytes. */
export const LEASE_FILE_LIMIT_BYTES = 4 * 1024;

const LOCK = ".lock";
const LOCK_JSON = ".lock.json";

/** What a session's `.lock.json` says. */
export interface Lease {
  /** The process that took the lease. Null when the file is missing, being written, or cannot be read. */
  pid: number | null;
  /** When it was taken, in epoch milliseconds, when that could be read. */
  acquiredAt: number | null;
}

export type Leases =
  | {
      supported: true;
      /** Every session with an `<id>.lock`, by its id. */
      held: Map<string, Lease>;
    }
  | {
      supported: false;
      /** True when the folder is not there. False when it could not be listed. */
      missing: boolean;
    };

/** The session a lease file is named for, or null for any other name. */
export function sessionOfLeaseFile(name: string): { id: string; json: boolean } | null {
  const json = name.endsWith(LOCK_JSON);
  if (!json && !name.endsWith(LOCK)) return null;
  const id = name.slice(0, -(json ? LOCK_JSON : LOCK).length);
  if (!VIBE_SESSION_ID.test(id) || id.startsWith(SUBAGENT_ID_PREFIX)) return null;
  if (id === NOT_A_SESSION_LEASE) return null;
  return { id, json };
}

/** Vibe writes times as `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
const VIBE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** What a lease file's bytes say. A file that is empty, torn or not a lease names no pid. */
export function readLeaseFile(text: string): Lease {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { pid: null, acquiredAt: null };
  }
  if (!isRecord(value)) return { pid: null, acquiredAt: null };
  const acquired = value.acquired_at;
  const at = typeof acquired === "string" && VIBE_TIME.test(acquired) ? Date.parse(acquired) : NaN;
  return {
    pid: validPid(value.process_id) ?? null,
    acquiredAt: Number.isSafeInteger(at) ? at : null,
  };
}

interface Cached {
  ino: number;
  size: number;
  mtimeMs: number;
  lease: Lease;
}

export interface LeaseReader {
  /** The folder's leases, each `.lock.json` read again only when it changed. */
  read(): Promise<Leases>;
}

export function createLeaseReader(dir: string, io: ReadOnlyIo): LeaseReader {
  const cache = new Map<string, Cached>();

  async function leaseOf(id: string, withJson: boolean): Promise<Lease> {
    if (!withJson) {
      cache.delete(id);
      return { pid: null, acquiredAt: null };
    }
    const file = path.join(dir, `${id}${LOCK_JSON}`);
    let info: FileInfo;
    try {
      info = await io.lstat(file);
    } catch {
      cache.delete(id);
      return { pid: null, acquiredAt: null };
    }
    const cached = cache.get(id);
    if (
      cached &&
      cached.ino === info.ino &&
      cached.size === info.size &&
      cached.mtimeMs === info.mtimeMs
    ) {
      return cached.lease;
    }
    let lease: Lease = { pid: null, acquiredAt: null };
    // A link, or a file far larger than any lease, is not read.
    if (info.kind === "file" && info.size <= LEASE_FILE_LIMIT_BYTES) {
      try {
        const handle = await io.openRegular(file);
        try {
          const bytes = await handle.read(0, LEASE_FILE_LIMIT_BYTES);
          lease = readLeaseFile(Buffer.from(bytes).toString("utf8"));
        } finally {
          await handle.close();
        }
      } catch {
        // Gone, or not readable, between the look and the read: no pid this time.
      }
    }
    cache.set(id, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, lease });
    return lease;
  }

  return {
    async read() {
      let names: string[];
      try {
        names = await io.readdir(dir);
      } catch (error) {
        cache.clear();
        return { supported: false, missing: isMissing(error) };
      }
      const locks = new Set<string>();
      const jsons = new Set<string>();
      for (const name of names) {
        const found = sessionOfLeaseFile(name);
        if (found === null) continue;
        (found.json ? jsons : locks).add(found.id);
      }
      const held = new Map<string, Lease>();
      // A `.lock.json` with no `.lock` is one Vibe let go of and could not
      // delete, so it is not read.
      for (const id of [...locks].sort()) held.set(id, await leaseOf(id, jsons.has(id)));
      for (const id of cache.keys()) {
        if (!held.has(id)) cache.delete(id);
      }
      return { supported: true, held };
    },
  };
}
