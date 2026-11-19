// Grok Build's files, written by hand the way Grok Build 1.0.45 writes them:
// the list of open sessions as serde's pretty printer writes it
// (`xai-grok-active-sessions/src/lib.rs:130-141`), each event a compact line
// with `ts` and `type` first (`xai-grok-session-events/src/log.rs:12-17`,
// `:62-81`), and `summary.json` and `plan_mode.json` pretty, two spaces to a
// level (`xai-grok-shell/src/session/storage/jsonl/mod.rs:766`, `:1457-1465`).
// Every value is made up: the folders are under /Users/example and the project
// is demo-project.
//
// The text Agent Lookout must never turn into text is written with words found
// nowhere else, so a test can look for them in anything the adapter made.

export const HOME = "/Users/example";
export const GROK_HOME = `${HOME}/.grok`;
export const REGISTRY_FILE = `${GROK_HOME}/active_sessions.json`;
export const SESSIONS_DIR = `${GROK_HOME}/sessions`;
export const PROJECT = "/Users/example/code/demo-project";
/** `PROJECT` as Grok Build names its folder of sessions. */
export const PROJECT_FOLDER = "%2FUsers%2Fexample%2Fcode%2Fdemo-project";

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The time the tests are run at. */
export const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

/** When the sessions were listed, ten minutes before. */
export const OPENED_AT = NOW - 10 * MINUTE;

export const PID = 4242;
export const OTHER_PID = 4343;

/** Session IDs as Grok Build makes them, UUIDv7s. */
export const SESSION_ID = "019a9a00-0000-7000-8000-000000000001";
export const OTHER_SESSION_ID = "019a9a00-0000-7000-8000-000000000002";

/** Words that must never reach anything the adapter makes. */
export const SECRET = "zebra-quartz-mandolin";
export const TYPED_TITLE = "please fix the flaky quartzmandolin login test now";

/** A time as Grok Build writes an event's, to the millisecond, in UTC. */
export const ts = (ms: number) => new Date(ms).toISOString();

/** A time as chrono writes `opened_at`: to the nanosecond when it has any. */
export const openedAt = (ms: number) =>
  new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");

/** The folder of a session, in `sessions/<folder>/<ID>`. */
export const sessionFolder = (id = SESSION_ID, folder = PROJECT_FOLDER) =>
  `${SESSIONS_DIR}/${folder}/${id}`;

export const eventsPath = (id = SESSION_ID, folder = PROJECT_FOLDER) =>
  `${sessionFolder(id, folder)}/events.jsonl`;
export const summaryPath = (id = SESSION_ID, folder = PROJECT_FOLDER) =>
  `${sessionFolder(id, folder)}/summary.json`;
export const planPath = (id = SESSION_ID, folder = PROJECT_FOLDER) =>
  `${sessionFolder(id, folder)}/plan_mode.json`;

export interface Entry {
  session_id?: unknown;
  pid?: unknown;
  cwd?: unknown;
  opened_at?: unknown;
  [extra: string]: unknown;
}

/** One entry of the list, as the terminal app registers a session. */
export function entry(overrides: Entry = {}): Entry {
  return {
    session_id: SESSION_ID,
    pid: PID,
    cwd: PROJECT,
    opened_at: openedAt(OPENED_AT),
    ...overrides,
  };
}

/** The list, as serde's pretty printer writes it. */
export const registryText = (entries: readonly Entry[]) => JSON.stringify(entries, null, 2);

// The event log's lines, compact, `ts` then `type` then the event's own fields
// in the order Grok Build declares them (`xai-grok-session-events/src/types.rs`).

const line = (at: number, type: string, fields: Record<string, unknown> = {}) =>
  `${JSON.stringify({ ts: ts(at), type, ...fields })}\n`;

export const turnStarted = (at: number, fields: Record<string, unknown> = {}) =>
  line(at, "turn_started", {
    session_id: SESSION_ID,
    turn_number: 1,
    model_id: "grok-model-x",
    yolo_mode: false,
    conversation_message_count: 2,
    session_relationship: "primary",
    schema_version: "1.0",
    ...fields,
  });

export const turnEnded = (
  at: number,
  outcome = "completed",
  fields: Record<string, unknown> = {},
) => line(at, "turn_ended", { outcome, ...fields });

export const loopStarted = (at: number, index = 0) =>
  line(at, "loop_started", { loop_index: index });

export const phaseChanged = (at: number, phase: string) => line(at, "phase_changed", { phase });

export const firstToken = (at: number) => line(at, "first_token");

export const toolStarted = (at: number, tool = "bash") =>
  line(at, "tool_started", { tool_name: tool });

export const toolCompleted = (at: number, tool = "bash", outcome = "success") =>
  line(at, "tool_completed", {
    tool_name: tool,
    duration_ms: 12,
    outcome,
    tool_call_id: "call_0001",
  });

export const permissionRequested = (at: number, tool = "bash") =>
  line(at, "permission_requested", { tool_name: tool });

export const permissionResolved = (at: number, tool = "bash", decision = "allow") =>
  line(at, "permission_resolved", { tool_name: tool, decision, wait_ms: 5 });

/** A line of the session's own, not a turn's: an MCP server starting. */
export const mcpServerStarting = (at: number, name = "demo-server") =>
  line(at, "mcp_server_starting", { server_name: name, transport: "stdio" });

/** A turn that ran one tool and ended. */
export function wholeTurn(start: number, outcome = "completed"): string {
  return [
    turnStarted(start),
    loopStarted(start + 10),
    phaseChanged(start + 20, "waiting_for_model"),
    firstToken(start + 300),
    phaseChanged(start + 310, "streaming_text"),
    toolStarted(start + 400),
    permissionRequested(start + 410),
    permissionResolved(start + 420),
    phaseChanged(start + 430, "tool_execution"),
    toolCompleted(start + 900),
    turnEnded(start + 1_000, outcome),
  ].join("");
}

/** `summary.json`, pretty, with its keys in the order Grok Build declares them. */
export function summaryText(fields: { title?: string; manual?: boolean; extra?: object } = {}) {
  const value: Record<string, unknown> = {
    info: { id: SESSION_ID, cwd: PROJECT },
    session_summary: fields.title ?? "",
    created_at: ts(OPENED_AT),
    updated_at: ts(OPENED_AT),
    ...(fields.title === undefined ? {} : { generated_title: fields.title }),
    ...(fields.manual ? { title_is_manual: true } : {}),
    current_model_id: "grok-model-x",
    git_remotes: [`https://${SECRET}@example.invalid/demo.git`],
    last_turn_summary: SECRET,
    ...fields.extra,
  };
  return JSON.stringify(value, null, 2);
}

/** `plan_mode.json`, pretty, as Grok Build writes its plan state. */
export function planText(awaiting: boolean | undefined) {
  return JSON.stringify(
    {
      state: "Active",
      was_previously_active: false,
      reminder_count: 0,
      pending_exit_reminder: false,
      ...(awaiting === undefined ? {} : { awaiting_plan_approval: awaiting }),
    },
    null,
    2,
  );
}
