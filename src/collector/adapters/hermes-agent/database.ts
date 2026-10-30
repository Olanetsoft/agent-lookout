import { runSqlite, type RunSqlite } from "../antigravity/app/summaries.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import {
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  SESSIONS_QUERY,
  sqliteArguments,
  type DatabaseMode,
  type HermesRow,
} from "./sessionRows.ts";
import { createSqliteFinder, type SqliteFinder, type SqliteVersion } from "./sqlite.ts";

/**
 * One Hermes Agent profile's database, `state.db`, read with the system's
 * `sqlite3` (`sqlite.ts`), never on Windows.
 *
 * Hermes Agent keeps a database in WAL mode, or in rollback-journal mode when
 * its own SQLite has the WAL-reset bug, when it is set to, or on a disk that
 * cannot hold WAL mode (`hermes_state_wal.py`), so which one cannot be known in
 * advance. So on each poll the database and the two files SQLite keeps beside
 * it are looked at with `lstat`, and when `state.db` changed, its first 20
 * bytes are read, in Agent Lookout's own process, to tell the mode as Hermes
 * Agent's own `hermes sessions` command tells it: bytes 18 and 19 are 1 and 1
 * in rollback-journal mode, 2 and 2 in WAL mode
 * (`hermes_cli/sessions_cmd_journal_mode.py`). Agent Lookout holds no SQLite
 * connection of its own, so that open and close cannot let go of a lock
 * Hermes Agent holds. Then:
 *
 * - rollback-journal mode, with no `-wal` beside it: read with a shared lock,
 *   waiting up to a second for a commit to end, with any `sqlite3`.
 * - WAL mode with no `-wal`, or an empty one: read as a file nothing changes,
 *   with any `sqlite3`.
 * - WAL mode with a `-wal` that holds something and its `-shm`: read with the
 *   `-wal`, the `-shm` opened read-only, only with a `sqlite3` that passes
 *   Hermes Agent's test for the WAL-reset bug.
 * - such a `-wal` without its `-shm`, or either not an ordinary file: not read.
 * - a `-wal` beside a rollback-journal database, or a header that is neither:
 *   not read.
 *
 * An empty `state.db` is taken as none: SQLite would delete a `-wal` beside it.
 *
 * If a program closes the database between the `lstat` and the read, and
 * SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from
 * SQLite's own source, as on Linux, makes an empty `-wal` as it opens the
 * database, and that read does not work. SQLite has no setting that stops it.
 *
 * The sessions are asked for again only when `state.db` or its `-wal` changed
 * since the last read, by identity, size or modified time, or when the `-wal`
 * came or went. After a read that did not work, they are asked for again on
 * the next change, or 10 seconds later. The probe of the tables is asked each
 * time before them, in the same mode.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** How long after a read that did not work the database is read again, changed or not. */
export const RETRY_MS = 10_000;

/** The first bytes of every SQLite database, and how many bytes of it are read. */
export const SQLITE_MAGIC = "SQLite format 3\u0000";
export const HEADER_LENGTH = 20;

/** The journal mode a database's header says: rollback journal, WAL, or neither. */
export type HeaderMode = "rollback" | "wal" | "unknown";

/** The mode bytes 18 and 19 of a database's first 20 say, as Hermes Agent reads them. */
export function headerMode(bytes: Uint8Array): HeaderMode {
  if (bytes.byteLength < HEADER_LENGTH) return "unknown";
  for (let index = 0; index < SQLITE_MAGIC.length; index += 1) {
    if (bytes[index] !== SQLITE_MAGIC.charCodeAt(index)) return "unknown";
  }
  const [write, read] = [bytes[18], bytes[19]];
  if (write === 1 && read === 1) return "rollback";
  if (write === 2 && read === 2) return "wal";
  return "unknown";
}

/**
 * How the last read went:
 *
 * read               the sessions were read
 * missing            there is no database, it is empty, or it is not an ordinary file
 * not-safe           its `-wal` holds something but has no `-shm`, or one of them is not an ordinary file
 * failed             its header is not one Agent Lookout reads, a `-wal` is beside a rollback-journal
 *                    database, or `sqlite3` did not answer, or its answer could not be read
 * no-sqlite          no `sqlite3` was found to read it
 * vulnerable-sqlite  its `-wal` holds something, and every `sqlite3` found fails Hermes Agent's WAL-reset test
 * unsupported        its tables are not laid out as Hermes Agent v0.21.6 and later lay them out
 * not-on-windows     nothing is read on Windows
 */
export type DatabaseState =
  | "read"
  | "missing"
  | "not-safe"
  | "failed"
  | "no-sqlite"
  | "vulnerable-sqlite"
  | "unsupported"
  | "not-on-windows";

export interface DatabaseRead {
  state: DatabaseState;
  /** The rows read. Empty unless `state` is `read`. */
  rows: readonly HermesRow[];
  /** For `vulnerable-sqlite`: the first `sqlite3` found, and its version, or null when it printed none. */
  vulnerable?: { path: string; version: SqliteVersion | null };
}

export interface DatabaseReader {
  /** The rows, asked for again only when the database changed, or a failed read is due again. Never throws. */
  read(at: number): Promise<DatabaseRead>;
}

/** The three files, as `lstat` saw them this poll. */
interface Files {
  database: FileInfo;
  wal: FileInfo | null;
  shm: FileInfo | null;
}

const NONE: readonly HermesRow[] = [];

/** Whether the `-wal` is an ordinary file that holds something, so the database is read with it. */
function walHolds(files: Files): boolean {
  return files.wal !== null && files.wal.kind === "file" && files.wal.size > 0;
}

/** Whether two looks at a file see the same file, unchanged. */
function same(a: FileInfo | null, b: FileInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export function createDatabaseReader(options: {
  /** The database's path. */
  file: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  /** Which `sqlite3` to run. One finder can serve every profile. */
  finder?: SqliteFinder;
  run?: RunSqlite;
  retryMs?: number;
}): DatabaseReader {
  const { file, io, platform } = options;
  const run = options.run ?? runSqlite;
  const finder = options.finder ?? createSqliteFinder();
  const retryMs = options.retryMs ?? RETRY_MS;
  /** The last read, with the files as they were then and when it was made. */
  let last: (DatabaseRead & { files: Files; at: number }) | null = null;
  /** The mode the header last said, and `state.db` as it was when it was read. */
  let header: { info: FileInfo; mode: HeaderMode } | null = null;

  /** What is at a path beside the database: null when nothing is there. */
  async function beside(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch {
      return null;
    }
  }

  /**
   * The mode the database's header says, read again only when `state.db`
   * changed. The first 20 bytes are read from the file `lstat` saw, and
   * nothing more. Null when the file was replaced between the two.
   */
  async function modeOf(database: FileInfo): Promise<HeaderMode | null> {
    if (header !== null && same(header.info, database)) return header.mode;
    header = null;
    const opened = await io.openRegular(file);
    let bytes: Uint8Array;
    try {
      if (opened.info.ino !== database.ino) return null;
      bytes = await opened.read(0, HEADER_LENGTH);
    } finally {
      await opened.close();
    }
    const mode = headerMode(bytes);
    header = { info: database, mode };
    return mode;
  }

  async function read(at: number): Promise<DatabaseRead> {
    if (platform === "win32") return { state: "not-on-windows", rows: NONE };
    let database: FileInfo;
    try {
      database = await io.lstat(file);
    } catch {
      last = null;
      header = null;
      return { state: "missing", rows: NONE };
    }
    // SQLite deletes the -wal beside an empty database as it opens it, so an
    // empty one is not read.
    if (database.kind !== "file" || database.size === 0) {
      last = null;
      header = null;
      return { state: "missing", rows: NONE };
    }
    const files: Files = {
      database,
      wal: await beside(`${file}-wal`),
      shm: await beside(`${file}-shm`),
    };
    if (
      (files.wal !== null && files.wal.kind !== "file") ||
      (files.shm !== null && files.shm.kind !== "file")
    ) {
      last = null;
      return { state: "not-safe", rows: NONE };
    }

    const unchanged =
      last !== null && same(last.files.database, files.database) && same(last.files.wal, files.wal);
    // A read that worked, or found tables it does not read, stands until the
    // files change. One that did not work is tried again 10 seconds on. A
    // clock set back counts as time enough.
    const settled = last?.state === "read" || last?.state === "unsupported";
    const due = last === null || at - last.at < 0 || at - last.at >= retryMs;
    if (last !== null && unchanged && (settled || !due)) {
      const { state, rows, vulnerable } = last;
      return vulnerable === undefined ? { state, rows } : { state, rows, vulnerable };
    }

    const next = await ask(files);
    last = { ...next, files, at };
    return next;
  }

  /** Chooses how to open the database, then runs the probe, then the query of the sessions, the same way. */
  async function ask(files: Files): Promise<DatabaseRead> {
    let mode: HeaderMode | null;
    try {
      mode = await modeOf(files.database);
    } catch {
      mode = null;
    }
    if (mode === null || mode === "unknown") return { state: "failed", rows: NONE };
    let way: DatabaseMode;
    if (mode === "rollback") {
      // SQLite opens a database in WAL mode whenever a -wal is beside it,
      // whatever its header says, so such a database is not read.
      if (files.wal !== null) return { state: "failed", rows: NONE };
      way = "rollback";
    } else if (!walHolds(files)) {
      way = "whole";
    } else if (files.shm === null) {
      // Reading it would make a -shm.
      return { state: "not-safe", rows: NONE };
    } else {
      way = "with-wal";
    }

    const picked = await finder.pick(way === "with-wal" ? "wal-safe" : "any");
    if (picked.kind === "none") return { state: "no-sqlite", rows: NONE };
    if (picked.kind === "vulnerable") {
      return {
        state: "vulnerable-sqlite",
        rows: NONE,
        vulnerable: { path: picked.path, version: picked.version },
      };
    }
    const binary = picked.path;
    const probe = await run(binary, sqliteArguments(file, way, PROBE_QUERY));
    const schema = probe.ok ? readSchema(probe.stdout) : null;
    if (schema === null) return { state: "failed", rows: NONE };
    if (schema === "unsupported") return { state: "unsupported", rows: NONE };
    const answer = await run(binary, sqliteArguments(file, way, SESSIONS_QUERY));
    const rows = answer.ok ? readSessionRows(answer.stdout) : null;
    if (rows === null) return { state: "failed", rows: NONE };
    return { state: "read", rows };
  }

  return {
    async read(at) {
      try {
        return await read(at);
      } catch {
        last = null;
        header = null;
        return { state: "failed", rows: NONE };
      }
    },
  };
}
