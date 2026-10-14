import type { FileInfo } from "../../../files/readOnlyIo.ts";
import { findSqlite, runSqlite, summariesUri, RETRY_MS, type RunSqlite } from "./summaries.ts";

/**
 * Whether an Antigravity 2.0 chat waits for the person, from its own
 * database: `conversations/<id>.db`, a SQLite database whose `steps` table
 * holds one row a step, numbered by `idx`, with its status as a number.
 * While the app asks the person to approve a step, the newest step's status
 * is `CORTEX_STEP_STATUS_WAITING`, 9, whatever the step's type. The
 * transcript holds no such step until it is answered.
 *
 * It is read with the system's `sqlite3`, found and started as for the list
 * of chats (`summaries.ts`), with one question that asks for two numbers and
 * nothing else:
 *
 *     sqlite3 -init /dev/null -batch -json 'file:<the file>?mode=ro&immutable=1'
 *       'SELECT idx, status FROM steps ORDER BY idx DESC LIMIT 1'
 *
 * Never a step's payload, its metadata or its permissions, which hold what
 * was written in a chat. `immutable=1` takes no lock and makes no file, and
 * so does not see what the app has written to the database's `-wal` file
 * and not yet moved into it. The app closes the database after each write,
 * which moves it in and removes that file, so a chat that waits is read
 * whole. While the `-wal` file is there, the database may be behind, and is
 * not read: the chat shows as it would without it.
 *
 * A chat's database is read again only when its size or modified time
 * changed since a read that worked, or a minute after one that did not.
 * Nothing is read on Windows.
 */

/** `CORTEX_STEP_STATUS_WAITING` in Antigravity's program: the newest step's status while the app waits for the person. */
export const WAITING_STATUS = 9;

/** The two numbers read, and nothing else. */
export const NEWEST_STEP_QUERY = "SELECT idx, status FROM steps ORDER BY idx DESC LIMIT 1";

/** The arguments `sqlite3` is given, each as it is. */
export function waitArguments(file: string): string[] {
  return ["-init", "/dev/null", "-batch", "-json", summariesUri(file), NEWEST_STEP_QUERY];
}

/** The newest step's number and status. */
export interface NewestStep {
  idx: number;
  status: number;
}

/**
 * The newest step from what `sqlite3 -json` printed: null for a table with no
 * rows, which prints nothing, and undefined for anything that is not one row
 * of two whole numbers.
 */
export function newestStep(stdout: string): NewestStep | null | undefined {
  if (stdout.trim() === "") return null;
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows) || rows.length !== 1) return undefined;
  const row: unknown = rows[0];
  if (typeof row !== "object" || row === null) return undefined;
  const { idx, status } = row as Record<string, unknown>;
  if (!Number.isSafeInteger(idx) || !Number.isSafeInteger(status)) return undefined;
  return { idx: idx as number, status: status as number };
}

/**
 * What one chat's database says:
 *
 * waiting      its newest step waits for the person, since `since`
 * not-waiting  it has no step that waits, or no step yet
 * not-read     there was nothing to read: no database, its `-wal` file is there, or Windows
 * no-sqlite    no `sqlite3` was found to read it
 * failed       `sqlite3` did not answer, or its answer could not be read
 */
export type Wait =
  | { state: "waiting"; since: number }
  | { state: "not-waiting" | "not-read" | "no-sqlite" | "failed" };

export interface WaitReader {
  /**
   * Whether the chat waits, from its database as `lstat` saw it this poll and
   * whether its `-wal` file is there. Never throws.
   */
  read(
    id: string,
    file: string,
    info: FileInfo | null,
    logThere: boolean,
    at: number,
  ): Promise<Wait>;
  /** Forgets every chat but these. */
  keepOnly(ids: ReadonlySet<string>): void;
}

const NOT_READ: Wait = { state: "not-read" };

export function createWaitReader(options: {
  platform: NodeJS.Platform;
  run?: RunSqlite;
  find?: () => Promise<string | null>;
}): WaitReader {
  const { platform } = options;
  const run = options.run ?? runSqlite;
  const find = options.find ?? (() => findSqlite());
  /** Each chat's last read, with its database as it was then, when it was made, and its newest step. */
  const last = new Map<string, { wait: Wait; info: FileInfo; at: number; idx: number | null }>();

  async function read(
    id: string,
    file: string,
    info: FileInfo | null,
    logThere: boolean,
    at: number,
  ): Promise<Wait> {
    if (platform === "win32" || info === null || info.kind !== "file" || logThere) {
      last.delete(id);
      return NOT_READ;
    }
    const before = last.get(id);
    const unchanged =
      before !== undefined &&
      before.info.ino === info.ino &&
      before.info.size === info.size &&
      before.info.mtimeMs === info.mtimeMs;
    // A clock set back counts as time enough.
    const due = before === undefined || at - before.at < 0 || at - before.at >= RETRY_MS;
    const worked = before?.wait.state === "waiting" || before?.wait.state === "not-waiting";
    if (before !== undefined && (worked ? unchanged : !due)) return before.wait;

    const binary = await find();
    if (binary === null) {
      last.set(id, { wait: { state: "no-sqlite" }, info, at, idx: null });
      return { state: "no-sqlite" };
    }
    const answer = await run(binary, waitArguments(file));
    const step = answer.ok ? newestStep(answer.stdout) : undefined;
    let wait: Wait;
    if (step === undefined) {
      wait = { state: "failed" };
    } else if (step === null || step.status !== WAITING_STATUS) {
      wait = { state: "not-waiting" };
    } else if (before?.wait.state === "waiting" && before.idx === step.idx) {
      // The same step still waits: it has done so since it was first seen to.
      wait = before.wait;
    } else {
      wait = { state: "waiting", since: Math.floor(info.mtimeMs) };
    }
    last.set(id, { wait, info, at, idx: step?.idx ?? null });
    return wait;
  }

  return {
    async read(id, file, info, logThere, at) {
      try {
        return await read(id, file, info, logThere, at);
      } catch {
        last.delete(id);
        return { state: "failed" };
      }
    },
    keepOnly(ids) {
      for (const id of last.keys()) {
        if (!ids.has(id)) last.delete(id);
      }
    },
  };
}
