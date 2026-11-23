// Test fixtures only. Every id, time and word here is invented and generic.
// Kilo Code keeps OpenCode 1.x's tables, so the rows are written with the
// OpenCode fixture's builders, in Kilo Code's folder and file. `SCHEMA` follows
// the tables Kilo Code v7.8.27 makes (`packages/core/src/database/schema.gen.ts`):
// `session`, `message` and `part` with their columns, the indexes on them,
// those Kilo Code adds with `json_extract` among them, `session_message`, and
// four tables the adapter must never read, holding words that stand for
// secrets and for what was written. Nothing here is copied from a real machine
// or a real session. Product code never imports this file.

import {
  answerRow as opencodeAnswerRow,
  HOME,
  PRIVATE_WORDS,
  SECRET_WORDS,
  sqliteJson,
  text,
  type AnswerRow,
} from "@tests/fixtures/opencode/opencode";

export {
  assistantData,
  DAY,
  FOLDER,
  HOME,
  HOUR,
  lastTextJson,
  messageId,
  messageRow,
  MINUTE,
  NOW,
  partId,
  partRow,
  PRIVATE_WORDS,
  SECOND,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  sqliteJson,
  text,
  textData,
  toolData,
  userData,
} from "@tests/fixtures/opencode/opencode";

/** Where Kilo Code keeps its data when nothing names another folder. */
export const DATA_HOME = `${HOME}/.local/share/kilo`;

/** The database the adapter reads there. */
export const DATABASE = `${DATA_HOME}/kilo.db`;

/** The tables of Kilo Code v7.8.27 the adapter reads, with every column and index, and five beside them. */
export const SCHEMA = [
  `CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
    slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
    version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
    summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text,
    model text, time_created integer NOT NULL, time_updated integer NOT NULL,
    time_compacting integer, time_archived integer);`,
  `CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL,
    CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id)
      REFERENCES session(id) ON DELETE CASCADE);`,
  `CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
    CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id)
      REFERENCES message(id) ON DELETE CASCADE);`,
  `CREATE TABLE session_message (
    id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`,
  "CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);",
  `CREATE INDEX recall_message_role_idx ON message (id,json_extract("data", '$.role'),coalesce(json_extract("data", '$.parentID'), ''));`,
  "CREATE INDEX part_message_id_id_idx ON part (message_id, id);",
  "CREATE INDEX part_session_idx ON part (session_id);",
  `CREATE INDEX part_session_step_finish_idx ON part (session_id) WHERE json_valid("part"."data") AND json_extract("part"."data", '$.type') = 'step-finish';`,
  // As Kilo Code writes it, on one line.
  `CREATE INDEX recall_part_search_idx ON part (session_id,id,message_id,json_extract("data", '$.type'),CASE WHEN json_extract("data", '$.type') = 'text' THEN coalesce(json_extract("data", '$.text'), '') WHEN json_extract("data", '$.type') = 'file' THEN trim(coalesce(json_extract("data", '$.filename'), '') || ' ' || CASE WHEN coalesce(json_extract("data", '$.url'), '') NOT LIKE 'data:%' THEN coalesce(json_extract("data", '$.url'), '') ELSE '' END || ' ' || coalesce(json_extract("data", '$.source.path'), '') || ' ' || coalesce(json_extract("data", '$.source.name'), '') || ' ' || CASE WHEN coalesce(json_extract("data", '$.source.uri'), '') NOT LIKE 'data:%' THEN coalesce(json_extract("data", '$.source.uri'), '') ELSE '' END || ' ' || coalesce(json_extract("data", '$.source.clientName'), '')) ELSE coalesce(json_extract("data", '$.state.error'), '') END) WHERE json_valid("part"."data") AND ((json_extract("part"."data", '$.type') = 'text' AND coalesce(json_extract("part"."data", '$.synthetic'), 0) = 0 AND coalesce(json_extract("part"."data", '$.ignored'), 0) = 0) OR json_extract("part"."data", '$.type') = 'file' OR (json_extract("part"."data", '$.type') = 'tool' AND json_extract("part"."data", '$.state.status') = 'error'));`,
  "CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);",
  "CREATE INDEX session_project_idx ON session (project_id);",
  "CREATE INDEX session_workspace_idx ON session (workspace_id);",
  "CREATE INDEX session_parent_idx ON session (parent_id);",
  `CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    time_created integer NOT NULL, time_updated integer NOT NULL);`,
  `CREATE TABLE control_account (email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    active integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    CONSTRAINT control_account_pk PRIMARY KEY(email, url));`,
  `CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL,
    value text NOT NULL, connector_id text, method_id text, active integer,
    time_created integer NOT NULL, time_updated integer NOT NULL);`,
  `CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL,
    type text NOT NULL, data text NOT NULL);`,
  `INSERT INTO account VALUES ('acc_1', 'demo@example.com', 'https://example.com', ${text(SECRET_WORDS)}, ${text(SECRET_WORDS)}, NULL, 0, 0);`,
  `INSERT INTO control_account VALUES ('demo@example.com', 'https://example.com', ${text(SECRET_WORDS)}, ${text(SECRET_WORDS)}, NULL, 1, 0, 0);`,
  `INSERT INTO credential VALUES ('crd_1', NULL, 'demo', ${text(JSON.stringify({ key: SECRET_WORDS }))}, NULL, NULL, 1, 0, 0);`,
  `INSERT INTO event VALUES ('evt_1', 'ses_1', 1, 'message.updated', ${text(JSON.stringify({ text: PRIVATE_WORDS }))});`,
  `INSERT INTO session_message VALUES ('msg_v1', 'ses_1', 'assistant', 1, 0, 0, ${text(JSON.stringify({ text: PRIVATE_WORDS }))});`,
].join("\n");

/** What the probe prints for Kilo Code's tables: OpenCode 1.x's, with `session_message`, and `session_v2` when `withV2`. */
export function probeJson(withV2 = false): string {
  const rows: Record<string, unknown>[] = ["session", "message", "part", "session_message"].map(
    (name) => ({ kind: "table", name }),
  );
  if (withV2) rows.push({ kind: "table", name: "session_v2" });
  for (const name of [
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
  ]) {
    rows.push({ kind: "session", name });
  }
  if (withV2) {
    for (const name of ["id", "parent_id", "slug", "directory", "title", "time_created"]) {
      rows.push({ kind: "session_v2", name });
    }
  }
  return sqliteJson(rows);
}

/**
 * A row of the answer to Kilo Code's sessions query, for a session whose
 * newest step ended the turn a minute before `NOW`, with no token counts and
 * no call left that leaves it idle (`m_idle_call` 0).
 */
export function answerRow(fields: AnswerRow & { m_idle_call?: unknown }): Record<string, unknown> {
  return opencodeAnswerRow({ m_idle_call: 0, ...fields } as AnswerRow);
}
