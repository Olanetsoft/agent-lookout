// Test fixtures only. Every id, name, path and word here is invented and
// generic. A database follows the tables Crush's source makes at v0.99.0 (the
// migrations in `internal/db/migrations/`), and a list of projects the file
// `internal/projects/projects.go` writes, as written up in
// docs/adapters/crush.md, and nothing in them is copied from a real machine:
// Crush was not run to make them. Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const DATA_DIR = `${HOME}/.local/share/crush`;
export const PROJECT_LIST = `${DATA_DIR}/projects.json`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A folder the fixture's sessions run in, and its `.crush` and database. */
export const PROJECT = `${HOME}/code/demo-project`;
export const DATA_FOLDER = `${PROJECT}/.crush`;
export const DATABASE = `${DATA_FOLDER}/crush.db`;

/** Another project, and its database. */
export const OTHER_PROJECT = `${HOME}/code/other-project`;
export const OTHER_DATABASE = `${OTHER_PROJECT}/.crush/crush.db`;

/** Ids as Crush makes them. */
export const SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_SESSION_ID = "00000000-0000-4000-8000-000000000002";

/** The title Crush gave a session, or the first 50 characters of its first prompt. It must never leave the database. */
export const PRIVATE_TITLE = "placeholder words of a prompt";

/** Words written where a prompt, a reply, a tool's arguments, a setting or a secret goes. None may leave the database. */
export const PRIVATE_WORDS = "placeholder words that must never leave the database";

/** Seconds since the epoch, as Crush writes a time. */
export const seconds = (at: number) => Math.floor(at / SECOND);

/** A row as the question of the sessions prints it, for a session written a minute ago. */
export function printedRow(changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    created_at: seconds(NOW - HOUR),
    updated_at: seconds(NOW - MINUTE),
    ...changes,
  };
}

/** What `sqlite3 -json` prints for these rows: nothing at all for none. */
export function sqliteJson(rows: readonly Record<string, unknown>[]): string {
  return rows.length === 0 ? "" : `${JSON.stringify(rows)}\n`;
}

/** What the probe prints for a database laid out as Crush's, less any column named. */
export function probeJson(without: readonly string[] = []): string {
  const columns = [
    "id",
    "parent_session_id",
    "title",
    "message_count",
    "prompt_tokens",
    "completion_tokens",
    "cost",
    "updated_at",
    "created_at",
    "summary_message_id",
    "todos",
    "channel",
  ];
  return sqliteJson([
    { kind: "table", name: "sessions" },
    ...columns
      .filter((name) => !without.includes(name))
      .map((name) => ({ kind: "sessions", name })),
  ]);
}

/** One entry of the list, as Crush writes it for a project in these folders. */
export function projectEntry(folder: unknown): Record<string, unknown> {
  return {
    path: folder,
    data_dir: typeof folder === "string" ? `${folder}/.crush` : folder,
    last_accessed: "2026-10-01T11:00:00.000000000Z",
  };
}

/** The text of the list, as Crush writes it, with these folders, the newest first. */
export function projectListJson(folders: readonly unknown[] = [PROJECT]): string {
  return JSON.stringify({ projects: folders.map(projectEntry) }, null, 2);
}

/**
 * Crush's `sessions` table as its migrations make it at v0.99.0, and `messages`
 * without its `prism_*` columns, with the triggers `update_sessions_updated_at`
 * and `update_session_message_count_on_insert`. The other triggers, the indexes
 * and the other tables are left out, since nothing asks for them.
 */
export const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  prompt_tokens INTEGER NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  cost REAL NOT NULL DEFAULT 0.0 CHECK (cost >= 0.0),
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  summary_message_id TEXT,
  todos TEXT,
  channel TEXT
);
CREATE TRIGGER update_sessions_updated_at AFTER UPDATE ON sessions BEGIN
  UPDATE sessions SET updated_at = strftime('%s', 'now') WHERE id = new.id;
END;
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  parts TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  provider TEXT,
  is_summary_message INTEGER DEFAULT 0 NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
);
CREATE TRIGGER update_session_message_count_on_insert AFTER INSERT ON messages BEGIN
  UPDATE sessions SET message_count = message_count + 1 WHERE id = new.session_id;
END;
`;

/** Text as SQL, with its quotes doubled. */
const quoted = (value: string) => `'${value.replace(/'/g, "''")}'`;

export interface SessionFields {
  id?: string;
  /** The session this one is a subagent's run for. */
  parent?: string;
  title?: string;
  /** Whether the session has a message. A session with none is one whose prompt was never saved. */
  message?: boolean;
  /** As SQL, so a test can write a time of any kind. */
  createdAt?: string;
  updatedAt?: string;
}

/**
 * One session's row, as Crush writes it, with its secrets in every column that
 * holds any, and one message, so nothing is left out for want of a message.
 * `updated_at` is set last, since the message's trigger moves it to now.
 */
export function sessionSql(fields: SessionFields = {}): string {
  const {
    id = SESSION_ID,
    parent,
    title = PRIVATE_TITLE,
    message = true,
    createdAt = "strftime('%s', 'now') - 3600",
    updatedAt,
  } = fields;
  const secret = quoted(PRIVATE_WORDS);
  const insert = `
INSERT INTO sessions (id, parent_session_id, title, updated_at, created_at, todos, channel)
VALUES (${quoted(id)}, ${parent === undefined ? "NULL" : quoted(parent)}, ${quoted(title)},
  strftime('%s', 'now') - 60, ${createdAt}, ${secret}, ${secret});
`;
  const said = `
INSERT INTO messages (id, session_id, role, parts, created_at, updated_at, model, provider)
VALUES (${quoted(`message-${id}`)}, ${quoted(id)}, 'user',
  ${quoted(`[{"type":"text","data":{"text":"${PRIVATE_WORDS}"}}]`)},
  strftime('%s', 'now'), strftime('%s', 'now'), 'demo-model', 'demo-provider');
`;
  // Crush's trigger moves `updated_at` to now on any update of the row, so it is
  // dropped for a moment to write a time of the test's own.
  const backdated =
    updatedAt === undefined
      ? ""
      : `
DROP TRIGGER update_sessions_updated_at;
UPDATE sessions SET updated_at = ${updatedAt} WHERE id = ${quoted(id)};
CREATE TRIGGER update_sessions_updated_at AFTER UPDATE ON sessions BEGIN
  UPDATE sessions SET updated_at = strftime('%s', 'now') WHERE id = new.id;
END;
`;
  return `${insert}${message ? said : ""}${backdated}`;
}
