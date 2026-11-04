import path from "node:path";

import {
  findSqlite,
  runSqlite,
  SQLITE_TIMEOUT_MS,
  type RunSqlite,
} from "../antigravity/app/summaries.ts";
import { isOutOfTime, runWithin, unlimitedTime, type ReadTime } from "../hermes-agent/sqlite.ts";
import { sqliteArguments, type DatabaseMode } from "../opencode/sessionRows.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import {
  PROBE_QUERY,
  QUERY_WINDOW_HOURS,
  readSchema,
  readSessionRows,
  SESSIONS_QUERY,
  type SessionRow,
} from "./sessionRows.ts";

/**
 * One project's Crush database, `.crush/crush.db`, read with the system's
 * `sqlite3`, found and started as for Antigravity's files
 * (`../antigravity/app/summaries.ts`): at fixed places only, never on `PATH`,
 * directly with no shell, stdin closed, a timeout, a cap on what it prints, and
 * never on Windows. The database lies in a project's folder, so a repository can
 * ship one: it is untrusted input, read with `trusted_schema` off, as every
 * agent's is (`TRUSTED_SCHEMA_OFF` in `../antigravity/app/summaries.ts`).
 *
 * Crush keeps the database in WAL mode (`pragmas` in `internal/db/connect.go`):
 * what it has saved lies in `crush.db-wal` until SQLite moves it into the
 * database, and `crush.db-shm` indexes it. So a new session may be in the `-wal`
 * alone. Which way the database is opened follows the files beside it, looked at
 * with `lstat` on every poll, as for Goose's database (`../goose/database.ts`):
 *
 * - no `-wal`, or an empty one: `mode=ro&immutable=1`, which takes no lock and
 *   makes no file.
 * - a `-wal` that holds something, and the `-shm`: `mode=ro&readonly_shm=1`,
 *   which reads the `-wal` and opens the `-shm` read-only, so nothing is written
 *   to either. It holds SQLite's shared read lock while it runs, which does not
 *   stop Crush writing, and is the one lock ever taken.
 * - such a `-wal` without its `-shm`, or anything but an ordinary file at one of
 *   the three names: not read.
 *
 * The path of a project's folder comes from a file, so nothing is opened by a
 * link. The project's folder and its `.crush` are looked at with `lstat` as well,
 * and a link at either is not followed. The folders above a project's are not
 * looked at: a path in the list could name the place they lead to anyway, and
 * `/home` or `/tmp` is a link on some systems. A project that has gone is nothing
 * to read. One that cannot be looked at may still be there, so it is not taken
 * for gone.
 *
 * An empty `crush.db` is taken as none: SQLite would delete a `-wal` beside it.
 *
 * Each write of a session's row is a commit, and every commit touches `crush.db`
 * or its `-wal`. So a database neither of which was written in the last 48 hours
 * holds no session to list, and no `sqlite3` is started for it.
 *
 * The sessions are asked for again only when `crush.db` or its `-wal` changed
 * since the last read, by identity, size or modified time, or when the `-wal`
 * came or went. After a read that did not work, they are asked for again on the
 * next change, or 10 seconds later. That is one run of `sqlite3`, and a second,
 * the probe, only when the first fails. Each runs within the poll's time for
 * reading (`runWithin` in `../hermes-agent/sqlite.ts`), and a read that time cut
 * short leaves the last read standing. A question that had its whole 5 seconds
 * and failed, with no time left for the probe, is a read that did not work, so a
 * database that does not answer cannot take every poll.
 *
 * Built from Crush's source at v0.99.0, and not yet checked on a computer
 * running Crush.
 */

/** How long after a read that did not work the database is read again, changed or not. */
export const RETRY_MS = 10_000;

/** How long after its last write a database is taken to hold no session worth asking for. */
export const QUIET_DATABASE_MS = QUERY_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * How the last read went:
 *
 * read            the sessions were read, or the database was too long unwritten to hold any to list
 * missing         the project has gone, or holds no database, or an empty one
 * not-safe        a link or anything but an ordinary file is at one of the names read, or a folder's
 *                 name, or its `-wal` holds something but has no `-shm`
 * not-looked-at   `lstat` failed at one of those names for any reason but that nothing is there
 * no-sqlite       no `sqlite3` was found to read it
 * failed          `sqlite3` did not answer, or its answer could not be read
 * unsupported     its tables are not laid out as Crush lays them out
 * out-of-time     the time for reading ran out first: nothing is known of it
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
  | "out-of-time"
  | "not-on-windows";

export interface DatabaseRead {
  state: DatabaseState;
  /** The sessions read. Empty unless `state` is `read`. */
  rows: readonly SessionRow[];
}

export interface DatabaseReader {
  /**
   * The sessions, asked for again only when the database changed, or a failed
   * read is due again. Each run of `sqlite3` runs within the `time` given,
   * unlimited when none is. Never throws.
   */
  read(at: number, time?: ReadTime): Promise<DatabaseRead>;
}

/** The three files, as `lstat` saw them this poll. */
interface Files {
  database: FileInfo;
  wal: FileInfo | null;
  shm: FileInfo | null;
}

const NONE: readonly SessionRow[] = [];

const CUT_SHORT: DatabaseRead = { state: "out-of-time", rows: NONE };

/** Whether the `-wal` is an ordinary file that holds something, so the database is read with it. */
function walHolds({ wal }: Files): boolean {
  return wal !== null && wal.kind === "file" && wal.size > 0;
}

/** Whether two looks at a file see the same file, unchanged. */
function same(a: FileInfo | null, b: FileInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Whether neither `crush.db` nor its `-wal` was written lately. A clock set back counts as lately. */
function longUnwritten({ database, wal }: Files, at: number): boolean {
  return at - Math.max(database.mtimeMs, wal?.mtimeMs ?? 0) >= QUIET_DATABASE_MS;
}

export function createDatabaseReader(options: {
  /** The database's path: `<project>/.crush/crush.db`. */
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
  const dataFolder = path.posix.dirname(file);
  const projectFolder = path.posix.dirname(dataFolder);
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
      for (const folder of [projectFolder, dataFolder]) {
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
  async function ask(files: Files, time: ReadTime): Promise<DatabaseRead> {
    const binary = await find();
    if (binary === null) return { state: "no-sqlite", rows: NONE };
    // An empty -wal holds nothing, so the database is read as a file nothing changes.
    const mode: DatabaseMode = walHolds(files) ? "with-wal" : "whole";
    /** Whether the question had its whole 5 seconds, as the first run of a poll has. */
    let questionWhole = false;
    const answer = await runWithin(time, (timeoutMs) => {
      questionWhole = timeoutMs >= SQLITE_TIMEOUT_MS;
      return run(binary, sqliteArguments(file, mode, SESSIONS_QUERY), timeoutMs);
    });
    if (isOutOfTime(answer)) return CUT_SHORT;
    if (answer.ok) {
      const rows = readSessionRows(answer.stdout);
      return rows === null ? { state: "failed", rows: NONE } : { state: "read", rows };
    }
    const probe = await runWithin(time, (timeoutMs) =>
      run(binary, sqliteArguments(file, mode, PROBE_QUERY), timeoutMs),
    );
    // The two questions had as much of a poll as any read gets, so every poll
    // would cut this one short: it did not work, and waits 10 seconds.
    if (isOutOfTime(probe)) return questionWhole ? { state: "failed", rows: NONE } : CUT_SHORT;
    const unsupported = probe.ok && readSchema(probe.stdout) === "unsupported";
    return { state: unsupported ? "unsupported" : "failed", rows: NONE };
  }

  async function read(at: number, time: ReadTime): Promise<DatabaseRead> {
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
    if (longUnwritten(files, at)) {
      last = null;
      return { state: "read", rows: NONE };
    }
    const next = await ask(files, time);
    // Nothing was learned, so the last read stands, and the next read asks again.
    if (next.state === "out-of-time") return next;
    last = { ...next, files, at };
    return next;
  }

  return {
    async read(at, time = unlimitedTime()) {
      try {
        return await read(at, time);
      } catch {
        last = null;
        return { state: "failed", rows: NONE };
      }
    },
  };
}
