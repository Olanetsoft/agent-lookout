import path from "node:path";

import { jsonRows } from "../opencode/sessionRows.ts";

/**
 * The two questions Agent Lookout asks Goose's database, `sessions.db`, and how
 * their answers are read. Both are fixed text: nothing from a file, a request or
 * a setting is ever put into them, and the cut-off time is worked out inside
 * SQLite. They are asked with the system's `sqlite3` (`database.ts`), which
 * prints each row as JSON.
 *
 * The first asks for what a session shows. The second, the probe, is asked only
 * when the first fails, and asks only for the names of two tables and of their
 * columns, to tell a database laid out as another version of Goose lays one out
 * from one that cannot be read.
 *
 * Of `sessions` the first asks for five named things: its id, its folder, its
 * name only where the person set it, and two times, as whole seconds. Of
 * `messages` it asks only whether a session has a row. Never `SELECT *`, a
 * message's `content_json` or `metadata_json`, a system prompt, a recipe,
 * `extension_data`, `model_config_json`, the token counts or `provider_name`.
 *
 * A name Goose gave a session stays inside SQLite. Goose has a model write a
 * title from the first prompts, but with a provider that runs its own program,
 * such as Claude Code, Codex, Gemini CLI, Cursor Agent or any agent run through
 * ACP, the title is the first four words of the first prompt
 * (`generate_simple_session_description` in `providers/cli_common.rs`). Nothing
 * on the row tells the two apart: `provider_name` is the provider a session has
 * now, which can have changed since it was named, and the list of those
 * providers is open. Only `user_set_name` says what a name is: one the person
 * gave, or a title an ACP client sent (`new_session.rs`), which Goose marks the
 * same way, so that nothing on the row tells the two apart.
 *
 * Each answer is checked field by field, and a row whose id is not one Goose
 * makes is dropped.
 *
 * Built from Goose's source at v1.57.0, and not yet checked on a computer
 * running Goose.
 */

/** The folder of Goose's data folder that holds its database, and the database's name. */
export const DATABASE_FOLDER = "sessions";
export const DATABASE_FILE = "sessions.db";

/** How far back a session may have been written for it to be asked for, in hours. */
export const QUERY_WINDOW_HOURS = 48;

/** The most sessions asked for, the newest first. */
export const MAX_SESSIONS = 200;

/** The longest folder kept. The query cuts one a character longer, so a longer one is still known to be too long. */
const MAX_FOLDER_LENGTH = 4096;

/**
 * The newest sessions of the three kinds Goose lists to people, that are not
 * archived, were written in the last 48 hours and have a message. Goose's own
 * lists leave out `sub_agent`, `hidden`, `terminal` and `gateway`, and its
 * desktop app a session with no message, as each new chat is until its first
 * prompt.
 *
 * `updated_at` is compared as text, and the `+` before `session_type` keeps
 * SQLite on `idx_sessions_updated`, so a read walks the last 48 hours' sessions
 * alone, newest first, and stops at 200. Goose writes `updated_at` with
 * `datetime('now')`, and `strftime` reads that and the RFC 3339 form a session
 * imported from before 1.10.0 keeps. An RFC 3339 time sorts after a `datetime` of
 * the same day, so such a session can be asked for up to a day early, and never
 * missed. Its 24 hours are judged again in `toSession.ts`.
 *
 * Folders and names are cut inside SQLite, so long ones cannot fill the answer.
 */
export const SESSIONS_QUERY = [
  `SELECT s.id, substr(s.working_dir, 1, ${MAX_FOLDER_LENGTH + 1}) AS working_dir,`,
  "CASE WHEN s.user_set_name = 1 THEN substr(s.name, 1, 1000) END AS own_name,",
  "CAST(strftime('%s', s.created_at) AS INTEGER) AS created_s,",
  "CAST(strftime('%s', s.updated_at) AS INTEGER) AS updated_s",
  "FROM sessions s",
  "WHERE +s.session_type IN ('user', 'scheduled', 'acp') AND s.archived_at IS NULL",
  `AND s.updated_at >= datetime('now', '-${QUERY_WINDOW_HOURS} hours')`,
  "AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)",
  `ORDER BY s.updated_at DESC LIMIT ${MAX_SESSIONS}`,
].join(" ");

/**
 * The names of the two tables the adapter reads, and of their columns. A table
 * that is not there has no columns, rather than an error.
 */
export const PROBE_QUERY = [
  "SELECT 'table' AS kind, name FROM sqlite_master",
  "WHERE type = 'table' AND name IN ('sessions', 'messages')",
  "UNION ALL SELECT 'sessions', name FROM pragma_table_info('sessions')",
  "UNION ALL SELECT 'messages', name FROM pragma_table_info('messages')",
].join(" ");

/** The columns of `sessions` the first question names. `archived_at` came with Goose v1.34.0. */
const NEEDED_COLUMNS = [
  "id",
  "name",
  "user_set_name",
  "session_type",
  "working_dir",
  "created_at",
  "updated_at",
  "archived_at",
];

/** What the probe found: Goose's layout, anything else, or null when its answer is not one. */
export function readSchema(stdout: string): "supported" | "unsupported" | null {
  const rows = jsonRows(stdout);
  if (rows === null) return null;
  const names = (kind: string) =>
    new Set(rows.filter((row) => row.kind === kind).map((row) => row.name));
  const tables = names("table");
  const sessions = names("sessions");
  const supported =
    tables.has("sessions") &&
    tables.has("messages") &&
    names("messages").has("session_id") &&
    NEEDED_COLUMNS.every((column) => sessions.has(column));
  return supported ? "supported" : "unsupported";
}

/**
 * An id as Goose makes one: `YYYYMMDD_<count>`, or 1 to 128 of these characters
 * when a client gives its own (`create_session` in `session_manager.rs`).
 */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A control character or a mark that turns text around, which no folder kept may hold. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** One session, as much of it as is kept. */
export interface SessionRow {
  /** Goose's id for it. */
  id: string;
  folder: string | null;
  /** The name `user_set_name` marks, which the person gave it or an ACP client sent, or null. */
  ownName: string | null;
  /** `created_at`, in epoch milliseconds. */
  createdAt: number | null;
  /** `updated_at`, in epoch milliseconds, to the second. */
  updatedAt: number | null;
}

/** A folder as it is shown: an absolute path, not too long, with nothing unprintable in it. Null otherwise. */
function folderOf(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_FOLDER_LENGTH) return null;
  if (!path.posix.isAbsolute(value) || UNPRINTABLE.test(value)) return null;
  return value;
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
    const { id, own_name: ownName } = row;
    if (typeof id !== "string" || !SESSION_ID.test(id)) return [];
    return {
      id,
      folder: folderOf(row.working_dir),
      ownName: typeof ownName === "string" ? ownName : null,
      createdAt: timeOf(row.created_s),
      updatedAt: timeOf(row.updated_s),
    };
  });
}
