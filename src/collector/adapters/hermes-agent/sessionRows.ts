import path from "node:path";

/**
 * The two questions Agent Lookout asks a Hermes Agent profile's database,
 * `state.db`, and how their answers are read. Both are fixed text: nothing
 * from a file, a request or a setting is ever put into them, and every
 * cut-off is worked out inside SQLite. They are asked with the system's
 * `sqlite3` (`database.ts`), which prints each row as JSON.
 *
 * The first, the probe, asks only for the names of three tables and of their
 * columns, so that the second is asked only of a database laid out as Hermes
 * Agent v0.21.6 and later lay one out. Hermes Agent's own advice is to tell its
 * versions apart by their columns, never by its schema number, which is not
 * read.
 *
 * The second asks, for each conversation written in the last 48 hours, for
 * the ids, folders, titles, times, end and source of its rows, for a few short
 * fields of the newest row of its conversation, and for the times and process
 * of its turn lease. Its JSON columns, the activity label and a tool call's
 * name are only tested inside SQLite, as 0, 1 or a count: nothing of their
 * text is printed. Never a message's text, a tool's input or output, a system
 * prompt, a chat's or user's name or id, `SELECT *` or any other table.
 *
 * Each answer is checked field by field as it is read, and a row whose id is
 * not one Hermes Agent makes is dropped.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** The file each Hermes Agent profile keeps its sessions in. */
export const DATABASE_FILE = "state.db";

/**
 * The names of the tables the adapter reads, and of their columns. A table
 * that is not there has no columns, rather than an error.
 */
export const PROBE_QUERY = [
  "SELECT 'table' AS kind, name FROM sqlite_master",
  "WHERE type = 'table' AND name IN ('sessions', 'messages', 'session_turn_leases')",
  "UNION ALL SELECT 'sessions', name FROM pragma_table_info('sessions')",
  "UNION ALL SELECT 'messages', name FROM pragma_table_info('messages')",
  "UNION ALL SELECT 'session_turn_leases', name FROM pragma_table_info('session_turn_leases')",
].join(" ");

/** How far back a row's own times or messages may fall for it to be asked for: 48 hours, in seconds. */
export const QUERY_WINDOW_SECONDS = 48 * 60 * 60;

/** The most rows asked for, the newest first. */
export const MAX_ROWS = 500;

/** How many compressions back a row's conversation is followed to its root. */
export const MAX_CHAIN_DEPTH = 64;

/** A marker Hermes Agent keeps in a row's `model_config`, tested as Hermes Agent tests it, inside SQLite. */
function marker(table: string, key: string): string {
  return `(CASE WHEN json_valid(${table}.model_config) THEN json_extract(${table}.model_config, '$.${key}') END)`;
}

/**
 * Each conversation written in the last 48 hours, one row for each of its
 * rows that falls in the window, with the conversation's root:
 *
 * - `recent`: the rows whose own times, or whose messages, fall in the window.
 * - `up` and `heads`: each such row's conversation, followed back through the
 *   rows Hermes Agent started when it compressed a conversation, as its own
 *   `_CHAIN_STEP_SQL` follows them (`hermes_state_compression.py`).
 * - The root is listed when it is a conversation of its own, by Hermes
 *   Agent's own rules: no parent, or a branch, or a reset child
 *   (`hermes_state_common.py`). A subagent's run, an archived or hidden row,
 *   and the sources Hermes Agent hides from people, `kanban`, `tool` and
 *   `oneshot`, are not (`hermes_state_sessions.py`).
 * - `n`, the newest row of the conversation that is not `session_meta` or
 *   `system`, as Hermes Agent's `latest_conversation_role` takes it.
 * - `a`, the newest assistant row with tool calls: its `clarify` calls with
 *   no result yet are counted, and so are its calls of any tool with no
 *   result yet, which say whether a waiting label can still be its.
 * - `l`, the turn lease on the root, its holder cut to its pid and pid
 *   namespace inside SQLite.
 *
 * A title and a folder are cut inside SQLite to a little more than is ever
 * kept, so long ones cannot fill the answer.
 */
export const SESSIONS_QUERY = [
  "WITH RECURSIVE",
  `cut(t) AS (SELECT CAST(strftime('%s', 'now') AS REAL) - ${QUERY_WINDOW_SECONDS}),`,
  "recent(id) AS (",
  "SELECT s.id FROM sessions s, cut",
  "WHERE max(s.started_at, coalesce(s.ended_at, 0), coalesce(s.last_activity_at, 0)) >= cut.t",
  "OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.timestamp >= cut.t)",
  "),",
  "up(id, root, depth) AS (",
  "SELECT id, id, 0 FROM recent",
  "UNION ALL",
  "SELECT up.id, p.id, up.depth + 1",
  "FROM up",
  "JOIN sessions c ON c.id = up.root",
  "JOIN sessions p ON p.id = c.parent_session_id",
  `WHERE up.depth < ${MAX_CHAIN_DEPTH}`,
  "AND p.end_reason = 'compression'",
  `AND ${marker("c", "_branched_from")} IS NULL`,
  `AND ${marker("c", "_delegate_from")} IS NULL`,
  `AND ${marker("c", "_reset_from")} IS NULL`,
  "AND coalesce(c.source, '') != 'tool'",
  "),",
  "heads(id, root, depth) AS (SELECT id, root, max(depth) FROM up GROUP BY id)",
  "SELECT h.root AS root_id, c.id,",
  "r.source AS root_source, r.created_source AS root_created_source, r.started_at AS root_started_at,",
  "substr(r.title, 1, 1000) AS root_title, substr(r.cwd, 1, 4097) AS root_cwd,",
  "c.started_at, c.ended_at, c.end_reason, c.last_activity_at,",
  "(SELECT max(m.timestamp) FROM messages m WHERE m.session_id = c.id) AS last_message_at,",
  "substr(c.title, 1, 1000) AS title, substr(c.cwd, 1, 4097) AS cwd,",
  "c.last_activity_description LIKE 'waiting for user approval%' AS approval_label,",
  "c.last_activity_description LIKE 'waiting for user clarify response%' AS question_label,",
  "n.role AS n_role, n.timestamp AS n_at, n.display_kind AS n_kind, n.finish_reason AS n_finish,",
  "CASE WHEN json_valid(n.display_metadata) THEN json_type(n.display_metadata, '$.error') IS NOT NULL END AS n_error,",
  "a.timestamp AS calls_at,",
  "(SELECT count(*) FROM json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END) q",
  "WHERE json_extract(q.value, '$.function.name') = 'clarify'",
  "AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.session_id = c.id AND x.role = 'tool' AND x.id > a.id",
  "AND x.tool_call_id = json_extract(q.value, '$.id'))) AS open_questions,",
  "(SELECT count(*) FROM json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END) q",
  "WHERE NOT EXISTS (SELECT 1 FROM messages x WHERE x.session_id = c.id AND x.role = 'tool' AND x.id > a.id",
  "AND x.tool_call_id = json_extract(q.value, '$.id'))) AS open_calls,",
  "l.acquired_at AS lease_at, l.expires_at AS lease_until,",
  "CASE WHEN l.holder GLOB 'pid=[0-9]*' THEN CAST(substr(l.holder, 5) AS INTEGER) END AS lease_pid,",
  "CASE WHEN instr(l.holder, ':pidns=') > 0 THEN CAST(substr(l.holder, instr(l.holder, ':pidns=') + 7) AS INTEGER) END AS lease_pidns",
  "FROM heads h",
  "JOIN sessions c ON c.id = h.id",
  "JOIN sessions r ON r.id = h.root",
  "LEFT JOIN messages n ON n.id = (SELECT x.id FROM messages x WHERE x.session_id = c.id AND x.active = 1",
  "AND x.role NOT IN ('session_meta', 'system') ORDER BY x.id DESC LIMIT 1)",
  "LEFT JOIN messages a ON a.id = (SELECT x.id FROM messages x WHERE x.session_id = c.id AND x.active = 1",
  "AND x.role = 'assistant' AND x.tool_calls IS NOT NULL ORDER BY x.id DESC LIMIT 1)",
  "LEFT JOIN session_turn_leases l ON l.conversation_id = h.root",
  "WHERE (r.parent_session_id IS NULL",
  `OR ${marker("r", "_branched_from")} IS NOT NULL`,
  "OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = r.parent_session_id",
  "AND p.end_reason = 'branched' AND r.started_at >= p.ended_at)",
  `OR ${marker("r", "_reset_from")} IS NOT NULL`,
  "OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = r.parent_session_id",
  "AND p.end_reason IN ('session_reset', 'session_switch', 'idle', 'daily', 'suspended', 'resume_pending_expired')",
  "AND r.session_key IS NOT NULL AND r.session_key != '' AND r.session_key = p.session_key))",
  `AND ${marker("r", "_delegate_from")} IS NULL`,
  "AND r.archived = 0 AND r.hidden = 0",
  "AND coalesce(r.source, '') NOT IN ('kanban', 'tool', 'oneshot')",
  "ORDER BY max(c.started_at, coalesce(c.ended_at, 0), coalesce(c.last_activity_at, 0)) DESC, c.id DESC",
  `LIMIT ${MAX_ROWS}`,
].join(" ");

/**
 * How the database is opened, each way read-only:
 *
 * - rollback: a database in rollback-journal mode, which Hermes Agent writes
 *   to directly. Read with a shared lock, so a commit is waited out for up to
 *   a second rather than read half-written.
 * - whole: a database in WAL mode with no `-wal`, or an empty one, read as a
 *   file nothing changes.
 * - with-wal: a database in WAL mode whose `-wal` holds something, read with
 *   it.
 */
export type DatabaseMode = "rollback" | "whole" | "with-wal";

/** How long a rollback-journal read waits for a commit to end, in milliseconds. */
export const BUSY_TIMEOUT_MS = 1000;

/**
 * The database as SQLite names it, read-only each way:
 *
 * - whole: `mode=ro&immutable=1`, which takes no lock and makes no file.
 * - rollback and with-wal: `mode=ro&readonly_shm=1`. With the `-wal`, it
 *   reads what Hermes Agent has written there and opens the `-shm` read-only,
 *   so nothing is written to either. In rollback mode there is no `-shm` to
 *   open, and `readonly_shm=1` keeps it so if Hermes Agent switches the
 *   database to WAL mode between the look at its header and the read.
 */
export function sqliteUri(file: string, mode: DatabaseMode): string {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `file:${encoded}?mode=ro&${mode === "whole" ? "immutable=1" : "readonly_shm=1"}`;
}

/** The arguments `sqlite3` is given for one question, each as it is. */
export function sqliteArguments(file: string, mode: DatabaseMode, query: string): string[] {
  const wait = mode === "rollback" ? ["-cmd", `.timeout ${BUSY_TIMEOUT_MS}`] : [];
  return ["-init", "/dev/null", "-batch", "-json", ...wait, sqliteUri(file, mode), query];
}

/** The tables the adapter needs, and the columns of each it asks for. */
const NEEDED: Record<string, readonly string[]> = {
  sessions: [
    "id",
    "source",
    "created_source",
    "parent_session_id",
    "started_at",
    "ended_at",
    "end_reason",
    "cwd",
    "title",
    "model_config",
    "session_key",
    "archived",
    "hidden",
    "last_activity_at",
    "last_activity_description",
  ],
  messages: [
    "id",
    "session_id",
    "role",
    "timestamp",
    "active",
    "display_kind",
    "display_metadata",
    "finish_reason",
    "tool_calls",
    "tool_call_id",
  ],
  session_turn_leases: ["conversation_id", "holder", "acquired_at", "expires_at"],
};

/**
 * What the probe found: `supported`, every table and column asked for, which
 * Hermes Agent has from v0.21.6, the first with `created_source`; or
 * `unsupported`, anything else.
 */
export type Schema = "supported" | "unsupported";

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
  const columns = new Map<string, Set<string>>();
  for (const { kind, name } of rows) {
    if (typeof kind !== "string" || typeof name !== "string") continue;
    if (kind === "table") tables.add(name);
    else columns.set(kind, (columns.get(kind) ?? new Set()).add(name));
  }
  const supported = Object.entries(NEEDED).every(
    ([table, needed]) =>
      tables.has(table) && needed.every((column) => columns.get(table)?.has(column) === true),
  );
  return supported ? "supported" : "unsupported";
}

/**
 * An id as Hermes Agent makes one for a session, of every shape it mints
 * (`hermes_state_ids.py`): letters, digits, `.`, `_` and `-`, starting with a
 * letter or a digit.
 */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The longest folder kept. The query cuts one a character longer, so a longer one is still known to be too long. */
const MAX_FOLDER_LENGTH = 4096;

/** The longest title kept as it was read, which the query cuts it to. A name is cut shorter still. */
const MAX_TITLE_LENGTH = 1000;

/** The longest role, kind, reason or source that is kept. */
const MAX_WORD_LENGTH = 64;

/** A control character or a mark that turns text around, which no folder or word kept may hold. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** The latest a time in seconds may be and still be kept: the year 9999. */
const MAX_SECONDS = 253_402_300_799;

/**
 * A time Hermes Agent wrote in seconds, as milliseconds: null for none, and
 * `undefined`, a field of the wrong type, for anything but a number that
 * could be a time.
 */
function timeOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > MAX_SECONDS) return undefined;
  return Math.round(value * 1000);
}

/**
 * A short word as it was read, for the mapping to judge: null for none, a
 * short printable word as it is, and `undefined`, a field of the wrong type,
 * for anything else, so no long or unprintable text is ever kept.
 */
function wordOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && value.length <= MAX_WORD_LENGTH && !UNPRINTABLE.test(value)) {
    return value;
  }
  return undefined;
}

/** A flag: 0, 1 or null, and `undefined` for anything else. */
function flagOf(value: unknown): 0 | 1 | null | undefined {
  return value === 0 || value === 1 || value === null ? value : undefined;
}

/** A count: a whole number of none or more, null for none, and `undefined` for anything else. */
function countOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** A whole number, or null for none or anything else. */
function wholeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** A folder as it is shown: an absolute path, not too long, with nothing unprintable in it. Null otherwise. */
function folderOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_FOLDER_LENGTH) return null;
  if (!path.posix.isAbsolute(value) || UNPRINTABLE.test(value)) return null;
  return value;
}

/** A title, cut to `MAX_TITLE_LENGTH`. Null for none or anything but text. */
function titleOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > MAX_TITLE_LENGTH ? value.slice(0, MAX_TITLE_LENGTH) : value;
}

/** The root of a conversation: the row it began with, as far as it is kept. */
export interface RootRow {
  /** `source`: `cli`, `local`, `telegram`, `cron` and so on. */
  source: string | null | undefined;
  /** `created_source`: for a `local` row, the surface that made it, `cli`, `tui` or `desktop`. */
  createdSource: string | null | undefined;
  startedAt: number | null | undefined;
  title: string | null;
  folder: string | null;
}

/** The newest row of a row's conversation, as far as it is kept. */
export interface NewestRow {
  role: string | null | undefined;
  at: number | null | undefined;
  kind: string | null | undefined;
  finish: string | null | undefined;
  /** 1 when its `display_metadata` holds an `error` key, else 0, or null when that is not JSON. */
  error: 0 | 1 | null | undefined;
}

/** The turn lease on a conversation's root, as far as it is kept. */
export interface LeaseRow {
  at: number | null | undefined;
  until: number | null | undefined;
  /** The holder's process id, or null when its holder names none. */
  pid: number | null;
  /** The holder's pid namespace, or null when its holder names none. */
  pidns: number | null;
}

/**
 * One row of a conversation, with its root, as much of it as is kept. Times
 * are in milliseconds. A field that is `undefined` was of the wrong type.
 */
export interface HermesRow {
  /** The id of the conversation's root. */
  rootId: string;
  /** This row's own id. */
  id: string;
  root: RootRow;
  startedAt: number | null | undefined;
  endedAt: number | null | undefined;
  endReason: string | null | undefined;
  lastActivityAt: number | null | undefined;
  lastMessageAt: number | null | undefined;
  title: string | null;
  folder: string | null;
  approvalLabel: 0 | 1 | null | undefined;
  questionLabel: 0 | 1 | null | undefined;
  /** The newest conversation row, or null when it has none. */
  newest: NewestRow | null;
  /** When the newest assistant row with tool calls was written. */
  callsAt: number | null | undefined;
  /** How many `clarify` calls of that row have no result yet. */
  openQuestions: number | null | undefined;
  /** How many calls of that row, of any tool, have no result yet. */
  openCalls: number | null | undefined;
  /** The root's turn lease, or null when no turn holds one. */
  lease: LeaseRow | null;
}

/**
 * The rows in what `sqlite3 -json` printed for `SESSIONS_QUERY`. Null when it
 * is not that answer at all.
 */
export function readSessionRows(stdout: string): HermesRow[] | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  const kept: HermesRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const { root_id: rootId, id } = row;
    if (typeof rootId !== "string" || !SESSION_ID.test(rootId)) continue;
    if (typeof id !== "string" || !SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const hasNewest = row.n_role !== null && row.n_role !== undefined;
    const hasLease =
      (row.lease_at !== null && row.lease_at !== undefined) ||
      (row.lease_until !== null && row.lease_until !== undefined);
    kept.push({
      rootId,
      id,
      root: {
        source: wordOf(row.root_source),
        createdSource: wordOf(row.root_created_source),
        startedAt: timeOf(row.root_started_at),
        title: titleOf(row.root_title),
        folder: folderOf(row.root_cwd),
      },
      startedAt: timeOf(row.started_at),
      endedAt: timeOf(row.ended_at),
      endReason: wordOf(row.end_reason),
      lastActivityAt: timeOf(row.last_activity_at),
      lastMessageAt: timeOf(row.last_message_at),
      title: titleOf(row.title),
      folder: folderOf(row.cwd),
      approvalLabel: flagOf(row.approval_label),
      questionLabel: flagOf(row.question_label),
      newest: hasNewest
        ? {
            role: wordOf(row.n_role),
            at: timeOf(row.n_at),
            kind: wordOf(row.n_kind),
            finish: wordOf(row.n_finish),
            error: flagOf(row.n_error),
          }
        : null,
      callsAt: timeOf(row.calls_at),
      openQuestions: countOf(row.open_questions),
      openCalls: countOf(row.open_calls),
      lease: hasLease
        ? {
            at: timeOf(row.lease_at),
            until: timeOf(row.lease_until),
            pid: wholeOf(row.lease_pid),
            pidns: wholeOf(row.lease_pidns),
          }
        : null,
    });
  }
  return kept;
}
