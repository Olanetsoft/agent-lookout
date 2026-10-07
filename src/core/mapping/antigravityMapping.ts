// How the Antigravity CLI's transcripts map onto the session model. Pure, so
// the collector today and a browser or desktop host later share one mapping.
//
// agy writes each conversation as JSON Lines, one step a line, with the step's
// `type` and `status` (docs/adapters/antigravity.md). Nothing in what Agent
// Lookout reads is known to record a wait for approval, so an Antigravity
// session is working, idle, failed or finished here, and never "needs-you".

import type { SessionStatus } from "../sessions/session.ts";

/**
 * Every step type agy 1.3.1 defines, `CortexStepType` in its program, without
 * the `CORTEX_STEP_TYPE_` prefix the transcript leaves off, in the order of
 * their numbers. A type that is not here is one a later agy added.
 */
export const ANTIGRAVITY_STEP_TYPES = [
  "UNSPECIFIED",
  "DUMMY",
  "FINISH",
  "PLAN_INPUT",
  "MQUERY",
  "CODE_ACTION",
  "GIT_COMMIT",
  "GREP_SEARCH",
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "COMPILE",
  "VIEW_CODE_ITEM",
  "USER_INPUT",
  "PLANNER_RESPONSE",
  "ERROR_MESSAGE",
  "RUN_COMMAND",
  "CHECKPOINT",
  "PROPOSE_CODE",
  "FIND",
  "SUGGESTED_RESPONSES",
  "COMMAND_STATUS",
  "MEMORY",
  "READ_URL_CONTENT",
  "VIEW_CONTENT_CHUNK",
  "SEARCH_WEB",
  "RETRIEVE_MEMORY",
  "MCP_TOOL",
  "MANAGER_FEEDBACK",
  "TOOL_CALL_PROPOSAL",
  "TOOL_CALL_CHOICE",
  "TRAJECTORY_CHOICE",
  "CLIPBOARD",
  "VIEW_FILE_OUTLINE",
  "POST_PR_REVIEW",
  "LIST_RESOURCES",
  "READ_RESOURCE",
  "LINT_DIFF",
  "FIND_ALL_REFERENCES",
  "BRAIN_UPDATE",
  "OPEN_BROWSER_URL",
  "RUN_EXTENSION_CODE",
  "PROPOSAL_FEEDBACK",
  "TRAJECTORY_SEARCH",
  "EXECUTE_BROWSER_JAVASCRIPT",
  "LIST_BROWSER_PAGES",
  "CAPTURE_BROWSER_SCREENSHOT",
  "CLICK_BROWSER_PIXEL",
  "READ_TERMINAL",
  "CAPTURE_BROWSER_CONSOLE_LOGS",
  "READ_BROWSER_PAGE",
  "BROWSER_GET_DOM",
  "CODE_SEARCH",
  "BROWSER_INPUT",
  "BROWSER_MOVE_MOUSE",
  "BROWSER_SELECT_OPTION",
  "BROWSER_SCROLL_UP",
  "BROWSER_SCROLL_DOWN",
  "BROWSER_CLICK_ELEMENT",
  "BROWSER_PRESS_KEY",
  "TASK_BOUNDARY",
  "NOTIFY_USER",
  "CODE_ACKNOWLEDGEMENT",
  "INTERNAL_SEARCH",
  "BROWSER_SUBAGENT",
  "FILE_CHANGE",
  "MOVE",
  "BROWSER_SCROLL",
  "KNOWLEDGE_GENERATION",
  "EPHEMERAL_MESSAGE",
  "GENERATE_IMAGE",
  "DELETE_DIRECTORY",
  "COMPILE_APPLET",
  "INSTALL_APPLET_DEPENDENCIES",
  "INSTALL_APPLET_PACKAGE",
  "BROWSER_RESIZE_WINDOW",
  "BROWSER_DRAG_PIXEL_TO_PIXEL",
  "CONVERSATION_HISTORY",
  "KNOWLEDGE_ARTIFACTS",
  "SEND_COMMAND_INPUT",
  "SYSTEM_MESSAGE",
  "WAIT",
  "AGENCY_TOOL_CALL",
  "CIDER_AGENT_DUMMY",
  "BUILD_CLEANER",
  "BLAZE_BUILD_TARGETS",
  "BLAZE_TEST_TARGETS",
  "SET_UP_FIREBASE",
  "MOMA",
  "RESTART_DEV_SERVER",
  "DEPLOY_FIREBASE",
  "SHELL_EXEC",
  "BROWSER_MOUSE_WHEEL",
  "LINT_APPLET",
  "KI_INSERTION",
  "RETRIEVE_CONTENT",
  "CRITIQUE",
  "FINDINGS",
  "BROWSER_MOUSE_UP",
  "BROWSER_MOUSE_DOWN",
  "WORKSPACE_API",
  "BROWSER_LIST_NETWORK_REQUESTS",
  "BROWSER_GET_NETWORK_REQUEST",
  "BROWSER_REFRESH_PAGE",
  "EDIT_NOTEBOOK",
  "INVOKE_SUBAGENT",
  "WRITE_BLOB",
  "READ_NOTEBOOK",
  "PROPOSE_AI_COMMENTS",
  "START_CODE_REVIEW",
  "GENERIC",
  "SET_UP_CLOUD_SQL",
  "EXECUTE_NOTEBOOK",
  "CLOUD_SQL_UPDATE_SCHEMA",
  "RPC_ACTION",
  "CLOUD_SQL_EXECUTE_SQL",
  "ASK_QUESTION",
  "DIRECTORY_RULES",
  "TOOL_SEARCH",
] as const;

/** Every step status agy 1.3.1 defines, `CortexStepStatus`, without the `CORTEX_STEP_STATUS_` prefix. */
export const ANTIGRAVITY_STEP_STATUSES = [
  "UNSPECIFIED",
  "PENDING",
  "RUNNING",
  "DONE",
  "INVALID",
  "CLEARED",
  "CANCELED",
  "ERROR",
  "GENERATING",
  "WAITING",
  "QUEUED",
  "INTERRUPTED",
] as const;

const KNOWN_TYPES: ReadonlySet<string> = new Set(ANTIGRAVITY_STEP_TYPES);
const KNOWN_STATUSES: ReadonlySet<string> = new Set(ANTIGRAVITY_STEP_STATUSES);

/** The prefixes agy's program puts before each name, which the transcript is documented to leave off. */
const TYPE_PREFIX = "CORTEX_STEP_TYPE_";
const STATUS_PREFIX = "CORTEX_STEP_STATUS_";

/** A name as agy writes one: capital letters, digits and underscores. */
const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The step's `type` or `status`, made comparable: upper case, with the program's prefix taken off. Null for anything else. */
function nameOf(value: unknown, prefix: string): string | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  const name = upper.startsWith(prefix) ? upper.slice(prefix.length) : upper;
  return NAME.test(name) ? name : null;
}

/** A step's `type`, as `USER_INPUT`, or null when it is not a name. */
export function stepTypeName(value: unknown): string | null {
  return nameOf(value, TYPE_PREFIX);
}

/** A step's `status`, as `DONE`, or null when it is not a name. */
export function stepStatusName(value: unknown): string | null {
  return nameOf(value, STATUS_PREFIX);
}

/** The few things kept of one step: never its content, its thinking, its media or a tool call's arguments. */
export interface AntigravityStep {
  /** As `stepTypeName` gives it. Null when the step has none that can be read. */
  type: string | null;
  /** As `stepStatusName` gives it. Null when the step has none that can be read. */
  status: string | null;
  /** Whether the step asks for at least one tool call. */
  toolCalls: boolean;
}

/**
 * Steps that say nothing about whose turn it is: a checkpoint, a message the
 * system shows for a moment or adds to the context, the history that stands in
 * for earlier steps after the conversation is compacted, suggested replies, and
 * the rules and knowledge agy adds. They are passed over, so the step before
 * them decides.
 */
const ASIDE_TYPES: ReadonlySet<string> = new Set([
  "DUMMY",
  "CIDER_AGENT_DUMMY",
  "CHECKPOINT",
  "EPHEMERAL_MESSAGE",
  "CONVERSATION_HISTORY",
  "SYSTEM_MESSAGE",
  "SUGGESTED_RESPONSES",
  "KNOWLEDGE_ARTIFACTS",
  "KNOWLEDGE_GENERATION",
  "KI_INSERTION",
  "DIRECTORY_RULES",
  "BRAIN_UPDATE",
]);

/** Statuses of a step that is no longer part of the conversation, such as one a rewind cleared. Passed over. */
const GONE_STATUSES: ReadonlySet<string> = new Set(["CLEARED", "INVALID"]);

/** Statuses that say the step is not over yet. `WAITING` is agy's wait for approval, which shows as working. */
const UNDER_WAY: ReadonlySet<string> = new Set([
  "PENDING",
  "RUNNING",
  "GENERATING",
  "QUEUED",
  "WAITING",
]);

/** Statuses of a step the person stopped, with Esc or Ctrl+C: the turn is back with them. */
const STOPPED: ReadonlySet<string> = new Set(["CANCELED", "INTERRUPTED"]);

/** Step types after which the turn is with the person, once they are done. */
const TURN_OVER: ReadonlySet<string> = new Set(["FINISH"]);

/** Whether a step is passed over when looking for the last one that says how the conversation stands. */
export function isAsideStep(step: Pick<AntigravityStep, "type" | "status">): boolean {
  return (
    (step.type !== null && ASIDE_TYPES.has(step.type)) ||
    (step.status !== null && GONE_STATUSES.has(step.status))
  );
}

/** How a conversation stands while agy has it open, from its last step that is not passed over. */
export type OpenStatus = "working" | "idle" | "failed" | "unknown";

/**
 * What one step, the last that is not passed over, says of a conversation
 * while agy has it open.
 *
 * | Step                                                   | Shown as |
 * | ------------------------------------------------------ | -------- |
 * | `ERROR_MESSAGE`, whatever its status                    | failed   |
 * | `PLANNER_RESPONSE` with status `ERROR`                  | failed   |
 * | status `PENDING`, `RUNNING`, `GENERATING`, `QUEUED`, `WAITING` | working |
 * | status `CANCELED`, `INTERRUPTED`                         | idle     |
 * | `PLANNER_RESPONSE`, `DONE`, with no tool call            | idle     |
 * | `FINISH`, `DONE`                                         | idle     |
 * | `USER_INPUT`, `DONE`                                     | working  |
 * | `PLANNER_RESPONSE`, `DONE`, with a tool call              | working  |
 * | any other known type, `DONE` or `ERROR`                  | working  |
 * | an unknown type or status, or none                       | unknown  |
 *
 * A tool step that ends in `ERROR`, such as a command that fails, is working:
 * the agent reads the error and goes on, and a session is not shown as failed
 * for a moment each time a tool fails. Only an error agy reports as its own
 * step, or a reply of the model's that fails, is failed.
 */
export function openStatusOf(step: AntigravityStep): OpenStatus {
  const { type, status } = step;
  if (type === "ERROR_MESSAGE") return "failed";
  if (status === null || !KNOWN_STATUSES.has(status)) return "unknown";
  if (UNDER_WAY.has(status)) return "working";
  if (STOPPED.has(status)) return "idle";
  if (type === null || !KNOWN_TYPES.has(type) || type === "UNSPECIFIED") return "unknown";
  if (status === "ERROR") return type === "PLANNER_RESPONSE" ? "failed" : "working";
  if (status !== "DONE") return "unknown";
  if (type === "PLANNER_RESPONSE") return step.toolCalls ? "working" : "idle";
  if (TURN_OVER.has(type)) return "idle";
  return "working";
}

/**
 * Whether agy has the conversation open, from the process table: true or false
 * when that could be told, "unknown" when it could not (`antigravityLiveness.ts`).
 */
export type AntigravityLiveness = boolean | "unknown";

export interface AntigravityStatusFields {
  /**
   * The last step of the transcript that is not passed over. `null` means the
   * whole file was read and holds none: a conversation with no step yet.
   * `undefined` means none was found within the part of the file read.
   */
  last: AntigravityStep | null | undefined;
  live: AntigravityLiveness;
}

/**
 * Maps a conversation's last step and whether agy has it open to a status.
 *
 * | Last step says  | Open, or not known | Not open |
 * | --------------- | ------------------ | -------- |
 * | working         | working            | finished |
 * | idle            | idle               | finished |
 * | no step yet     | idle               | finished |
 * | failed          | failed             | failed   |
 * | unknown         | unknown            | unknown  |
 * | none read       | unknown            | unknown  |
 *
 * A conversation that ended on an error stays failed once agy has closed it.
 * It never returns "needs-you": nothing Agent Lookout reads is known to record
 * that agy waits for approval, so such a conversation shows as working.
 */
export function mapAntigravityStatus(fields: AntigravityStatusFields): SessionStatus {
  const { last, live } = fields;
  if (last === undefined) return "unknown";
  const open: OpenStatus = last === null ? "idle" : openStatusOf(last);
  if (open === "failed" || open === "unknown") return open;
  return live === false ? "finished" : open;
}
