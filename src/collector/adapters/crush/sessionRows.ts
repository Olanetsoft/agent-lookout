import { jsonRows } from "../opencode/sessionRows.ts";

/**
 * The two questions Agent Lookout asks a project's Crush database, `crush.db`,
 * and how their answers are read. Both are fixed text: nothing from a file, a
 * request or a setting is ever put into them, and the cut-off time is worked out
 * inside SQLite. They are asked with the system's `sqlite3` (`database.ts`),
 * which prints each row as JSON.
 *
 * The first asks for what a session shows. The second, the probe, is asked only
 * when the first fails, and asks only for the name of one table and of its
 * columns, to tell a database laid out as another version of Crush lays one out
 * from one that cannot be read.
 *
 * Of `sessions` the first prints three things: a session's id and two times. It
 * looks at `parent_session_id` and `message_count` to choose which rows. Never
 * `SELECT *`, `title`, `todos`, `channel`, `summary_message_id`, the token counts
 * or `cost`. No other table is named, so nothing of `messages`, `files` or
 * `read_files` is ever read.
 *
 * Crush's title stays inside SQLite. A model writes it from the first prompt, but
 * when that model answers with nothing, as one that only thinks can, the title is
 * the first 50 characters of the prompt, word for word (`GenerateTitle` in
 * `internal/agent/agent.go`). A person's rename is written to the same column.
 * Nothing on the row tells these apart.
 *
 * Each answer is checked field by field, and a row whose id is not one Crush
 * makes is dropped.
 *
 * Built from Crush's source at v0.99.0, and not yet checked on a computer
 * running Crush.
 */

/** How far back a session may have been written for it to be asked for, in hours. */
export const QUERY_WINDOW_HOURS = 48;

/** The most sessions asked for from one database, the newest first. */
export const MAX_SESSIONS = 200;

/** The longest id kept. The query cuts one a character longer, so a longer one is still known to be too long. */
const MAX_ID_LENGTH = 128;

/**
 * The newest sessions of a project that are no other session's child, have a
 * message and were written in the last 48 hours. Crush's own lists leave out a
 * row with a parent, which is a subagent's run. Crush makes a session as its
 * first prompt is sent, so `message_count` leaves out only one whose prompt never
 * got saved.
 *
 * `sessions` has no index on `updated_at`, so a read walks that one table and no
 * other. Ids are cut inside SQLite, so a long one cannot fill the answer.
 */
export const SESSIONS_QUERY = [
  `SELECT substr(id, 1, ${MAX_ID_LENGTH + 1}) AS id, created_at, updated_at`,
  "FROM sessions",
  "WHERE parent_session_id IS NULL AND message_count > 0",
  `AND updated_at >= CAST(strftime('%s', 'now') AS INTEGER) - ${QUERY_WINDOW_HOURS * 3600}`,
  `ORDER BY updated_at DESC LIMIT ${MAX_SESSIONS}`,
].join(" ");

/**
 * The name of the one table the adapter reads, and of its columns. A table that
 * is not there has no columns, rather than an error.
 */
export const PROBE_QUERY = [
  "SELECT 'table' AS kind, name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
  "UNION ALL SELECT 'sessions', name FROM pragma_table_info('sessions')",
].join(" ");

/** The columns of `sessions` the first question names, each there since Crush's first release. */
const NEEDED_COLUMNS = ["id", "parent_session_id", "message_count", "created_at", "updated_at"];

/** What the probe found: Crush's layout, anything else, or null when its answer is not one. */
export function readSchema(stdout: string): "supported" | "unsupported" | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  const names = (kind: string) =>
    new Set(rows.filter((row) => row.kind === kind).map((row) => row.name));
  const columns = names("sessions");
  const supported =
    names("table").has("sessions") && NEEDED_COLUMNS.every((column) => columns.has(column));
  return supported ? "supported" : "unsupported";
}

/**
 * An id Crush could have made. A session with no parent has a UUID
 * (`Create` in `internal/session/session.go`), and these characters cover that
 * and leave out `$$`, which only a subagent's run has.
 */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** One session, as much of it as is kept. */
export interface SessionRow {
  /** Crush's id for it. */
  id: string;
  /** `created_at`, in epoch milliseconds. */
  createdAt: number | null;
  /** `updated_at`, in epoch milliseconds, to the second. */
  updatedAt: number | null;
}

/** Whole seconds as epoch milliseconds, or null for anything else. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return Number.isSafeInteger(value * 1000) ? value * 1000 : null;
}

/** The sessions in what `sqlite3 -json` printed for `SESSIONS_QUERY`. Null when it is not that answer at all. */
export function readSessionRows(stdout: string): SessionRow[] | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  return rows.flatMap((row) => {
    const { id } = row;
    if (typeof id !== "string" || !SESSION_ID.test(id)) return [];
    return { id, createdAt: timeOf(row.created_at), updatedAt: timeOf(row.updated_at) };
  });
}
