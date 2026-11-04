// Test fixtures only. Every id, name, path and word here is invented and
// generic. A database follows the tables Goose's source makes at v1.57.0
// (`create_schema` in `crates/goose/src/session/session_manager.rs`), as written
// up in docs/adapters/goose.md, and nothing in it is copied from a real machine:
// Goose was not run to make it. Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const DATA_DIR = `${HOME}/.local/share/goose`;
export const SESSIONS_DIR = `${DATA_DIR}/sessions`;
export const DATABASE = `${SESSIONS_DIR}/sessions.db`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** The title Goose gave a session, or the first four words of its first prompt. It must never leave the database. */
export const PRIVATE_TITLE = "placeholder words of a prompt";

/** Words written where a prompt, a reply, a tool's arguments, a setting or a secret goes. None may leave the database. */
export const PRIVATE_WORDS = "placeholder words that must never leave the database";

/** Seconds since the epoch, as the query prints a time. */
const seconds = (at: number) => Math.floor(at / SECOND);

/** A row as the question of the sessions prints it, for a session written a minute ago. */
export function printedRow(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "20261001_1",
    working_dir: PROJECT,
    own_name: null,
    created_s: seconds(NOW - HOUR),
    updated_s: seconds(NOW - MINUTE),
    ...changes,
  };
}

/** What `sqlite3 -json` prints for these rows: nothing at all for none. */
export function sqliteJson(rows: readonly Record<string, unknown>[]): string {
  return rows.length === 0 ? "" : `${JSON.stringify(rows)}\n`;
}

/** What the probe prints for a database laid out as Goose's, less any column named. */
export function probeJson(without: readonly string[] = []): string {
  const columns = [
    "id",
    "name",
    "description",
    "user_set_name",
    "session_type",
    "working_dir",
    "created_at",
    "updated_at",
    "archived_at",
  ];
  return sqliteJson([
    { kind: "table", name: "sessions" },
    { kind: "table", name: "messages" },
    ...columns
      .filter((name) => !without.includes(name))
      .map((name) => ({ kind: "sessions", name })),
    { kind: "messages", name: "session_id" },
  ]);
}

/**
 * Goose's tables, as `create_schema` makes them at v1.57.0, with `sessions` and
 * `messages` in full and the rest left out, since nothing asks for them.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT INTO schema_version (version) VALUES (17);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  user_set_name BOOLEAN DEFAULT FALSE,
  session_type TEXT NOT NULL DEFAULT 'user',
  working_dir TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  extension_data TEXT DEFAULT '{}',
  total_tokens INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  accumulated_total_tokens INTEGER,
  accumulated_input_tokens INTEGER,
  accumulated_output_tokens INTEGER,
  accumulated_cache_read_tokens INTEGER,
  accumulated_cache_write_tokens INTEGER,
  accumulated_cost REAL,
  schedule_id TEXT,
  recipe_json TEXT,
  user_recipe_values_json TEXT,
  provider_name TEXT,
  model_config_json TEXT,
  goose_mode TEXT NOT NULL DEFAULT 'auto',
  archived_at TIMESTAMP,
  project_id TEXT,
  parent_session_id TEXT,
  system_prompt_override TEXT,
  system_prompt_extras_json TEXT,
  container_id TEXT
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_timestamp INTEGER NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  tokens INTEGER,
  metadata_json TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_type ON sessions(session_type);
`;

/** Text as SQL, with its quotes doubled. */
const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface SessionFields {
  id?: string;
  name?: string;
  userSetName?: boolean;
  sessionType?: string;
  workingDir?: string;
  /** As SQL, so a test can write a time as Goose or an old import does. */
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
}

/**
 * One session's row, as Goose writes it, with its secrets in every column that
 * holds any, and one message, so nothing is listed for want of a message.
 */
export function sessionSql(fields: SessionFields = {}): string {
  const {
    id = "20261001_1",
    name = PRIVATE_TITLE,
    userSetName = false,
    sessionType = "user",
    workingDir = PROJECT,
    createdAt = "datetime('now', '-1 hours')",
    updatedAt = "datetime('now', '-1 minutes')",
    archivedAt = "NULL",
  } = fields;
  const secret = quoted(PRIVATE_WORDS);
  return `
INSERT INTO sessions (id, name, description, user_set_name, session_type, working_dir, created_at,
  updated_at, extension_data, total_tokens, recipe_json, user_recipe_values_json, provider_name,
  model_config_json, system_prompt_override, system_prompt_extras_json, archived_at)
VALUES (${quoted(id)}, ${quoted(name)}, ${secret}, ${userSetName ? 1 : 0}, ${quoted(sessionType)},
  ${quoted(workingDir)}, ${createdAt}, ${updatedAt}, ${quoted(`{"secret":"${PRIVATE_WORDS}"}`)}, 1234,
  ${secret}, ${secret}, 'demo-provider', ${secret}, ${secret}, ${secret}, ${archivedAt});
INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)
VALUES ('msg_1', ${quoted(id)}, 'user', ${quoted(`[{"type":"text","text":"${PRIVATE_WORDS}"}]`)},
  strftime('%s', 'now'), ${secret});
`;
}
