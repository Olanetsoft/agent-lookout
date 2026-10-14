// Test fixtures only. Every id, time and word here is invented and generic.
// The tables follow the columns OpenCode 1.19.0's source gives `session`,
// `message` and `part` (`packages/core/src/session/sql.ts`), and the messages
// and parts the JSON shapes it writes into their `data`, as written up in
// docs/adapters/opencode.md. Beside them are three tables the adapter must
// never read, holding words that stand for secrets and for what was written.
// Nothing here is copied from a real machine or a real session. Product code
// never imports this file.

export const HOME = "/Users/example";

/** Where OpenCode keeps its data when nothing names another folder. */
export const DATA_HOME = `${HOME}/.local/share/opencode`;

/** The database the adapter reads there. */
export const DATABASE = `${DATA_HOME}/opencode.db`;

/** The folder the sessions work in. */
export const FOLDER = `${HOME}/code/demo`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A generic id of OpenCode's shape: a prefix, `_`, 12 hex characters and 14 more, ending in these. */
const idOf = (prefix: string, suffix: string) =>
  `${prefix}_000000000000${suffix.padStart(14, "0")}`;

/** A session's id, ending in these characters: `ses_` and 26 more. */
export const sessionId = (suffix: string) => idOf("ses", suffix);
export const messageId = (suffix: string) => idOf("msg", suffix);
export const partId = (suffix: string) => idOf("prt", suffix);

/** Words that stand for what a person or the model wrote, which the adapter must never keep. */
export const PRIVATE_WORDS = "rename the helper in demo-project and keep the old name";

/** Words that stand for a secret, which the adapter must never read. */
export const SECRET_WORDS = "demo-secret-value-that-must-stay-put";

/** The tables of OpenCode 1.19.0 the adapter reads, with every column, and three it must never read. */
export const SCHEMA = [
  `CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL,
    version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER,
    summary_files INTEGER, summary_diffs TEXT, metadata TEXT, cost REAL NOT NULL DEFAULT 0,
    tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0,
    tokens_cache_write INTEGER NOT NULL DEFAULT 0, revert TEXT, permission TEXT, agent TEXT,
    model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_compacting INTEGER, time_archived INTEGER);`,
  "CREATE INDEX session_parent_idx ON session (parent_id);",
  `CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`,
  "CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);",
  `CREATE TABLE part (
    id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL);`,
  "CREATE INDEX part_message_id_id_idx ON part (message_id, id);",
  "CREATE INDEX part_session_idx ON part (session_id);",
  `CREATE TABLE event (id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
    type TEXT NOT NULL, data TEXT NOT NULL);`,
  `CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL,
    value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);`,
  `CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL,
    access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);`,
  `INSERT INTO event VALUES ('evt_1', 'ses_1', 1, 'message.updated', ${text(JSON.stringify({ text: PRIVATE_WORDS }))});`,
  `INSERT INTO credential VALUES ('crd_1', NULL, 'demo', ${text(JSON.stringify({ key: SECRET_WORDS }))}, NULL, NULL, 1, 0, 0);`,
  `INSERT INTO account VALUES ('acc_1', 'demo@example.com', 'https://example.com', ${text(SECRET_WORDS)}, ${text(SECRET_WORDS)}, NULL, 0, 0);`,
].join("\n");

/** A text as SQL writes one. */
export function text(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A value as SQL writes one: a text, a number, or NULL. */
function value(given: string | number | null | undefined): string {
  if (given === null || given === undefined) return "NULL";
  return typeof given === "number" ? String(given) : text(given);
}

export interface SessionFields {
  id: string;
  title?: string;
  directory?: string;
  createdAt?: number;
  updatedAt?: number;
  parentId?: string;
  archivedAt?: number;
}

/** A session's row, with words that stand for what was written in every column the adapter must not read. */
export function sessionRow(fields: SessionFields): string {
  const createdAt = fields.createdAt ?? NOW - HOUR;
  const columns = {
    id: fields.id,
    project_id: "demo-project-id",
    parent_id: fields.parentId,
    slug: "demo-slug",
    directory: fields.directory ?? FOLDER,
    title: fields.title ?? "Rename the helper",
    version: "1.19.0",
    share_url: `https://example.com/share/${PRIVATE_WORDS}`,
    summary_diffs: JSON.stringify([{ file: PRIVATE_WORDS }]),
    metadata: JSON.stringify({ note: PRIVATE_WORDS }),
    revert: JSON.stringify({ messageID: PRIVATE_WORDS }),
    permission: JSON.stringify([{ pattern: PRIVATE_WORDS }]),
    agent: "build",
    model: JSON.stringify({ id: "demo-model", providerID: "demo-provider" }),
    time_created: createdAt,
    time_updated: fields.updatedAt ?? createdAt,
    time_archived: fields.archivedAt,
  };
  const names = Object.keys(columns).join(", ");
  const values = Object.values(columns).map(value).join(", ");
  return `INSERT INTO session (${names}) VALUES (${values});`;
}

export interface MessageFields {
  id: string;
  sessionId: string;
  createdAt: number;
  updatedAt?: number;
  /** The whole `data`, as OpenCode writes it. */
  data: Record<string, unknown>;
}

/** A message's row. */
export function messageRow(fields: MessageFields): string {
  const updatedAt = fields.updatedAt ?? fields.createdAt;
  return `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${text(fields.id)}, ${text(fields.sessionId)}, ${fields.createdAt}, ${updatedAt}, ${text(JSON.stringify(fields.data))});`;
}

/** What the person wrote: a user message's `data`. */
export function userData(createdAt: number): Record<string, unknown> {
  return {
    role: "user",
    time: { created: createdAt },
    agent: "build",
    model: { providerID: "demo-provider", modelID: "demo-model" },
    system: PRIVATE_WORDS,
  };
}

export interface AssistantFields {
  createdAt: number;
  completedAt?: number;
  /** The name of the error it ended on. */
  error?: string;
  finish?: string;
  parentId?: string;
}

/** A step of a reply: an assistant message's `data`. */
export function assistantData(fields: AssistantFields): Record<string, unknown> {
  const data: Record<string, unknown> = {
    role: "assistant",
    time: {
      created: fields.createdAt,
      ...(fields.completedAt === undefined ? {} : { completed: fields.completedAt }),
    },
    parentID: fields.parentId ?? messageId("u1"),
    modelID: "demo-model",
    providerID: "demo-provider",
    mode: "build",
    agent: "build",
    path: { cwd: FOLDER, root: FOLDER },
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    structured: { note: PRIVATE_WORDS },
  };
  if (fields.error !== undefined)
    data.error = { name: fields.error, data: { message: PRIVATE_WORDS } };
  if (fields.finish !== undefined) data.finish = fields.finish;
  return data;
}

export interface PartFields {
  id: string;
  messageId: string;
  sessionId: string;
  createdAt: number;
  updatedAt?: number;
  data: Record<string, unknown>;
}

/** A part's row. */
export function partRow(fields: PartFields): string {
  const updatedAt = fields.updatedAt ?? fields.createdAt;
  return `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${text(fields.id)}, ${text(fields.messageId)}, ${text(fields.sessionId)}, ${fields.createdAt}, ${updatedAt}, ${text(JSON.stringify(fields.data))});`;
}

/** A text part: what was written. */
export function textData(): Record<string, unknown> {
  return { type: "text", text: PRIVATE_WORDS, time: { start: NOW - MINUTE } };
}

export interface ToolFields {
  status: "pending" | "running" | "completed" | "error";
  tool?: string;
  /** Run by the model's provider itself, which OpenCode does not wait on. */
  providerExecuted?: boolean;
  /** Marked as cut off when OpenCode cleaned up a step. */
  interrupted?: boolean;
}

/** A tool part, with what it was given and what it said in every field the adapter must not read. */
export function toolData(fields: ToolFields): Record<string, unknown> {
  const state: Record<string, unknown> = {
    status: fields.status,
    input: { command: PRIVATE_WORDS },
    time: { start: NOW - MINUTE },
  };
  if (fields.status === "completed") state.output = PRIVATE_WORDS;
  if (fields.status === "error") state.error = PRIVATE_WORDS;
  if (fields.interrupted) state.metadata = { interrupted: true };
  return {
    type: "tool",
    callID: "demo-call",
    tool: fields.tool ?? "bash",
    state,
    ...(fields.providerExecuted ? { metadata: { providerExecuted: true } } : {}),
  };
}

/** What `sqlite3 -json` prints for these rows: nothing for none, one row a line otherwise. */
export function sqliteJson(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  return `[${rows.map((row) => JSON.stringify(row)).join(",\n")}]\n`;
}

/** What the probe prints for OpenCode 1.19.0's tables, with `session_v2` beside them or alone. */
export function probeJson(layout: "v1" | "v1+v2" | "v2-only" | "none" = "v1"): string {
  const sessionColumns = [
    "id",
    "project_id",
    "workspace_id",
    "parent_id",
    "slug",
    "directory",
    "path",
    "title",
    "version",
    "time_created",
    "time_updated",
    "time_compacting",
    "time_archived",
  ];
  const v2Columns = ["id", "directory", "title", "time_created", "time_updated", "time_suspended"];
  const rows: Record<string, unknown>[] = [];
  if (layout === "v1" || layout === "v1+v2") {
    for (const name of ["session", "message", "part"]) rows.push({ kind: "table", name });
  }
  if (layout === "v1+v2" || layout === "v2-only") {
    rows.push({ kind: "table", name: "session_v2" }, { kind: "table", name: "session_message" });
  }
  if (layout === "v1" || layout === "v1+v2") {
    for (const name of sessionColumns) rows.push({ kind: "session", name });
  }
  if (layout === "v1+v2" || layout === "v2-only") {
    for (const name of v2Columns) rows.push({ kind: "session_v2", name });
  }
  return sqliteJson(rows);
}

/** One row of the answer to the sessions query, as `sqlite3 -json` prints it. */
export interface AnswerRow {
  id: string;
  directory?: unknown;
  title?: unknown;
  time_created?: unknown;
  time_updated?: unknown;
  m_id?: unknown;
  m_created?: unknown;
  m_updated?: unknown;
  m_role?: unknown;
  m_completed?: unknown;
  m_error?: unknown;
  m_finish?: unknown;
  m_tools?: unknown;
  p_updated?: unknown;
  u_created?: unknown;
}

/** A row of the answer for a session whose newest step ended the turn a minute before `NOW`. */
export function answerRow(fields: AnswerRow): Record<string, unknown> {
  return {
    directory: FOLDER,
    title: "Rename the helper",
    time_created: NOW - HOUR,
    time_updated: NOW - MINUTE,
    m_id: messageId("a1"),
    m_created: NOW - 2 * MINUTE,
    m_updated: NOW - MINUTE,
    m_role: "assistant",
    m_completed: NOW - MINUTE,
    m_error: null,
    m_finish: "stop",
    m_tools: 0,
    p_updated: NOW - MINUTE,
    u_created: NOW - 3 * MINUTE,
    ...fields,
  };
}
