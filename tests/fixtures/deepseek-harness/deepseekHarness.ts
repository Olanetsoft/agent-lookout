// Test fixtures only. Every id, name, path and word here is invented and
// generic. A log follows the shape DeepSeek Harness's source writes at
// dsh-v0.2.2-rc.3: the header as `session-format-v1-to-v2/src/codec.ts`
// builds it, each event as `core/session/src/index.ts` builds it, or as the
// chat import from chat.deepseek.com builds it, and the data
// of each kind as its writer builds it, key by key in that order, as written
// up in docs/adapters/deepseek-harness.md. Nothing in it is copied from a real
// machine: DeepSeek Harness was not run to make it. It uses no Node.js API:
// compressed logs are made from these lines in
// `tests/support/adapters/deepseek-harness/frames.ts`. Product code never
// imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const SESSIONS_DIR = `${HOME}/.dsh/sessions`;

/** Midday UTC on 17 November 2026. */
export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in, and its project folder's name. */
export const CWD = `${HOME}/code/demo-project`;
export const PROJECT_FOLDER = "--Users-example-code-demo-project--";

/** When the fixture's sessions began. */
export const STARTED_AT = NOW - HOUR;

/** A generic UUID, lowercase, as `randomUUID` writes one. */
export const uuidOf = (kind: number, n: number) =>
  `${kind.toString(16).padStart(8, "0")}-c3d4-4e5f-8a9b-${n.toString(16).padStart(12, "0")}`;

/** A session's ID as a headless or new session has it: `session-<uuid>`. */
export const sessionIdOf = (n: number) => `session-${uuidOf(1, n)}`;

export const SESSION_ID = sessionIdOf(1);
export const CHILD_ID = sessionIdOf(2);

/**
 * Words written where a prompt, a reply, a tool's arguments or output, an
 * approval's reason, an error, a hook's reason, a plan or a fallback title
 * goes. None may leave the log.
 */
export const PRIVATE_WORDS = [
  "PRIVATE-PROMPT-WORDS",
  "PRIVATE-REPLY-WORDS",
  "PRIVATE-ARGUMENT-WORDS",
  "PRIVATE-OUTPUT-WORDS",
  "PRIVATE-REASON-WORDS",
  "PRIVATE-ERROR-WORDS",
  "PRIVATE-HOOK-WORDS",
  "PRIVATE-PLAN-WORDS",
  "PRIVATE-FALLBACK-WORDS",
] as const;

/** A session folder's path. */
export const sessionFolder = (id: string = SESSION_ID, project: string = PROJECT_FOLDER) =>
  `${SESSIONS_DIR}/${project}/${id}`;

/** A log's path: format 4, compressed, unless a test says otherwise. */
export function logPath(
  id: string = SESSION_ID,
  options: { compressed?: boolean; version?: number; project?: string } = {},
): string {
  const version = options.version ?? 4;
  const name = version === 0 ? "session.jsonl" : `session.v${version}.jsonl`;
  return `${sessionFolder(id, options.project)}/${name}${options.compressed === false ? "" : ".zstd"}`;
}

export interface HeaderFields {
  id?: string;
  createdAt?: number;
  cwd?: string | null;
  parentSession?: string;
  isSeeded?: boolean;
  origin?: "subagent";
  delegationDepth?: number;
  agentPreset?: string;
  version?: number;
}

/** The first line, with its newline, in the order DeepSeek Harness writes its keys. */
export function headerLine(fields: HeaderFields = {}): string {
  const cwd = fields.cwd === undefined ? CWD : fields.cwd;
  const header = {
    type: "session",
    version: fields.version ?? 4,
    id: fields.id ?? SESSION_ID,
    createdAt: fields.createdAt ?? STARTED_AT,
    ...(cwd === null ? {} : { cwd }),
    ...(fields.parentSession === undefined ? {} : { parentSession: fields.parentSession }),
    isSeeded: fields.isSeeded ?? false,
    ...(fields.origin === undefined ? {} : { origin: fields.origin }),
    delegationDepth: fields.delegationDepth ?? 0,
    ...(fields.agentPreset === undefined ? {} : { agentPreset: fields.agentPreset }),
  };
  return `${JSON.stringify(header)}\n`;
}

/** A subagent's first line, of the session `parent`. */
export const childHeaderLine = (id: string = CHILD_ID, parent: string = SESSION_ID) =>
  headerLine({ id, parentSession: parent, origin: "subagent", delegationDepth: 1 });

/** One event's line, without its newline, `{type, seq, time, data}` and then any surface keys. */
export function event(
  type: string,
  seq: number,
  time: number,
  data: unknown,
  surface: Record<string, unknown> = {},
): string {
  return JSON.stringify({ type, seq, time, data, ...surface });
}

/**
 * One event's line as the chat import writes it, `{type, data}` and then any
 * surface keys, then `seq` and `time` (deepseek-chat-import/src/conversation.ts:
 * 180-183, importer.ts:564-568).
 */
export function importedEvent(
  type: string,
  seq: number,
  time: number,
  data: unknown,
  surface: Record<string, unknown> = {},
): string {
  return JSON.stringify({ type, data, ...surface, seq, time });
}

/** Lines joined as one batch, with the newline after the last, as DeepSeek Harness writes a batch. */
export const batch = (...lines: string[]) => `${lines.join("\n")}\n`;

/** The lines of each kind, as their writers build them. */
export const line = {
  turnStart: (seq: number, time: number, turn = 1) => event("turn/start", seq, time, { turn }),
  turnEnd: (seq: number, time: number, kind: string, turn = 1) =>
    event("turn/end", seq, time, {
      turn,
      reason:
        kind === "error"
          ? { kind, error: { message: PRIVATE_WORDS[5], code: "UNKNOWN" } }
          : { kind },
    }),
  /** An aborted turn, with its own reason: `user`, `parent`, `disposed`, or `hook` with its words. */
  aborted: (seq: number, time: number, why: string, turn = 1) =>
    event("turn/end", seq, time, {
      turn,
      reason: {
        kind: "aborted",
        reason: why === "hook" ? { kind: "hook", reason: PRIVATE_WORDS[6] } : { kind: why },
      },
    }),
  userMessage: (seq: number, time: number) =>
    event("user/message", seq, time, {
      turn: 1,
      message: { role: "user", content: [{ type: "text", text: PRIVATE_WORDS[0] }] },
    }),
  assistantMessage: (seq: number, time: number) =>
    event("assistant/message", seq, time, {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: PRIVATE_WORDS[1] }] },
    }),
  approvalAsked: (seq: number, time: number, id: string = uuidOf(7, 1), callId = "call_1") =>
    event("approval/asked", seq, time, {
      id,
      toolName: "bash",
      callId,
      reason: PRIVATE_WORDS[4],
    }),
  approvalDecided: (
    seq: number,
    time: number,
    id: string = uuidOf(7, 1),
    outcome = "allowed-once",
  ) => event("approval/decided", seq, time, { id, outcome }),
  toolCall: (
    seq: number,
    time: number,
    callId: string,
    name: string,
    args: string = JSON.stringify({ command: PRIVATE_WORDS[2] }),
  ) => event("tool/call", seq, time, { turn: 1, step: 1, callId, name, arguments: args }),
  toolResult: (seq: number, time: number, callId: string) =>
    event(
      "tool/result",
      seq,
      time,
      {
        turn: 1,
        step: 1,
        message: {
          role: "tool",
          source: { kind: "tool", callId },
          toolCallId: callId,
          content: [{ type: "text", text: PRIVATE_WORDS[3] }],
          isError: false,
          id: uuidOf(8, seq),
        },
      },
      { surfaceOp: "append" },
    ),
  /** A result as a resume or a failed step writes it, in another order (core/session/src/repair.ts:173-193). */
  syntheticResult: (seq: number, time: number, callId: string) =>
    event(
      "tool/result",
      seq,
      time,
      {
        turn: 1,
        step: 1,
        message: {
          id: `interrupted-tool-result-${callId}-${seq}`,
          role: "tool",
          toolCallId: callId,
          isError: true,
          source: { kind: "tool", callId },
          content: [{ type: "text", text: "The tool call was interrupted." }],
        },
        error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
      },
      { surfaceOp: "append" },
    ),
  title: (seq: number, time: number, title: string, kind: "provider" | "user" | "fallback") =>
    event("session/title", seq, time, {
      title,
      messageSeqs: kind === "user" ? [] : [1],
      source:
        kind === "provider" ? { kind, provider: "demo-provider", model: "demo-model" } : { kind },
    }),
  endSeed: (seq: number, time: number, inherited: boolean) =>
    event("session/end-seed", seq, time, inherited ? { inherited: true } : {}),
  plugin: (seq: number, time: number) =>
    JSON.stringify({
      type: "plugin:demo/record",
      seq,
      time,
      data: { note: PRIVATE_WORDS[1] },
      ignorable: true,
    }),
};

/** A turn that ends: its start, a prompt, a reply and its end. */
export function endedTurn(from: number, time: number, kind = "completed"): string[] {
  return [
    line.turnStart(from, time),
    line.userMessage(from + 1, time + 1),
    line.assistantMessage(from + 2, time + 2),
    line.turnEnd(from + 3, time + 3, kind),
  ];
}
