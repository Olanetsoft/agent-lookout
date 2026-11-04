import path from "node:path";

import { findSqlite, runSqlite, type RunSqlite } from "../antigravity/app/summaries.ts";
import { sqliteArguments, type DatabaseMode } from "../opencode/sessionRows.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import {
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  SESSIONS_QUERY,
  type SessionRow,
} from "./sessionRows.ts";

/**
 * Goose's database, `sessions.db`, read with the system's `sqlite3`, found and
 * started as for Antigravity's files (`../antigravity/app/summaries.ts`): at
 * fixed places only, never on `PATH`, directly with no shell, stdin closed, a
 * timeout, a cap on what it prints, and never on Windows.
 *
 * Goose keeps the database in WAL mode (`create_pool` in `session_manager.rs`):
 * what it has saved lies in `sessions.db-wal` until SQLite moves it into the
 * database, and `sessions.db-shm` indexes it. So a new session may be in the
 * `-wal` alone. Which way the database is opened follows the files beside it,
 * looked at with `lstat` on every poll, as for OpenCode's database
 * (`../opencode/database.ts`):
 *
 * - no `-wal`, or an empty one: `mode=ro&immutable=1`, which takes no lock and
 *   makes no file.
 * - a `-wal` that holds something, and the `-shm`: `mode=ro&readonly_shm=1`,
 *   which reads the `-wal` and opens the `-shm` read-only, so nothing is written
 *   to either. It holds SQLite's shared read lock while it runs, which does not
 *   stop Goose writing, and is the one lock ever taken.
 * - such a `-wal` without its `-shm`, or anything but an ordinary file at one of
 *   the three names: not read.
 *
 * Nothing is opened by a link. Goose's data folder and the `sessions` folder in
 * it are looked at with `lstat` as well, and a link at either is not followed.
 * A database that has gone is nothing to read. One that cannot be looked at may
 * still be there, so it is not taken for gone.
 *
 * An empty `sessions.db` is taken as none: SQLite would delete a `-wal` beside
 * it.
 *
 * The sessions are asked for again only when `sessions.db` or its `-wal` changed
 * since the last read, by identity, size or modified time, or when the `-wal`
 * came or went. After a read that did not work, they are asked for again on the
 * next change, or 10 seconds later. That is one run of `sqlite3`, and a second,
 * the probe, only when the first fails.
 *
 * Built from Goose's source at v1.57.0, and not yet checked on a computer
 * running Goose.
 */

/** How long after a read that did not work the database is read again, changed or not. */
export const RETRY_MS = 10_000;

/**
 * How the last read went:
 *
 * read            the sessions were read
 * missing         there is no database, or it is empty
 * not-safe        a link or anything but an ordinary file is at one of the names read, or a folder's
 *                 name, or its `-wal` holds something but has no `-shm`
 * not-looked-at   `lstat` failed at one of those names for any reason but that nothing is there
 * no-sqlite       no `sqlite3` was found to read it
 * failed          `sqlite3` did not answer, or its answer could not be read
 * unsupported     its tables are not laid out as Goose v1.34.0 and later lay them out
 * not-on-windows  nothing is read on Windows
 */
export type DatabaseState =
  | "read"
  | "missing"
  | "not-safe"
  | "not-looked-at"
  | "no-sqlite"
  | "failed"
  | "unsupported"
  | "not-on-windows";

export interface DatabaseRead {
  state: DatabaseState;
  /** The sessions read. Empty unless `state` is `read`. */
  rows: readonly SessionRow[];
}

export interface DatabaseReader {
  /** The sessions, asked for again only when the database changed, or a failed read is due again. Never throws. */
  read(at: number): Promise<DatabaseRead>;
}

/** The three files, as `lstat` saw them this poll. */
interface Files {
  database: FileInfo;
  wal: FileInfo | null;
  shm: FileInfo | null;
}

const NONE: readonly SessionRow[] = [];

/** Whether the `-wal` is an ordinary file that holds something, so the database is read with it. */
function walHolds({ wal }: Files): boolean {
  return wal !== null && wal.kind === "file" && wal.size > 0;
}

/** Whether two looks at a file see the same file, unchanged. */
function same(a: FileInfo | null, b: FileInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function createDatabaseReader(options: {
  /** The database's path: `<data folder>/sessions/sessions.db`. */
  file: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  run?: RunSqlite;
  find?: () => Promise<string | null>;
  retryMs?: number;
}): DatabaseReader {
  const { file, io, platform } = options;
  const run = options.run ?? runSqlite;
  const find = options.find ?? (() => findSqlite());
  const retryMs = options.retryMs ?? RETRY_MS;
  const sessionsFolder = path.dirname(file);
  const dataFolder = path.dirname(sessionsFolder);
  /** The last read, with the files as they were then and when it was made. */
  let last: (DatabaseRead & { files: Files; at: number }) | null = null;

  /** What is at a path: null when nothing is there. Throws when it cannot be looked at. */
  async function look(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** The three files with `lstat`, or why the database is not read. */
  async function lookUp(): Promise<
    { files: Files } | { state: "missing" | "not-safe" | "not-looked-at" }
  > {
    try {
      for (const folder of [dataFolder, sessionsFolder]) {
        const info = await look(folder);
        if (info === null) return { state: "missing" };
        if (info.kind !== "directory") return { state: "not-safe" };
      }
      const database = await look(file);
      if (database === null) return { state: "missing" };
      if (database.kind !== "file") return { state: "not-safe" };
      // SQLite deletes the -wal beside an empty database as it opens it, so an
      // empty one is not read.
      if (database.size === 0) return { state: "missing" };
      const files: Files = {
        database,
        wal: await look(`${file}-wal`),
        shm: await look(`${file}-shm`),
      };
      const beside = [files.wal, files.shm].filter((info) => info !== null);
      if (beside.some((info) => info.kind !== "file")) return { state: "not-safe" };
      if (walHolds(files) && files.shm === null) return { state: "not-safe" };
      return { files };
    } catch {
      return { state: "not-looked-at" };
    }
  }

  /** Runs the question of the sessions, then the probe if that failed, to tell why. */
  async function ask(files: Files): Promise<DatabaseRead> {
    const binary = await find();
    if (binary === null) return { state: "no-sqlite", rows: NONE };
    // An empty -wal holds nothing, so the database is read as a file nothing changes.
    const mode: DatabaseMode = walHolds(files) ? "with-wal" : "whole";
    const answer = await run(binary, sqliteArguments(file, mode, SESSIONS_QUERY));
    if (answer.ok) {
      const rows = readSessionRows(answer.stdout);
      return rows === null ? { state: "failed", rows: NONE } : { state: "read", rows };
    }
    const probe = await run(binary, sqliteArguments(file, mode, PROBE_QUERY));
    const unsupported = probe.ok && readSchema(probe.stdout) === "unsupported";
    return { state: unsupported ? "unsupported" : "failed", rows: NONE };
  }

  async function read(at: number): Promise<DatabaseRead> {
    if (platform === "win32") return { state: "not-on-windows", rows: NONE };
    const looked = await lookUp();
    if ("state" in looked) {
      last = null;
      return { state: looked.state, rows: NONE };
    }
    const { files } = looked;
    const unchanged =
      last !== null && same(last.files.database, files.database) && same(last.files.wal, files.wal);
    // A read that worked, or found tables it does not read, stands until the
    // files change. One that did not work is tried again 10 seconds on. A
    // clock set back counts as time enough.
    const settled = last?.state === "read" || last?.state === "unsupported";
    const due = last === null || at - last.at < 0 || at - last.at >= retryMs;
    if (last !== null && unchanged && (settled || !due)) {
      return { state: last.state, rows: last.rows };
    }
    const next = await ask(files);
    last = { ...next, files, at };
    return next;
  }

  return {
    async read(at) {
      try {
        return await read(at);
      } catch {
        last = null;
        return { state: "failed", rows: NONE };
      }
    },
  };
}
