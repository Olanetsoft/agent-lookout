import path from "node:path";

/**
 * The two questions Agent Lookout asks OpenCode's database, `opencode.db`,
 * and how their answers are read. Both are fixed text: nothing from a file,
 * a request or a setting is ever put into them, and the cut-off time is
 * worked out inside SQLite. They are asked with the system's `sqlite3`
 * (`database.ts`), which prints each row as JSON.
 *
 * The first, the probe, asks only for the names of the tables and of the
 * columns of `session` and `session_v2`, so that the second is asked only of
 * a database laid out as OpenCode 1.x lays one out.
 *
 * The second asks, for each root session that is not archived and was
 * written in the last 48 hours, for its id, folder, title and two times, and
 * for a few short fields of its newest message: its times, its role, when it
 * ended, the name of its error and why it ended, how many of its tool parts
 * OpenCode would wait on, and when the person last wrote. Never the text of a
 * message or a part, a tool's input or output, `SELECT *` or a whole `data`
 * value. Each answer is checked field by field, and a row whose id is not one
 * OpenCode makes is dropped.
 *
 * This was built from OpenCode's source at v1.19.0, and has not yet been
 * checked on a computer running OpenCode.
 */

/** The file OpenCode keeps its sessions in, in its data folder. */
export const DATABASE_FILE = "opencode.db";

/**
 * The names of the tables the adapter reads, and of the columns of `session`
 * and `session_v2`. A table that is not there has no columns, rather than an
 * error.
 */
export const PROBE_QUERY = [
  "SELECT 'table' AS kind, name FROM sqlite_master",
  "WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2', 'session_message')",
  "UNION ALL SELECT 'session', name FROM pragma_table_info('session')",
  "UNION ALL SELECT 'session_v2', name FROM pragma_table_info('session_v2')",
].join(" ");

/** How far back a session's own row may have been written for it to be asked for: 48 hours. */
export const QUERY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The most sessions asked for, the newest first. */
export const MAX_SESSIONS = 200;

/**
 * Each root session of OpenCode 1.x that is not archived, written in the last
 * 48 hours, with the fields of its newest message. A tool part is counted as
 * OpenCode counts the ones it waits on: not one its model's provider ran
 * itself, and not one OpenCode marked as cut off when it cleaned up a step.
 * Those two marks are only tested inside SQLite: nothing of them is printed.
 *
 * Each `data` is read only once `json_valid` says it is JSON, so one row that
 * is not gives null fields rather than failing the whole answer. A title and
 * a folder are cut inside SQLite to a little more than is ever kept, so long
 * ones cannot fill the answer.
 */
export const SESSIONS_QUERY = [
  "SELECT s.id, substr(s.directory, 1, 4097) AS directory, substr(s.title, 1, 1000) AS title,",
  "s.time_created, s.time_updated,",
  "m.id AS m_id, m.time_created AS m_created, m.time_updated AS m_updated,",
  "CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS m_role,",
  "CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.time.completed') END AS m_completed,",
  "CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.error.name') END AS m_error,",
  "CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.finish') END AS m_finish,",
  "(SELECT count(*) FROM part p WHERE p.message_id = m.id",
  "AND CASE WHEN json_valid(p.data) THEN",
  "json_extract(p.data, '$.type') = 'tool'",
  "AND json_type(p.data, '$.metadata.providerExecuted') IS NOT 'true'",
  "AND NOT (json_extract(p.data, '$.state.status') IS 'error'",
  "AND json_type(p.data, '$.state.metadata.interrupted') IS 'true') END) AS m_tools,",
  "(SELECT max(p.time_updated) FROM part p WHERE p.message_id = m.id) AS p_updated,",
  "(SELECT u.time_created FROM message u WHERE u.session_id = s.id",
  "AND CASE WHEN json_valid(u.data) THEN json_extract(u.data, '$.role') = 'user' END",
  "ORDER BY u.time_created DESC, u.id DESC LIMIT 1) AS u_created",
  "FROM session s",
  "LEFT JOIN message m ON m.id = (SELECT x.id FROM message x WHERE x.session_id = s.id",
  "ORDER BY x.time_created DESC, x.id DESC LIMIT 1)",
  "WHERE s.parent_id IS NULL AND s.time_archived IS NULL",
  `AND s.time_updated >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - ${QUERY_WINDOW_MS}`,
  `ORDER BY s.time_updated DESC LIMIT ${MAX_SESSIONS}`,
].join(" ");

/** How the database is opened: as a file nothing changes, or as one OpenCode has open. */
export type DatabaseMode = "closed" | "open";

/**
 * The database as SQLite names it, read-only both ways:
 *
 * - closed, with no `-wal` beside it, or an empty one: `mode=ro&immutable=1`,
 *   which takes no lock and makes no file.
 * - open, with a `-wal` that holds something and the `-shm` there:
 *   `mode=ro&readonly_shm=1`, which reads what OpenCode has written to the
 *   `-wal` and opens the `-shm` read-only, so that nothing is written to either.
 */
export function sqliteUri(file: string, mode: DatabaseMode): string {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `file:${encoded}?mode=ro&${mode === "closed" ? "immutable=1" : "readonly_shm=1"}`;
}

/** The arguments `sqlite3` is given for one question, each as it is. */
export function sqliteArguments(file: string, mode: DatabaseMode, query: string): string[] {
  return ["-init", "/dev/null", "-batch", "-json", sqliteUri(file, mode), query];
}

/** The tables the adapter needs, and the columns of `session` it asks for. */
const NEEDED_TABLES = ["session", "message", "part"];
const NEEDED_COLUMNS = [
  "id",
  "parent_id",
  "directory",
  "title",
  "time_created",
  "time_updated",
  "time_archived",
];

/**
 * What the probe found:
 *
 * v1           OpenCode 1.x's tables, with every column asked for
 * v2-only      only OpenCode 2's `session_v2`, which is not read yet
 * unsupported  anything else: a version Agent Lookout does not read
 *
 * `opencode2` is true when `session_v2` is there, alone or beside 1.x's tables.
 */
export interface Schema {
  layout: "v1" | "v2-only" | "unsupported";
  opencode2: boolean;
}

/** The rows of what `sqlite3 -json` printed: an array of objects, or nothing for no rows. Null for anything else. */
function jsonRows(stdout: string): Record<string, unknown>[] | null {
  if (stdout.trim() === "") return [];
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
}

/** What the probe's answer says of the database, or null when it is not an answer. */
export function readSchema(stdout: string): Schema | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  const tables = new Set<string>();
  const columns = new Set<string>();
  for (const { kind, name } of rows) {
    if (typeof name !== "string") continue;
    if (kind === "table") tables.add(name);
    else if (kind === "session") columns.add(name);
  }
  const opencode2 = tables.has("session_v2");
  const v1 =
    NEEDED_TABLES.every((table) => tables.has(table)) &&
    NEEDED_COLUMNS.every((column) => columns.has(column));
  if (v1) return { layout: "v1", opencode2 };
  if (opencode2 && !tables.has("session")) return { layout: "v2-only", opencode2 };
  return { layout: "unsupported", opencode2 };
}

/** An id as OpenCode makes one for a session: `ses` and a short run of letters, digits, `_` and `-`. */
export const SESSION_ID = /^ses[0-9A-Za-z_-]{1,64}$/;

/** The longest folder kept. The query cuts one a character longer, so a longer one is still known to be too long. */
const MAX_FOLDER_LENGTH = 4096;

/** The longest title kept as it was read, which the query cuts it to. A name is cut shorter still. */
const MAX_TITLE_LENGTH = 1000;

/** The longest role, error name or reason a step ended that is kept. */
const MAX_WORD_LENGTH = 64;

/** A control character or a mark that turns text around, which no folder or word kept may hold. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** A whole number, or null for none. Anything else is not known. */
function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * A short field as it was read, for the mapping to judge: null for none, a
 * number as it is, and a short printable word. Anything else is kept as
 * `undefined`, which the mapping reads as a field of the wrong type, so no
 * long or unprintable text is ever kept.
 */
function shortField(value: unknown): unknown {
  if (value === null || typeof value === "number") return value;
  if (typeof value === "string" && value.length <= MAX_WORD_LENGTH && !UNPRINTABLE.test(value)) {
    return value;
  }
  return undefined;
}

/** A folder as it is shown: an absolute path, not too long, with nothing unprintable in it. Null otherwise. */
function folderOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_FOLDER_LENGTH) return null;
  if (!path.posix.isAbsolute(value) || UNPRINTABLE.test(value)) return null;
  return value;
}

/**
 * The title OpenCode gives a new session before a model names it, which says
 * nothing: `New session - ` or `Child session - ` and the time it was made
 * (`isDefaultTitle` in OpenCode's `session.ts`).
 */
const DEFAULT_TITLE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A title worth showing: text that is not OpenCode's placeholder. Null otherwise. */
function titleOf(value: unknown): string | null {
  if (typeof value !== "string" || DEFAULT_TITLE.test(value)) return null;
  return value.length > MAX_TITLE_LENGTH ? value.slice(0, MAX_TITLE_LENGTH) : value;
}

/** The fields of a session's newest message that are kept, as they were read. */
export interface MessageRow {
  createdAt: number | null;
  updatedAt: number | null;
  role: unknown;
  completedAt: unknown;
  error: unknown;
  finish: unknown;
  tools: unknown;
  /** The newest `time_updated` of the message's parts. */
  partsUpdatedAt: number | null;
}

/** One root session, as much of it as is kept. */
export interface SessionRow {
  /** OpenCode's id for it: `ses_` and 26 more characters. */
  id: string;
  folder: string | null;
  /** Its title, unless it is still OpenCode's placeholder. */
  title: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** The newest message, or null when it has none. */
  message: MessageRow | null;
  /** When the person last wrote in it. */
  userCreatedAt: number | null;
}

/**
 * The sessions in what `sqlite3 -json` printed for `SESSIONS_QUERY`. Null when
 * it is not that answer at all.
 */
export function readSessionRows(stdout: string): SessionRow[] | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  const sessions: SessionRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { id } = row;
    if (typeof id !== "string" || !SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const message: MessageRow | null =
      typeof row.m_id === "string"
        ? {
            createdAt: wholeNumber(row.m_created),
            updatedAt: wholeNumber(row.m_updated),
            role: shortField(row.m_role),
            completedAt: shortField(row.m_completed),
            error: shortField(row.m_error),
            finish: shortField(row.m_finish),
            tools: shortField(row.m_tools),
            partsUpdatedAt: wholeNumber(row.p_updated),
          }
        : null;
    sessions.push({
      id,
      folder: folderOf(row.directory),
      title: titleOf(row.title),
      createdAt: wholeNumber(row.time_created),
      updatedAt: wholeNumber(row.time_updated),
      message,
      userCreatedAt: wholeNumber(row.u_created),
    });
  }
  return sessions;
}
