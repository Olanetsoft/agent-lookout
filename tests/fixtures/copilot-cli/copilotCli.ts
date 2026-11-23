// Test fixtures only. Every ID, name, path and word here is invented and
// generic. A line follows the envelope GitHub's MIT-licensed Copilot SDK
// documents for a session event at v2.0.1, `{type, data, id, timestamp,
// parentId}` with `agentId` on a sub-agent's, and the event names written up
// in docs/adapters/copilot-cli.md, each line one compact `JSON.stringify`.
// Nothing in it is copied from a real machine or from another reader's files:
// Copilot CLI was not run to make it. Product code never imports this file.

export const HOME = "/Users/example";

/** Copilot CLI's folder and its sessions folder, where the adapter looks when nothing names another. */
export const COPILOT_DIR = `${HOME}/.copilot`;
export const SESSIONS = `${COPILOT_DIR}/session-state`;

/** Midday UTC on 20 November 2026. */
export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions work in. */
export const CWD = `${HOME}/code/demo-project`;

/** A generic session ID, a lowercase UUID as Copilot names a session's folder. */
export const sessionIdOf = (n: number) => `0aaa0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A session that began an hour before `NOW`. */
export const SESSION_ID = sessionIdOf(1);

/** A session's folder, its event log, and a lock in it. */
export const sessionFolder = (id: string = SESSION_ID, sessionsDir: string = SESSIONS) =>
  `${sessionsDir}/${id}`;
export const eventsPath = (id: string = SESSION_ID, sessionsDir: string = SESSIONS) =>
  `${sessionFolder(id, sessionsDir)}/events.jsonl`;
export const lockPath = (pid: number, id: string = SESSION_ID, sessionsDir: string = SESSIONS) =>
  `${sessionFolder(id, sessionsDir)}/inuse.${pid}.lock`;

/** The process that holds the fixture's sessions. */
export const PID = 4321;

/** Words that must never leave a session's log: written where a prompt, a reply, a command, its output, a diff, a question, an error and a name go. */
export const PRIVATE_PROMPT = "PRIVATE_PROMPT placeholder prompt that must never leave the log";
export const PRIVATE_REPLY = "PRIVATE_REPLY placeholder reply";
export const PRIVATE_ARGS = "PRIVATE_ARGS placeholder command";
export const PRIVATE_OUTPUT = "PRIVATE_OUTPUT placeholder output";
export const PRIVATE_DIFF = "PRIVATE_DIFF placeholder diff";
export const PRIVATE_QUESTION = "PRIVATE_QUESTION placeholder question";
export const PRIVATE_ERROR = "PRIVATE_ERROR placeholder error";
export const PRIVATE_TITLE = "PRIVATE_TITLE placeholder name";

/** Every private word, for the tests that look for any of them. */
export const PRIVATE_WORDS = [
  "PRIVATE_PROMPT",
  "PRIVATE_REPLY",
  "PRIVATE_ARGS",
  "PRIVATE_OUTPUT",
  "PRIVATE_DIFF",
  "PRIVATE_QUESTION",
  "PRIVATE_ERROR",
  "PRIVATE_TITLE",
];

let counter = 0;

/** A generic event ID. */
const eventId = () => {
  counter += 1;
  return `0bbb0000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

export interface EventOptions {
  /** A sub-agent's ID, set beside the envelope's other keys. */
  agentId?: string;
  /** `timestamp` as written, in place of the time; `undefined` leaves the key out. */
  timestamp?: unknown;
}

/** One event line, with its line break: `type`, `data`, `id`, `timestamp` and `parentId`, then `agentId`. */
export function event(
  type: string,
  data: Record<string, unknown>,
  at: number,
  options: EventOptions = {},
): string {
  const fields: Record<string, unknown> = {
    type,
    data,
    id: eventId(),
    ...("timestamp" in options
      ? options.timestamp === undefined
        ? {}
        : { timestamp: options.timestamp }
      : { timestamp: new Date(at).toISOString() }),
    parentId: null,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
  };
  return `${JSON.stringify(fields)}\n`;
}

/** `session.start`, with the folder's ID unless a test names another. */
export const sessionStart = (
  at: number,
  options: { id?: string; cwd?: unknown; agentId?: string } = {},
) =>
  event(
    "session.start",
    {
      sessionId: options.id ?? SESSION_ID,
      version: 1,
      producer: "copilot-agent",
      copilotVersion: "1.0.114",
      startTime: new Date(at).toISOString(),
      context: { cwd: "cwd" in options ? options.cwd : CWD, branch: "main" },
      alreadyInUse: false,
    },
    at,
    { agentId: options.agentId },
  );

/** `session.resume`, with `sessionWasActive` when it joined work another client runs. */
export const sessionResume = (
  at: number,
  options: { cwd?: unknown; continuePending?: boolean; wasActive?: boolean } = {},
) =>
  event(
    "session.resume",
    {
      resumeTime: new Date(at).toISOString(),
      eventCount: 10,
      ...("cwd" in options ? { context: { cwd: options.cwd } } : { context: { cwd: CWD } }),
      ...(options.continuePending === undefined
        ? {}
        : { continuePendingWork: options.continuePending }),
      ...(options.wasActive === undefined
        ? {}
        : { alreadyInUse: options.wasActive, sessionWasActive: options.wasActive }),
    },
    at,
  );

/** `user.message`, with the person's words. */
export const userMessage = (at: number, options: EventOptions = {}) =>
  event(
    "user.message",
    { content: PRIVATE_PROMPT, transformedContent: PRIVATE_PROMPT, interactionId: "i-1" },
    at,
    options,
  );

/** `assistant.turn_start`. */
export const turnStart = (
  turnId: string,
  at: number,
  options: EventOptions & { parent?: string } = {},
) =>
  event(
    "assistant.turn_start",
    {
      turnId,
      interactionId: "i-1",
      ...(options.parent ? { parentToolCallId: options.parent } : {}),
    },
    at,
    options,
  );

/** `assistant.turn_end`. */
export const turnEnd = (
  turnId: string,
  at: number,
  options: EventOptions & { parent?: string } = {},
) =>
  event(
    "assistant.turn_end",
    { turnId, ...(options.parent ? { parentToolCallId: options.parent } : {}) },
    at,
    options,
  );

/** `assistant.message`, with a reply's words and as many tool requests as `tools` says. */
export const reply = (at: number, tools: number, options: EventOptions = {}) =>
  event(
    "assistant.message",
    {
      messageId: "m-1",
      content: PRIVATE_REPLY,
      toolRequests: Array.from({ length: tools }, (_, n) => ({
        toolCallId: `call-${n}`,
        name: "bash",
        arguments: { command: PRIVATE_ARGS },
      })),
      turnId: "0",
    },
    at,
    options,
  );

/** `tool.execution_start`, with the tool's arguments. */
export const toolStart = (call: string, toolName: string, at: number, options: EventOptions = {}) =>
  event(
    "tool.execution_start",
    {
      toolCallId: call,
      toolName,
      arguments:
        toolName === "ask_user" ? { question: PRIVATE_QUESTION } : { command: PRIVATE_ARGS },
      turnId: "0",
    },
    at,
    options,
  );

/** `tool.execution_complete`, with its output. */
export const toolEnd = (call: string, at: number, options: EventOptions = {}) =>
  event(
    "tool.execution_complete",
    { toolCallId: call, success: true, result: { content: PRIVATE_OUTPUT } },
    at,
    options,
  );

/** `permission.requested`, with what it asks for. */
export const permissionRequested = (
  request: string,
  at: number,
  options: EventOptions & { byHook?: boolean } = {},
) =>
  event(
    "permission.requested",
    {
      requestId: request,
      permissionRequest: { kind: "write", fileName: `${CWD}/notes.md`, diff: PRIVATE_DIFF },
      promptRequest: { kind: "write", intention: PRIVATE_ARGS },
      ...(options.byHook === undefined ? {} : { resolvedByHook: options.byHook }),
    },
    at,
    options,
  );

/** `permission.completed`. */
export const permissionCompleted = (request: string, at: number, options: EventOptions = {}) =>
  event(
    "permission.completed",
    { requestId: request, toolCallId: "call-0", result: { kind: "approved" } },
    at,
    options,
  );

/** `abort`. */
export const aborted = (at: number) => event("abort", { reason: "user_initiated" }, at);

/** `session.task_complete`, with its `outcome` when one is given. */
export const taskComplete = (at: number, outcome?: unknown) =>
  event(
    "session.task_complete",
    {
      summary: PRIVATE_REPLY,
      ...(outcome === undefined ? {} : { success: outcome === "completed", outcome }),
    },
    at,
  );

/** `session.error`, with its message. */
export const sessionError = (at: number) =>
  event("session.error", { errorType: "model", message: PRIVATE_ERROR }, at);

/** `session.shutdown`. */
export const shutdown = (at: number, shutdownType: unknown = "routine") =>
  event("session.shutdown", { shutdownType, totalPremiumRequests: 1 }, at);

/** A line of a type the adapter passes over. */
export const other = (type: string, at: number) =>
  event(type, { message: PRIVATE_REPLY, title: PRIVATE_TITLE }, at);

/**
 * One whole request, as Copilot writes it: the person's message, a turn that
 * asks for a tool, the tool's run, and a turn that asks for none.
 */
export const request = (at: number, call = "call-0") =>
  [
    userMessage(at),
    turnStart("0", at + 1),
    reply(at + 2, 1),
    toolStart(call, "bash", at + 3),
    toolEnd(call, at + 4),
    turnEnd("0", at + 5),
    turnStart("1", at + 6),
    reply(at + 7, 0),
    turnEnd("1", at + 8),
    other("session.usage_checkpoint", at + 9),
  ].join("");
