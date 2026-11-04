import { findSqlite, runSqlite, type RunSqlite } from "../antigravity/app/summaries.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { TRANSCRIPT_TAIL_BYTES } from "../../files/transcriptTail.ts";
import {
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  sessionsQueryFor,
  sqliteArguments,
  type DatabaseMode,
  type Schema,
  type SessionRow,
} from "./sessionRows.ts";

/**
 * OpenCode's database, `opencode.db`, read with the system's `sqlite3`, found
 * and started as for Antigravity's files (`../antigravity/app/summaries.ts`):
 * at fixed places only, never on `PATH`, directly with no shell, stdin closed,
 * a timeout, a cap on what it prints, and never on Windows.
 *
 * OpenCode keeps the database in WAL mode: what it has saved lies in
 * `opencode.db-wal` until SQLite moves it into the database, and
 * `opencode.db-shm` indexes it. OpenCode 1.19.0 never closes the database
 * itself, so its `-wal` is left full after it quits, as after a crash, and
 * what it saved there must still be read. Which way it is opened follows the
 * files beside it, looked at with `lstat` on every poll:
 *
 * - no `-wal`, or an empty one: `mode=ro&immutable=1`, which takes no lock and
 *   makes no file. An empty `-wal` holds nothing to read.
 * - a `-wal` that holds something, and the `-shm`: `mode=ro&readonly_shm=1`,
 *   which reads the `-wal` and opens the `-shm` read-only, so nothing is
 *   written to either, whether or not a program still has the database open.
 *   It holds a shared lock on the database while it runs, so a program that
 *   closes the database then leaves its `-wal` and `-shm` in place.
 * - such a `-wal` without its `-shm`, or either of them not an ordinary file:
 *   not read.
 *
 * A database that has gone is nothing to read, and a file beside it that has
 * gone is no file. One of the three that cannot be looked at may still be there,
 * so it is not taken for gone.
 *
 * An empty `opencode.db` is taken as none: SQLite would delete a `-wal` beside
 * it.
 *
 * Whether OpenCode runs is not read from these files, but from `ps`
 * (`processes.ts`).
 *
 * If a program closes the database between the `lstat` and the read, and
 * SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from
 * SQLite's own source, as on Linux, makes an empty `-wal` as it opens the
 * database, and that read does not work. SQLite has no setting that stops it.
 *
 * The sessions are asked for again only when `opencode.db` or its `-wal`
 * changed since the last read, by identity, size or modified time, or when
 * the `-wal` came or went. After a read that did not work, they are asked for
 * again on the next change, or 10 seconds later. The probe of the tables is
 * asked each time before them, so a table OpenCode adds is seen.
 *
 * What a session last said is asked with `askOnce`, which no poll calls: the
 * same three `lstat`s, the same choice of address, the same `sqlite3`,
 * arguments and timeout, and one question, with at most 256 KB of what it
 * prints read (`lastMessages.ts`).
 *
 * This was built from OpenCode's source at v1.19.0, and has not yet been
 * checked on a computer running OpenCode. OpenCode 2 keeps the same file in
 * WAL mode too (`packages/core/src/database/database.ts` at v2.2.5).
 */

/** How long after a read that did not work the database is read again, changed or not. */
export const RETRY_MS = 10_000;

/**
 * How the last read went:
 *
 * read            the sessions were read
 * missing         there is no database, it is empty, or it is not an ordinary file
 * not-safe        its `-wal` holds something but has no `-shm`, or one of them is not an ordinary file
 * not-looked-at   `lstat` failed at one of the three files for any reason but that nothing is there
 * no-sqlite       no `sqlite3` was found to read it
 * failed          `sqlite3` did not answer, or its answer could not be read
 * unsupported     its tables are not laid out as OpenCode 1.x or 2 lays them out
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
  /** The root sessions read. Empty unless `state` is `read`. */
  rows: readonly SessionRow[];
}

/**
 * The database and its `-wal` as `lstat` saw them when one question was
 * asked, so it is asked again only once one of them has changed.
 */
export interface DatabaseStamp {
  database: FileInfo;
  wal: FileInfo | null;
}

/** What one question asked with `askOnce` found: the files as they were, or what `sqlite3` printed. */
export type QuestionRead =
  | { unchanged: true; stamp: DatabaseStamp }
  | { unchanged: false; stamp: DatabaseStamp; stdout: string };

/** The most of what `sqlite3` prints for a question asked with `askOnce`: 256 KB, as much as is read of a transcript's end. */
export const QUESTION_OUTPUT_BYTES = TRANSCRIPT_TAIL_BYTES;

export interface DatabaseReader {
  /** The sessions, asked for again only when the database changed, or a failed read is due again. Never throws. */
  read(at: number): Promise<DatabaseRead>;
  /**
   * Asks the database one fixed question, opened just as `read` opens it,
   * and reads at most 256 KB of what `sqlite3` prints. When the database and
   * its `-wal` are as `known` says, nothing is asked, and it says so. It
   * rejects with the error `lstat` gave when there is no database, which
   * `isMissing` knows, and with another when it is not read for any other
   * reason: on Windows, when one of the three files cannot be looked at, when
   * the database is not an ordinary file or is empty, when the files beside
   * it are not safe to read, when no `sqlite3` is found, and when `sqlite3`
   * does not answer.
   */
  askOnce(question: string, known: DatabaseStamp | null): Promise<QuestionRead>;
}

/** The three files, as `lstat` saw them this poll. */
interface Files {
  database: FileInfo;
  wal: FileInfo | null;
  shm: FileInfo | null;
}

/** What one look at the three files found: the files, or why the database is not read. */
type Look =
  | { files: Files }
  | { state: "missing" | "not-safe" | "not-looked-at"; error: unknown }
  | { state: "not-on-windows" };

const NONE: readonly SessionRow[] = [];

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
  run?: RunSqlite;
  find?: () => Promise<string | null>;
  retryMs?: number;
}): DatabaseReader {
  const { file, io, platform } = options;
  const run = options.run ?? runSqlite;
  const find = options.find ?? (() => findSqlite());
  const retryMs = options.retryMs ?? RETRY_MS;
  /** The last read, with the files as they were then and when it was made. */
  let last: (DatabaseRead & { files: Files; at: number }) | null = null;

  /** What is at a path beside the database: null when nothing is there. Throws when it cannot be looked at. */
  async function beside(target: string): Promise<FileInfo | null> {
    try {
      return await io.lstat(target);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /**
   * The three files with `lstat`, as every read looks at them first, or why
   * the database is not read: there is none, it is empty or not an ordinary
   * file, one of the three cannot be looked at, or the files beside it are not
   * safe to read.
   */
  async function look(): Promise<Look> {
    if (platform === "win32") return { state: "not-on-windows" };
    let database: FileInfo;
    try {
      database = await io.lstat(file);
    } catch (error) {
      return { state: isMissing(error) ? "missing" : "not-looked-at", error };
    }
    // SQLite deletes the -wal beside an empty database as it opens it, so an
    // empty one is not read.
    if (database.kind !== "file" || database.size === 0) {
      return { state: "missing", error: new Error("OpenCode's database is empty or not a file.") };
    }
    let files: Files;
    try {
      files = {
        database,
        wal: await beside(`${file}-wal`),
        shm: await beside(`${file}-shm`),
      };
    } catch (error) {
      return { state: "not-looked-at", error };
    }
    if (
      (files.wal !== null &&
        (files.wal.kind !== "file" || (walHolds(files) && files.shm === null))) ||
      (files.shm !== null && files.shm.kind !== "file")
    ) {
      return {
        state: "not-safe",
        error: new Error("The files beside OpenCode's database are not safe to read."),
      };
    }
    return { files };
  }

  /** The address the database is opened at: as a whole file nothing changes, unless its -wal holds something. */
  function modeOf(files: Files): DatabaseMode {
    // An empty -wal holds nothing, so the database is read as a file nothing changes.
    return walHolds(files) ? "with-wal" : "whole";
  }

  async function read(at: number): Promise<DatabaseRead> {
    const looked = await look();
    if (!("files" in looked)) {
      if (looked.state !== "not-on-windows") last = null;
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

  /** Runs the probe, then the query of the sessions. */
  async function ask(files: Files): Promise<DatabaseRead> {
    const binary = await find();
    if (binary === null) return { state: "no-sqlite", rows: NONE };
    const mode = modeOf(files);
    const probe = await run(binary, sqliteArguments(file, mode, PROBE_QUERY));
    const found: Schema | null = probe.ok ? readSchema(probe.stdout) : null;
    if (found === null) return { state: "failed", rows: NONE };
    const { layout } = found;
    if (layout === "unsupported") return { state: "unsupported", rows: NONE };
    const answer = await run(binary, sqliteArguments(file, mode, sessionsQueryFor(layout)));
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
        return { state: "failed", rows: NONE };
      }
    },
    async askOnce(question, known) {
      const looked = await look();
      if (!("files" in looked)) {
        throw looked.state === "not-on-windows"
          ? new Error("OpenCode's database is not read on Windows.")
          : looked.error;
      }
      const { files } = looked;
      const stamp: DatabaseStamp = { database: files.database, wal: files.wal };
      if (known !== null && same(known.database, stamp.database) && same(known.wal, stamp.wal)) {
        return { unchanged: true, stamp };
      }
      const binary = await find();
      if (binary === null) throw new Error("No sqlite3 was found to read OpenCode's database.");
      const answer = await run(
        binary,
        sqliteArguments(file, modeOf(files), question),
        undefined,
        QUESTION_OUTPUT_BYTES,
      );
      if (!answer.ok) throw new Error("sqlite3 could not read OpenCode's database.");
      return { unchanged: false, stamp, stdout: answer.stdout };
    },
  };
}
