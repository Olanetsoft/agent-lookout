import path from "node:path";

import { isMissing, type ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Finding Kiro CLI's sessions, in its two stores, without opening a file.
 * Built from Kiro's documentation and open-source readers of its files, and
 * not yet checked on a computer running Kiro CLI.
 *
 * Both stores are in `<Kiro's folder>/sessions/`, and they are read side by
 * side and never merged: a V2 session resumed in V3 is a copy of its own.
 *
 * - V3, the default for interactive chat from Kiro CLI 3.0.0:
 *   `sessions/<bucket>/sess_<uuid>/`, for every bucket but `cli`, with
 *   `session.json`, `messages.jsonl` and, while it is open, `.lock`. The Kiro
 *   IDE writes this store too. Nothing else in a session's folder is looked
 *   at, `sub-executions/` among it: a subagent is not a session of its own.
 * - V2: `sessions/cli/`, with `<uuid>.json`, `<uuid>.jsonl` and, while it is
 *   open, `<uuid>.lock`. A session is found by its `<uuid>.json`. A
 *   `.history` file and a `<uuid>/` folder are passed over.
 *
 * Every folder from `sessions/` down is looked up with `lstat` and must be a
 * real folder, not a link: `sessions/` and each bucket on every poll, and a V3
 * session's own folder before its files are read. Kiro's documentation asks readers not to depend on
 * the V3 layout, so a folder or a name that is not one of these is passed over.
 */

export const SESSIONS_DIR = "sessions";

/** The bucket that holds the V2 store. */
export const V2_BUCKET = "cli";

export const V3_HEADER = "session.json";
export const V3_LOG = "messages.jsonl";
export const V3_LOCK = ".lock";

const UUID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

/** A V3 session's folder: `sess_<uuid>`. */
const V3_FOLDER = new RegExp(`^sess_${UUID}$`);

/** A V2 header's name: `<uuid>.json`. */
const V2_HEADER = new RegExp(`^(${UUID})\\.json$`);

/** A V2 lock's name: `<uuid>.lock`. */
const V2_LOCK = new RegExp(`^(${UUID})\\.lock$`);

/** A bucket's name: one folder, never `.` or `..`. */
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** One session's place in its store, with the three files it may have. */
export interface SessionPlace {
  store: "v3" | "v2";
  /** `sess_<uuid>` for V3, the folder's name, and `<uuid>` for V2, the files' stem. */
  id: string;
  /** A V3 session's own folder, which `isRealFolder` must find a real folder before its files are read. */
  folder?: string;
  header: string;
  log: string;
  lock: string;
  /** In the V2 store, whether a `<uuid>.lock` name was in the folder's listing. */
  lockListed?: boolean;
}

export type StoresRead =
  /** No `sessions/` folder. */
  | { state: "missing" }
  /** Something other than a real folder at `sessions/`, or a listing of it that failed. */
  | { state: "unreadable" }
  | {
      state: "ok";
      places: SessionPlace[];
      /** True when a bucket or the V2 folder could not be listed, so some sessions may be missing. */
      partial: boolean;
    };

/** Whether a folder is there and is a real folder, not a link. A look that fails says no. */
export async function isRealFolder(target: string, io: ReadOnlyIo): Promise<boolean> {
  try {
    return (await io.lstat(target)).kind === "directory";
  } catch {
    return false;
  }
}

/** Lists a folder, or null when it cannot be listed. One that has gone since it was looked up lists nothing. */
async function list(dir: string, io: ReadOnlyIo): Promise<string[] | null> {
  try {
    return await io.readdir(dir);
  } catch (error) {
    return isMissing(error) ? [] : null;
  }
}

/** Every V3 and V2 session's place under `sessions/`, sorted by name within each folder. */
export async function readStores(sessionsDir: string, io: ReadOnlyIo): Promise<StoresRead> {
  try {
    if ((await io.lstat(sessionsDir)).kind !== "directory") return { state: "unreadable" };
  } catch (error) {
    return isMissing(error) ? { state: "missing" } : { state: "unreadable" };
  }
  const buckets = await list(sessionsDir, io);
  if (buckets === null) return { state: "unreadable" };

  const places: SessionPlace[] = [];
  const seen = new Set<string>();
  let partial = false;
  for (const bucket of buckets.sort()) {
    if (!BUCKET.test(bucket)) continue;
    const dir = path.join(sessionsDir, bucket);
    if (!(await isRealFolder(dir, io))) continue;
    const names = await list(dir, io);
    if (names === null) {
      partial = true;
      continue;
    }
    names.sort();

    if (bucket === V2_BUCKET) {
      const locks = new Set(names.flatMap((name) => V2_LOCK.exec(name)?.[1] ?? []));
      for (const name of names) {
        const id = V2_HEADER.exec(name)?.[1];
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        places.push({
          store: "v2",
          id,
          header: path.join(dir, name),
          log: path.join(dir, `${id}.jsonl`),
          lock: path.join(dir, `${id}.lock`),
          lockListed: locks.has(id),
        });
      }
      continue;
    }

    for (const name of names) {
      if (!V3_FOLDER.test(name) || seen.has(name)) continue;
      const folder = path.join(dir, name);
      seen.add(name);
      places.push({
        store: "v3",
        id: name,
        folder,
        header: path.join(folder, V3_HEADER),
        log: path.join(folder, V3_LOG),
        lock: path.join(folder, V3_LOCK),
      });
    }
  }
  return { state: "ok", places, partial };
}
