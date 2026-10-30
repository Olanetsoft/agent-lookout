// Test fixtures only. Every id, time, folder and word here is invented and
// generic. The tables follow the columns Hermes Agent v0.22.5's source gives
// `sessions`, `messages` and `session_turn_leases` (`SCHEMA_SQL` in
// `hermes_state_common.py`), and the rows follow the shapes that source
// writes, as written up in docs/adapters/hermes-agent.md. Beside them are
// tables the adapter must never read, holding words that stand for secrets
// and for what was written. Nothing here is copied from a real machine or a
// real session, and nothing was read from a computer running Hermes Agent.
// Product code never imports this file.

export const HOME = "/Users/example";

/** Hermes Agent's root folder, when nothing names another. */
export const ROOT = `${HOME}/.hermes`;

/** A named profile, in `profiles/` in the root. */
export const PROFILE = "coder";

/** The default profile's database, in the root itself. */
export const DEFAULT_DATABASE = `${ROOT}/state.db`;

/** The named profile's database. */
export const PROFILE_DATABASE = `${ROOT}/profiles/${PROFILE}/state.db`;

/** The folder the sessions work in. */
export const FOLDER = `${HOME}/code/demo`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The process a turn lease's holder names: Hermes Agent's gateway. */
export const GATEWAY_PID = 41_001;

/** The pid namespace a holder names on Linux, as `/proc/self/ns/pid` links to it: `pid:[4026531836]`. */
export const PID_NAMESPACE = 4_026_531_836;

/** A session id of the shape Hermes Agent mints, a time and six hex characters, ending in these. */
export const sessionId = (suffix: string) => `20261001_110000_${suffix.padStart(6, "0")}`;

/** Words that stand for what a person or the model wrote, which the adapter must never keep. */
export const PRIVATE_WORDS = "demo-private-words-from-a-prompt";

/** Words that stand for a secret, which the adapter must never read. */
export const SECRET_WORDS = "demo-secret-value-that-must-stay-put";

/** A text as SQL writes one. */
export function text(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A value as SQL writes one: a text, a number, or NULL. */
function value(given: string | number | null | undefined): string {
  if (given === null || given === undefined) return "NULL";
  return typeof given === "number" ? String(given) : text(given);
}

/** A time in milliseconds as Hermes Agent writes it: REAL seconds. */
export const seconds = (ms: number) => ms / 1000;

/**
 * The tables of Hermes Agent v0.22.5 the adapter reads, with every column,
 * and five it must never read, with words that stand for secrets in them.
 * Hermes Agent's `messages_fts` is an FTS5 table over `content`; a plain table
 * of the same name and column stands in for it, so any sqlite3 can build this.
 */
export const SCHEMA = [
  "CREATE TABLE system_prompts (hash TEXT PRIMARY KEY, prompt TEXT NOT NULL);",
  `CREATE TABLE sessions (
    id TEXT PRIMARY KEY, runtime_revision INTEGER NOT NULL DEFAULT 0,
    runtime_generation INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, created_source TEXT,
    user_id TEXT, session_key TEXT, chat_id TEXT, chat_type TEXT, thread_id TEXT,
    display_name TEXT, origin_json TEXT, expiry_finalized INTEGER DEFAULT 0, model TEXT,
    model_config TEXT, system_prompt TEXT, system_prompt_hash TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, cwd TEXT,
    git_branch TEXT, git_repo_root TEXT, git_metadata_generation INTEGER NOT NULL DEFAULT 0,
    billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT, estimated_cost_usd REAL,
    actual_cost_usd REAL, cost_status TEXT, cost_source TEXT, pricing_version TEXT, title TEXT,
    title_source TEXT, last_activity_at REAL, last_activity_description TEXT,
    last_activity_provenance TEXT, api_call_count INTEGER DEFAULT 0, handoff_state TEXT,
    handoff_platform TEXT, handoff_error TEXT, compression_failure_cooldown_until REAL,
    compression_failure_error TEXT, compression_fallback_streak INTEGER NOT NULL DEFAULT 0,
    compression_ineffective_count INTEGER NOT NULL DEFAULT 0, compression_recovery_deadline REAL,
    compression_overload_streak INTEGER NOT NULL DEFAULT 0, profile_name TEXT,
    transport_profile TEXT, rewind_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, auto_archived INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, last_read_at REAL,
    tool_names TEXT, transcript_revision INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id),
    FOREIGN KEY (system_prompt_hash) REFERENCES system_prompts(hash));`,
  `CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    effect_disposition TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT,
    reasoning TEXT, reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
    codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
    _compressed_summary INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    compacted INTEGER NOT NULL DEFAULT 0, api_content TEXT, display_kind TEXT,
    display_metadata TEXT, display_identity BLOB, display_order INTEGER, message_uid TEXT,
    absorbed_message_uids TEXT, tool_call_uids TEXT, tool_call_uid TEXT);`,
  `CREATE TABLE session_turn_leases (
    conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL,
    expires_at REAL NOT NULL);`,
  `CREATE TABLE session_admissions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, admission_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL, principal_id TEXT NOT NULL, target_session_id TEXT NOT NULL,
    lineage_json TEXT NOT NULL, payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL,
    intent TEXT NOT NULL, status TEXT NOT NULL, outcome TEXT, owner_epoch INTEGER,
    generation INTEGER);`,
  `CREATE TABLE gateway_routing (
    scope TEXT NOT NULL DEFAULT '', session_key TEXT NOT NULL, entry_json TEXT NOT NULL,
    updated_at REAL NOT NULL, PRIMARY KEY (scope, session_key));`,
  "CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);",
  "CREATE TABLE messages_fts (content TEXT);",
  `INSERT INTO system_prompts VALUES ('demo-hash', ${text(`${PRIVATE_WORDS} ${SECRET_WORDS}`)});`,
  `INSERT INTO session_admissions (admission_id, request_id, principal_id, target_session_id, lineage_json, payload_json, payload_digest, intent, status) VALUES ('demo-admission', 'demo-request', 'demo-principal', ${text(sessionId("a1"))}, ${text(JSON.stringify({ chat: SECRET_WORDS }))}, ${text(JSON.stringify({ text: PRIVATE_WORDS }))}, 'demo-digest', 'queue', 'queued');`,
  `INSERT INTO gateway_routing VALUES ('', 'agent:main:telegram:dm:1', ${text(JSON.stringify({ chat_name: SECRET_WORDS }))}, 0);`,
  `INSERT INTO state_meta VALUES ('demo-receipt', ${text(SECRET_WORDS)});`,
  `INSERT INTO messages_fts VALUES (${text(PRIVATE_WORDS)});`,
].join("\n");

/** A marker Hermes Agent keeps in a row's `model_config`, naming the row it came from. */
export type Marker = "_branched_from" | "_delegate_from" | "_reset_from";

export interface SessionFields {
  id: string;
  /** Defaults to `local`, as Hermes Agent's gateway keeps a terminal's session. */
  source?: string;
  /** Defaults to `cli` for a `local` row, and none for any other. */
  createdSource?: string | null;
  parentId?: string;
  /** Times in milliseconds. Defaults to an hour before `NOW`. */
  startedAt?: number;
  endedAt?: number;
  endReason?: string;
  /** Defaults to `FOLDER`. */
  cwd?: string | null;
  /** Defaults to `Rename the helper`. */
  title?: string | null;
  /** A marker kept in `model_config`, naming `markerOf`, else `parentId`. */
  marker?: Marker;
  markerOf?: string;
  sessionKey?: string;
  archived?: boolean;
  hidden?: boolean;
  lastActivityAt?: number;
  /** `last_activity_description`, the activity label. */
  label?: string;
}

/**
 * A row of `sessions`, with words that stand for what was written, and for a
 * chat's or person's identity, in every column the adapter must not read.
 */
export function sessionRow(fields: SessionFields): string {
  const source = fields.source ?? "local";
  const config: Record<string, unknown> = { note: PRIVATE_WORDS, yolo_mode: false };
  if (fields.marker !== undefined)
    config[fields.marker] = fields.markerOf ?? fields.parentId ?? null;
  const columns: Record<string, string | number | null | undefined> = {
    id: fields.id,
    source,
    created_source:
      fields.createdSource === undefined
        ? source === "local"
          ? "cli"
          : null
        : fields.createdSource,
    user_id: SECRET_WORDS,
    session_key: fields.sessionKey,
    chat_id: SECRET_WORDS,
    chat_type: "dm",
    thread_id: SECRET_WORDS,
    display_name: SECRET_WORDS,
    origin_json: JSON.stringify({ user_name: SECRET_WORDS, text: PRIVATE_WORDS }),
    model: "demo-model",
    model_config: JSON.stringify(config),
    system_prompt: PRIVATE_WORDS,
    system_prompt_hash: "demo-hash",
    parent_session_id: fields.parentId,
    started_at: seconds(fields.startedAt ?? NOW - HOUR),
    ended_at: fields.endedAt === undefined ? null : seconds(fields.endedAt),
    end_reason: fields.endReason,
    cwd: fields.cwd === undefined ? FOLDER : fields.cwd,
    git_branch: PRIVATE_WORDS,
    billing_base_url: `https://example.com/${SECRET_WORDS}`,
    title: fields.title === undefined ? "Rename the helper" : fields.title,
    title_source: "model",
    last_activity_at: fields.lastActivityAt === undefined ? null : seconds(fields.lastActivityAt),
    last_activity_description: fields.label,
    last_activity_provenance: PRIVATE_WORDS,
    handoff_error: PRIVATE_WORDS,
    compression_failure_error: PRIVATE_WORDS,
    tool_names: PRIVATE_WORDS,
    archived: fields.archived ? 1 : 0,
    hidden: fields.hidden ? 1 : 0,
  };
  const names = Object.keys(columns).join(", ");
  const values = Object.values(columns).map(value).join(", ");
  return `INSERT INTO sessions (${names}) VALUES (${values});`;
}

/** One tool call, as Hermes Agent keeps it in `tool_calls`: what it was given stands for private words. */
export interface ToolCall {
  id: string;
  name: string;
}

export interface MessageFields {
  sessionId: string;
  /** `user`, `assistant`, `tool`, `system` or `session_meta`. */
  role: string;
  /** When it was written, in milliseconds. */
  at: number;
  /** The tool calls of an assistant row. */
  toolCalls?: ToolCall[];
  /** For a tool row: the call it answers. */
  toolCallId?: string;
  /** `display_kind`, such as `failed_turn`. */
  kind?: string;
  /** `display_metadata`. */
  metadata?: Record<string, unknown> | string;
  finish?: string;
  /** Defaults to 1: a row of the conversation as it is now. */
  active?: 0 | 1;
}

/** A row of `messages`, with private words in every column of text the adapter must not read. */
export function messageRow(fields: MessageFields): string {
  const calls =
    fields.toolCalls === undefined
      ? null
      : JSON.stringify(
          fields.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify({ question: PRIVATE_WORDS }) },
          })),
        );
  const metadata =
    fields.metadata === undefined
      ? null
      : typeof fields.metadata === "string"
        ? fields.metadata
        : JSON.stringify(fields.metadata);
  const columns: Record<string, string | number | null | undefined> = {
    session_id: fields.sessionId,
    role: fields.role,
    content: PRIVATE_WORDS,
    tool_call_id: fields.toolCallId,
    tool_calls: calls,
    tool_name: fields.role === "tool" ? "clarify" : null,
    timestamp: seconds(fields.at),
    finish_reason: fields.finish,
    reasoning: PRIVATE_WORDS,
    reasoning_content: PRIVATE_WORDS,
    api_content: PRIVATE_WORDS,
    active: fields.active ?? 1,
    display_kind: fields.kind,
    display_metadata: metadata,
  };
  const names = Object.keys(columns).join(", ");
  const values = Object.values(columns).map(value).join(", ");
  return `INSERT INTO messages (${names}) VALUES (${values});`;
}

export interface LeaseFields {
  /** The conversation's root. */
  conversationId: string;
  /** Defaults to `GATEWAY_PID`. */
  pid?: number;
  /** Stamped as `:pidns=` when given, as Hermes Agent does on Linux. */
  pidns?: number;
  /** `acquired_at` and `expires_at`, in milliseconds. */
  at: number;
  until: number;
  platform?: string;
}

/** A turn lease, with its holder written as Hermes Agent writes it: `pid=<n>[:pidns=<id>]:turn=<id>:platform=<p>`. */
export function leaseRow(fields: LeaseFields): string {
  const namespace = fields.pidns === undefined ? "" : `:pidns=${fields.pidns}`;
  const holder = `pid=${fields.pid ?? GATEWAY_PID}${namespace}:turn=demo-turn:platform=${fields.platform ?? "cli"}`;
  return `INSERT INTO session_turn_leases VALUES (${text(fields.conversationId)}, ${text(holder)}, ${seconds(fields.at)}, ${seconds(fields.until)});`;
}

/** The label the gateway saves while an approval waits. */
export const APPROVAL_LABEL = `waiting for user approval (20s elapsed) ${PRIVATE_WORDS}`;

/** The label the gateway saves while a question waits. */
export const QUESTION_LABEL = `waiting for user clarify response (20s elapsed) ${PRIVATE_WORDS}`;

/** The label of a tool that runs, which says nothing of a wait. */
export const TOOL_LABEL = `executing tool: terminal ${PRIVATE_WORDS}`;

/**
 * The ids of the sessions in `sceneRows`, each named for what it shows.
 * The conversations listed come first, then those that are not.
 */
export const SCENE = {
  /** A conversation Hermes Agent compressed: its root, and the row it goes on in. */
  chainRoot: sessionId("a1"),
  chainTip: sessionId("a2"),
  /** On the desktop app, asking a `clarify` question with no answer yet. */
  question: sessionId("b1"),
  /** In a terminal, waiting for an approval the gateway labels. */
  approval: sessionId("c1"),
  /** A chat with no folder and no title, whose turn failed, and whose lease ran out. */
  failed: sessionId("d1"),
  /** Ended when the terminal closed. */
  finished: sessionId("e1"),
  /** A branch of the finished one, idle on a reply that was stopped. */
  branch: sessionId("f1"),
  /** A scheduled run, idle on a failed turn with no error. */
  cron: "cron_0a1b2c3d4e5f_20261001_110000",
  /** A chat Hermes Agent reset, and the chat it goes on in. */
  resetParent: sessionId("90"),
  resetChild: sessionId("91"),
  /** A reply the model's provider stopped. */
  filtered: sessionId("e2"),
  /** A live lease whose process is gone. */
  deadHolder: sessionId("e3"),
  /** Left out: a subagent's run, hidden, archived, three hidden sources, and one too old. */
  delegate: sessionId("ff01"),
  hidden: sessionId("ff02"),
  archived: sessionId("ff03"),
  tool: sessionId("ff04"),
  kanban: sessionId("ff05"),
  oneshot: sessionId("ff06"),
  old: sessionId("ff07"),
} as const;

/** The folder the compressed conversation went on in. */
export const TIP_FOLDER = `${HOME}/code/demo-next`;

export interface SceneOptions {
  /** The process that holds every live lease. */
  livePid?: number;
  /** A process that is gone, for the lease whose holder died. */
  deadPid?: number;
  /** Stamped on every lease, as Hermes Agent does on Linux. */
  pidns?: number;
}

/**
 * Every row of one profile's database, relative to `now`: a conversation for
 * each case the adapter tells apart, and those it must leave out. What each
 * shows, with the clock at `now` and every live lease's process running:
 *
 * | Session                  | Status     | Since                  |
 * | ------------------------ | ---------- | ---------------------- |
 * | chainRoot, at chainTip   | working    | the lease, 2 minutes   |
 * | question                 | needs-you  | the call, 3 minutes    |
 * | approval                 | needs-you  | the call, 4 minutes    |
 * | failed                   | failed     | 10 minutes             |
 * | finished                 | finished   | 20 minutes             |
 * | branch                   | idle       | 6 minutes              |
 * | cron                     | idle       | 7 minutes              |
 * | resetParent              | finished   | 30 minutes             |
 * | resetChild               | idle       | 8 minutes              |
 * | filtered                 | failed     | 9 minutes              |
 * | deadHolder               | idle       | 5 minutes              |
 */
export function sceneRows(now: number, options: SceneOptions = {}): string[] {
  const at = (minutes: number) => now - minutes * MINUTE;
  const live = options.livePid ?? GATEWAY_PID;
  const pidns = options.pidns;
  const lease = (conversationId: string, minutes: number, pid = live) =>
    leaseRow({ conversationId, pid, pidns, at: at(minutes), until: now + 4 * MINUTE });
  return [
    // A conversation compressed half an hour ago: its root ended with
    // `compression`, and the row it goes on in has no title of its own yet,
    // a folder of its own, and a turn running, with its lease on the root.
    sessionRow({
      id: SCENE.chainRoot,
      title: "Rename the helper",
      startedAt: at(60),
      endedAt: at(30),
      endReason: "compression",
      lastActivityAt: at(30),
    }),
    messageRow({ sessionId: SCENE.chainRoot, role: "user", at: at(59) }),
    messageRow({ sessionId: SCENE.chainRoot, role: "assistant", at: at(31), finish: "stop" }),
    sessionRow({
      id: SCENE.chainTip,
      parentId: SCENE.chainRoot,
      title: null,
      cwd: TIP_FOLDER,
      startedAt: at(30),
      lastActivityAt: at(1),
      label: TOOL_LABEL,
    }),
    messageRow({ sessionId: SCENE.chainTip, role: "user", at: at(2) }),
    messageRow({
      sessionId: SCENE.chainTip,
      role: "assistant",
      at: at(1),
      toolCalls: [{ id: "call_t1", name: "terminal" }],
      finish: "tool_calls",
    }),
    lease(SCENE.chainRoot, 2),

    // A question on the desktop app, with an earlier one already answered.
    sessionRow({
      id: SCENE.question,
      createdSource: "desktop",
      title: "Write the notes",
      startedAt: at(40),
    }),
    messageRow({ sessionId: SCENE.question, role: "user", at: at(5) }),
    messageRow({
      sessionId: SCENE.question,
      role: "assistant",
      at: at(4.5),
      toolCalls: [{ id: "call_q0", name: "clarify" }],
    }),
    messageRow({ sessionId: SCENE.question, role: "tool", at: at(4), toolCallId: "call_q0" }),
    messageRow({
      sessionId: SCENE.question,
      role: "assistant",
      at: at(3),
      toolCalls: [
        { id: "call_q1", name: "clarify" },
        { id: "call_r1", name: "read_file" },
      ],
    }),
    messageRow({ sessionId: SCENE.question, role: "tool", at: at(2.5), toolCallId: "call_r1" }),
    lease(SCENE.question, 5),

    // An approval in a terminal: the gateway's label, and the call that waits.
    sessionRow({
      id: SCENE.approval,
      title: "Clean the build",
      startedAt: at(50),
      lastActivityAt: at(1),
      label: APPROVAL_LABEL,
    }),
    messageRow({ sessionId: SCENE.approval, role: "user", at: at(5) }),
    messageRow({
      sessionId: SCENE.approval,
      role: "assistant",
      at: at(4),
      toolCalls: [{ id: "call_t2", name: "terminal" }],
    }),
    lease(SCENE.approval, 5),

    // A chat with no folder and no title, whose turn failed on an error, and
    // whose lease ran out.
    sessionRow({
      id: SCENE.failed,
      source: "telegram",
      cwd: null,
      title: null,
      sessionKey: "agent:main:telegram:dm:1",
      startedAt: at(90),
    }),
    messageRow({ sessionId: SCENE.failed, role: "user", at: at(11) }),
    messageRow({
      sessionId: SCENE.failed,
      role: "assistant",
      at: at(10),
      kind: "failed_turn",
      metadata: { error: PRIVATE_WORDS },
    }),
    leaseRow({
      conversationId: SCENE.failed,
      pid: live,
      pidns,
      at: at(15),
      until: at(10),
      platform: "telegram",
    }),

    // Ended when its terminal closed.
    sessionRow({
      id: SCENE.finished,
      source: "cli",
      createdSource: null,
      title: "Read the logs",
      startedAt: at(80),
      endedAt: at(20),
      endReason: "cli_close",
    }),
    messageRow({ sessionId: SCENE.finished, role: "assistant", at: at(21), finish: "stop" }),

    // A branch of the finished one, idle on a reply that was stopped after some text.
    sessionRow({
      id: SCENE.branch,
      parentId: SCENE.finished,
      marker: "_branched_from",
      createdSource: "tui",
      title: "Read the logs again",
      startedAt: at(19),
    }),
    messageRow({
      sessionId: SCENE.branch,
      role: "assistant",
      at: at(6),
      metadata: { interrupted: true },
    }),

    // A scheduled run, idle on a turn stopped before any text: a failure row with no error.
    sessionRow({
      id: SCENE.cron,
      source: "cron",
      cwd: null,
      title: "Nightly report",
      startedAt: at(9),
    }),
    messageRow({ sessionId: SCENE.cron, role: "assistant", at: at(7), kind: "failed_turn" }),

    // A chat Hermes Agent reset, and the chat it goes on in, by the same key.
    sessionRow({
      id: SCENE.resetParent,
      source: "telegram",
      cwd: null,
      title: "Morning chat",
      sessionKey: "agent:main:telegram:dm:2",
      startedAt: at(120),
      endedAt: at(30),
      endReason: "session_reset",
    }),
    sessionRow({
      id: SCENE.resetChild,
      parentId: SCENE.resetParent,
      source: "telegram",
      cwd: null,
      title: "Afternoon chat",
      sessionKey: "agent:main:telegram:dm:2",
      startedAt: at(29),
    }),
    messageRow({ sessionId: SCENE.resetChild, role: "user", at: at(8) }),

    // A reply the model's provider stopped.
    sessionRow({ id: SCENE.filtered, title: "Filtered reply", startedAt: at(12) }),
    messageRow({
      sessionId: SCENE.filtered,
      role: "assistant",
      at: at(9),
      finish: "content_filter",
    }),

    // A live lease whose process is gone, as when its gateway was killed.
    sessionRow({ id: SCENE.deadHolder, title: "Killed gateway", startedAt: at(14) }),
    messageRow({ sessionId: SCENE.deadHolder, role: "user", at: at(5) }),
    leaseRow({
      conversationId: SCENE.deadHolder,
      pid: options.deadPid ?? GATEWAY_PID + 1,
      pidns,
      at: at(5),
      until: now + 4 * MINUTE,
    }),

    // A subagent's run, a hidden row, an archived one, the three sources
    // Hermes Agent hides from people, and a session three days old. Each but
    // the last has no parent, so it is its own marker, flag or source alone
    // that leaves it out.
    sessionRow({
      id: SCENE.delegate,
      marker: "_delegate_from",
      markerOf: SCENE.approval,
      source: "subagent",
      title: "Look around",
      startedAt: at(3),
    }),
    messageRow({ sessionId: SCENE.delegate, role: "user", at: at(3) }),
    sessionRow({ id: SCENE.hidden, title: "Hidden work", startedAt: at(3), hidden: true }),
    sessionRow({ id: SCENE.archived, title: "Archived work", startedAt: at(3), archived: true }),
    sessionRow({ id: SCENE.tool, source: "tool", title: "Tool work", startedAt: at(3) }),
    sessionRow({ id: SCENE.kanban, source: "kanban", title: "Kanban work", startedAt: at(3) }),
    sessionRow({ id: SCENE.oneshot, source: "oneshot", title: "One shot", startedAt: at(3) }),
    sessionRow({
      id: SCENE.old,
      title: "Older work",
      startedAt: now - 80 * HOUR,
      endedAt: now - 72 * HOUR,
      endReason: "cli_close",
    }),
  ];
}

/** What `sqlite3 -json` prints for these rows: nothing for none, one row a line otherwise. */
export function sqliteJson(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  return `[${rows.map((row) => JSON.stringify(row)).join(",\n")}]\n`;
}

/** The columns the adapter needs of each table, as v0.22.5 has them. */
const PROBED: Record<string, string[]> = {
  sessions: [
    "id",
    "source",
    "created_source",
    "user_id",
    "session_key",
    "model_config",
    "system_prompt",
    "parent_session_id",
    "started_at",
    "ended_at",
    "end_reason",
    "cwd",
    "title",
    "last_activity_at",
    "last_activity_description",
    "archived",
    "hidden",
  ],
  messages: [
    "id",
    "session_id",
    "role",
    "content",
    "tool_call_id",
    "tool_calls",
    "timestamp",
    "finish_reason",
    "active",
    "display_kind",
    "display_metadata",
  ],
  session_turn_leases: ["conversation_id", "holder", "acquired_at", "expires_at"],
};

/**
 * What the probe prints: for v0.22.5's tables, for v0.21.5's, the last with
 * no `created_source`, for a database with no lease table, or for one with
 * none of the three.
 */
export function probeJson(
  layout: "v0.22.5" | "v0.21.5" | "no-leases" | "none" = "v0.22.5",
): string {
  if (layout === "none") return "";
  const rows: Record<string, unknown>[] = [];
  const tables = Object.keys(PROBED).filter(
    (table) => layout !== "no-leases" || table !== "session_turn_leases",
  );
  for (const name of tables) rows.push({ kind: "table", name });
  for (const table of tables) {
    for (const name of PROBED[table] as string[]) {
      if (layout === "v0.21.5" && name === "created_source") continue;
      rows.push({ kind: table, name });
    }
  }
  return sqliteJson(rows);
}

/** One row of the answer to the sessions query, as `sqlite3 -json` prints it. Any field may be overridden. */
export interface AnswerRow {
  id: string;
  [field: string]: unknown;
}

/**
 * A row of the answer for a conversation of one row, in a terminal, whose
 * newest row is a reply that ended the turn a minute before `NOW`, with no
 * lease and no label. Times are in seconds, as Hermes Agent writes them.
 */
export function answerRow(fields: AnswerRow): Record<string, unknown> {
  return {
    root_id: fields.id,
    root_source: "local",
    root_created_source: "cli",
    root_started_at: seconds(NOW - HOUR),
    root_title: "Rename the helper",
    root_cwd: FOLDER,
    started_at: seconds(NOW - HOUR),
    ended_at: null,
    end_reason: null,
    last_activity_at: seconds(NOW - MINUTE),
    last_message_at: seconds(NOW - MINUTE),
    title: "Rename the helper",
    cwd: FOLDER,
    approval_label: null,
    question_label: null,
    n_role: "assistant",
    n_at: seconds(NOW - MINUTE),
    n_kind: null,
    n_finish: "stop",
    n_error: null,
    calls_at: null,
    open_questions: 0,
    open_calls: 0,
    lease_at: null,
    lease_until: null,
    lease_pid: null,
    lease_pidns: null,
    ...fields,
  };
}

/** The fields of a live lease two minutes old, held by the gateway, with five minutes left. */
export function liveLease(fields: { pidns?: number | null; pid?: number | null } = {}) {
  return {
    lease_at: seconds(NOW - 2 * MINUTE),
    lease_until: seconds(NOW + 5 * MINUTE),
    lease_pid: fields.pid === undefined ? GATEWAY_PID : fields.pid,
    lease_pidns: fields.pidns ?? null,
  };
}

/** The first 100 bytes of a SQLite database whose header says this journal mode: bytes 18 and 19. */
export function databaseHeader(mode: "rollback" | "wal" | [number, number]): Uint8Array {
  const bytes = new Uint8Array(100);
  bytes.set(new TextEncoder().encode("SQLite format 3\u0000"));
  // A page of 4096 bytes, big-endian.
  bytes[16] = 0x10;
  bytes[17] = 0x00;
  const [write, read] = mode === "rollback" ? [1, 1] : mode === "wal" ? [2, 2] : mode;
  bytes[18] = write;
  bytes[19] = read;
  return bytes;
}
