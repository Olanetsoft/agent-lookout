// Test fixtures only. Every id, time and word here is invented and generic.
// MiMo Code keeps OpenCode 1.x's tables, so the messages and parts are written
// with the OpenCode fixture's builders, in MiMo Code's folder and file.
// `SCHEMA` follows the tables MiMo Code v0.1.17 makes for what the adapter
// reads (`packages/cli/src/session/session.sql.ts`,
// `packages/cli/src/actor/actor.sql.ts`): `session`, `message` with its
// `agent_id`, `part` and `actor_registry`, with their columns and indexes.
// Beside them are four tables the adapter must never read, written as
// stand-ins, holding words that stand for secrets and for what was written.
// Nothing here is copied from a real machine or a real session. Product code
// never imports this file.

import {
  answerRow as opencodeAnswerRow,
  FOLDER,
  HOME,
  HOUR,
  NOW,
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
  messageId,
  MINUTE,
  NOW,
  partId,
  partRow,
  PRIVATE_WORDS,
  SECOND,
  SECRET_WORDS,
  sessionId,
  sqliteJson,
  textData,
  toolData,
  userData,
} from "@tests/fixtures/opencode/opencode";

/** Where MiMo Code keeps its data when nothing names another folder. */
export const DATA_HOME = `${HOME}/.local/share/mimocode`;

/** The database the adapter reads there. */
export const DATABASE = `${DATA_HOME}/mimocode.db`;

/** The tables of MiMo Code v0.1.17 the adapter reads, with every column and index, and four stand-ins beside them. */
export const SCHEMA = [
  `CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
    context_from text, context_watermark text, slug text NOT NULL, directory text NOT NULL,
    title text NOT NULL, title_source text DEFAULT 'user' NOT NULL,
    title_revision integer DEFAULT 0 NOT NULL, version text NOT NULL,
    summary_additions integer, summary_deletions integer, summary_files integer,
    summary_diffs text, revert text, permission text, prompt text,
    time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer,
    time_archived integer, last_checkpoint_message_id text, auto_worktree_hint_sent integer);`,
  "CREATE INDEX session_project_idx ON session (project_id);",
  "CREATE INDEX session_workspace_idx ON session (workspace_id);",
  "CREATE INDEX session_parent_idx ON session (parent_id);",
  "CREATE INDEX session_context_from_idx ON session (context_from);",
  `CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    agent_id text DEFAULT 'main' NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL);`,
  "CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id);",
  "CREATE INDEX message_session_agent_idx ON message (session_id, agent_id, id);",
  `CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL REFERENCES message(id) ON DELETE CASCADE,
    session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    data text NOT NULL);`,
  "CREATE INDEX part_message_id_id_idx ON part (message_id, id);",
  "CREATE INDEX part_session_idx ON part (session_id);",
  `CREATE TABLE actor_registry (
    session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE, actor_id text NOT NULL,
    mode text NOT NULL, parent_actor_id text, status text NOT NULL, last_outcome text,
    result_message_id text, lifecycle text NOT NULL, agent text NOT NULL,
    description text NOT NULL, context_mode text NOT NULL, context_watermark text,
    background integer NOT NULL, tools text, last_turn_time integer NOT NULL,
    turn_count integer DEFAULT 0 NOT NULL, last_activity_time integer, last_error text,
    instance_id text NOT NULL, time_completed integer, time_created integer NOT NULL,
    time_updated integer NOT NULL, PRIMARY KEY (session_id, actor_id));`,
  "CREATE INDEX actor_registry_session_agent_idx ON actor_registry (session_id, agent);",
  "CREATE INDEX actor_registry_session_parent_idx ON actor_registry (session_id, parent_actor_id);",
  "CREATE INDEX actor_registry_status_idx ON actor_registry (status);",
  "CREATE INDEX actor_registry_status_last_turn_idx ON actor_registry (status, last_turn_time);",
  `CREATE TABLE permission (project_id text PRIMARY KEY, data text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL);`,
  `CREATE TABLE todo (session_id text NOT NULL, content text NOT NULL, status text NOT NULL,
    priority text NOT NULL, position integer NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, PRIMARY KEY (session_id, position));`,
  `CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    time_created integer NOT NULL, time_updated integer NOT NULL);`,
  `CREATE TABLE control_account (email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL, token_expiry integer,
    active integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL,
    PRIMARY KEY (email, url));`,
  `INSERT INTO permission VALUES ('demo-project-id', ${text(JSON.stringify([{ pattern: PRIVATE_WORDS }]))}, 0, 0);`,
  `INSERT INTO todo VALUES ('ses_1', ${text(PRIVATE_WORDS)}, 'pending', 'high', 0, 0, 0);`,
  `INSERT INTO account VALUES ('acc_1', 'demo@example.com', 'https://example.com', ${text(SECRET_WORDS)}, ${text(SECRET_WORDS)}, NULL, 0, 0);`,
  `INSERT INTO control_account VALUES ('demo@example.com', 'https://example.com', ${text(SECRET_WORDS)}, ${text(SECRET_WORDS)}, NULL, 1, 0, 0);`,
].join("\n");

/** A value as SQL writes one: a text, a number, or NULL. */
function value(given: string | number | null | undefined): string {
  if (given === null || given === undefined) return "NULL";
  return typeof given === "number" ? String(given) : text(given);
}

export interface MimoSessionFields {
  id: string;
  title?: string;
  /** `title_source`: `fallback` while the title is the first line of the prompt, `generated` once a model wrote it, `user` for one given as the session was made or forked, or a rename. Left out, `generated`. */
  titleSource?: string;
  /** `title_revision`: 0 as the session is made, and 1 more on each write of its title. Left out, 1. */
  titleRevision?: number;
  directory?: string;
  createdAt?: number;
  updatedAt?: number;
  parentId?: string;
  archivedAt?: number;
}

/** A session's row, with words that stand for what was written in every column the adapter must not read. */
export function sessionRow(fields: MimoSessionFields): string {
  const createdAt = fields.createdAt ?? NOW - HOUR;
  const columns = {
    id: fields.id,
    project_id: "demo-project-id",
    parent_id: fields.parentId,
    slug: "demo-slug",
    directory: fields.directory ?? FOLDER,
    title: fields.title ?? "Rename the helper",
    title_source: fields.titleSource ?? "generated",
    title_revision: fields.titleRevision ?? 1,
    version: "0.1.17",
    summary_diffs: JSON.stringify([{ file: PRIVATE_WORDS }]),
    revert: JSON.stringify({ messageID: PRIVATE_WORDS }),
    permission: JSON.stringify([{ pattern: PRIVATE_WORDS }]),
    prompt: JSON.stringify({ text: PRIVATE_WORDS }),
    time_created: createdAt,
    time_updated: fields.updatedAt ?? createdAt,
    time_archived: fields.archivedAt,
  };
  const names = Object.keys(columns).join(", ");
  const values = Object.values(columns).map(value).join(", ");
  return `INSERT INTO session (${names}) VALUES (${values});`;
}

export interface MimoMessageFields {
  id: string;
  sessionId: string;
  createdAt: number;
  updatedAt?: number;
  /** `agent_id`: the actor that wrote it. Left out, the column's default, `main`. */
  agentId?: string;
  /** The whole `data`, as MiMo Code writes it. */
  data: Record<string, unknown>;
}

/** A message's row. */
export function messageRow(fields: MimoMessageFields): string {
  const updatedAt = fields.updatedAt ?? fields.createdAt;
  const agent = fields.agentId === undefined ? "" : ", agent_id";
  const agentValue = fields.agentId === undefined ? "" : `, ${text(fields.agentId)}`;
  return `INSERT INTO message (id, session_id${agent}, time_created, time_updated, data) VALUES (${text(fields.id)}, ${text(fields.sessionId)}${agentValue}, ${fields.createdAt}, ${updatedAt}, ${text(JSON.stringify(fields.data))});`;
}

export interface ActorFields {
  sessionId: string;
  actorId: string;
  /** `mode`: `subagent`, or `main` for the row MiMo Code makes for the main agent of each session. Left out, `subagent`. */
  mode?: "subagent" | "main";
  status: "pending" | "running" | "idle";
  updatedAt: number;
  /** When the subagent last wrote a part. Left out, null, as before it has. */
  lastActivityAt?: number;
}

/** An actor's row of `actor_registry`, with words that stand for what was written in every column the adapter must not read. */
export function actorRow(fields: ActorFields): string {
  const main = fields.mode === "main";
  const columns = {
    session_id: fields.sessionId,
    actor_id: fields.actorId,
    mode: fields.mode ?? "subagent",
    parent_actor_id: main ? null : "main",
    status: fields.status,
    last_outcome: fields.status === "idle" ? "success" : null,
    lifecycle: main ? "persistent" : "ephemeral",
    agent: main ? "build" : "explore",
    description: PRIVATE_WORDS,
    context_mode: "none",
    background: 1,
    tools: JSON.stringify(["read"]),
    last_turn_time: fields.updatedAt,
    turn_count: 1,
    last_activity_time: fields.lastActivityAt,
    last_error: fields.status === "idle" ? null : PRIVATE_WORDS,
    instance_id: "demo-instance",
    time_completed: fields.status === "idle" ? fields.updatedAt : null,
    time_created: fields.updatedAt,
    time_updated: fields.updatedAt,
  };
  const names = Object.keys(columns).join(", ");
  const values = Object.values(columns).map(value).join(", ");
  return `INSERT INTO actor_registry (${names}) VALUES (${values});`;
}

/**
 * The main agent's row of `actor_registry`, which MiMo Code makes `pending`
 * with each session and its turns leave so, with its times at `at`, the
 * newest write of the main agent's.
 */
export function mainActorRow(sessionId: string, at: number): string {
  return actorRow({
    sessionId,
    actorId: "main",
    mode: "main",
    status: "pending",
    updatedAt: at,
    lastActivityAt: at,
  });
}

/** Columns of `session` MiMo Code v0.1.17 makes, as the probe prints them, the ones asked for among them. */
const SESSION_COLUMNS = [
  "id",
  "project_id",
  "workspace_id",
  "parent_id",
  "context_from",
  "context_watermark",
  "slug",
  "directory",
  "title",
  "title_source",
  "title_revision",
  "version",
  "time_created",
  "time_updated",
  "time_compacting",
  "time_archived",
];

/** What a probe of a database of MiMo Code's can be made to lack, to stand for an older or a newer one. */
export interface ProbeOptions {
  /** With OpenCode 2's `session_v2` beside the tables. */
  withV2?: boolean;
  /** Without `actor_registry`. */
  noActors?: boolean;
  /** Without `message.agent_id`. */
  noAgentId?: boolean;
  /** Without `session.title_source`. */
  noTitleSource?: boolean;
  /** Without `session.title_revision`. */
  noTitleRevision?: boolean;
}

/** What the probe prints for MiMo Code's tables: OpenCode 1.x's, `actor_registry`, and the columns asked of them. */
export function probeJson(options: ProbeOptions = {}): string {
  const tables = ["session", "message", "part", ...(options.noActors ? [] : ["actor_registry"])];
  const rows: Record<string, unknown>[] = tables.map((name) => ({ kind: "table", name }));
  if (options.withV2) rows.push({ kind: "table", name: "session_v2" });
  for (const name of SESSION_COLUMNS) {
    if (name === "title_source" && options.noTitleSource) continue;
    if (name === "title_revision" && options.noTitleRevision) continue;
    rows.push({ kind: "session", name });
  }
  for (const name of ["id", "session_id", "agent_id", "time_created", "time_updated", "data"]) {
    if (name === "agent_id" && options.noAgentId) continue;
    rows.push({ kind: "message", name });
  }
  if (!options.noActors) {
    for (const name of [
      "session_id",
      "actor_id",
      "mode",
      "status",
      "last_activity_time",
      "instance_id",
      "time_created",
      "time_updated",
    ]) {
      rows.push({ kind: "actor_registry", name });
    }
  }
  return sqliteJson(rows);
}

/**
 * A row of the answer to MiMo Code's sessions query, for a session whose main
 * agent's newest step ended the turn a minute before `NOW`, with no token
 * counts and no subagent at work (`a_active_at` null).
 */
export function answerRow(fields: AnswerRow & { a_active_at?: unknown }): Record<string, unknown> {
  return opencodeAnswerRow({ a_active_at: null, ...fields } as AnswerRow);
}
