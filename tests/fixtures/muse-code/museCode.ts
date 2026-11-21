// Test fixtures only. Every ID, name, path and word here is invented and
// generic. A log line follows the shape Meta documents for Muse Code's raw
// records, `RawLogRecordEnvelope` in its MIT-licensed protocol schema at
// 1.4.24, and the record names written up in docs/adapters/muse-code.md, each
// line one compact `JSON.stringify` of its fields in the order Meta's own
// export writes them. Nothing in it is copied from a real machine, from Meta's
// export or from another reader's files: Muse Code was not run to make it.
// Product code never imports this file.

export const HOME = "/Users/example";

/** Muse Code's data folder and its sessions folder, where the adapter looks when nothing names another. */
export const DATA_DIR = `${HOME}/.local/share/muse`;
export const SESSIONS = `${DATA_DIR}/sessions`;

/** Midday UTC on 19 November 2026. */
export const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The workspace the fixture's sessions run in. */
export const CWD = `${HOME}/code/demo-project`;

/** A version 7 UUID made of a time and a number, as Muse Code names a session. */
export function uuidAt(at: number, n: number): string {
  const time = Math.floor(at).toString(16).padStart(12, "0");
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7000-8000-${String(n).padStart(12, "0")}`;
}

/** A generic ID of a run, a question or an approval. */
export const idOf = (kind: string, n: number) =>
  `${({ run: "0aaa", prompt: "0bbb", action: "0ccc", record: "0ddd" } as Record<string, string>)[kind] ?? "0eee"}0000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A session that began an hour before `NOW`. */
export const SESSION_ID = uuidAt(NOW - HOUR, 1);
export const RUN = idOf("run", 1);
export const RUN_2 = idOf("run", 2);
export const PROMPT = idOf("prompt", 1);
export const ACTION = idOf("action", 1);

/** The day folder of a time, by its UTC date. */
export function dayFolder(at: number = NOW, sessionsDir: string = SESSIONS): string {
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${sessionsDir}/${date.getUTCFullYear()}/${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())}`;
}

/** A session's folder and log, in the day folder of a time. */
export const sessionFolder = (id: string = SESSION_ID, at: number = NOW, sessionsDir = SESSIONS) =>
  `${dayFolder(at, sessionsDir)}/${id}`;
export const logPath = (id: string = SESSION_ID, at: number = NOW, sessionsDir = SESSIONS) =>
  `${sessionFolder(id, at, sessionsDir)}/session.jsonl`;

/** Words that must never leave a session's log: written where a prompt, a question, an answer, a command, a reply or a review goes. */
export const PRIVATE_PROMPT = "PRIVATE_PROMPT placeholder prompt that must never leave the log";
export const PRIVATE_QUESTION = "PRIVATE_QUESTION placeholder question";
export const PRIVATE_ANSWER = "PRIVATE_ANSWER placeholder answer";
export const PRIVATE_ARGS = "PRIVATE_ARGS placeholder command";
export const PRIVATE_REPLY = "PRIVATE_REPLY placeholder reply";
export const PRIVATE_REVIEW = "PRIVATE_REVIEW placeholder rationale";
export const PRIVATE_TITLE = "PRIVATE_TITLE placeholder name";
export const PRIVATE_FRAME = "PRIVATE_FRAME placeholder rule";

/** Every private word, for the tests that look for any of them. */
export const PRIVATE_WORDS = [
  "PRIVATE_PROMPT",
  "PRIVATE_QUESTION",
  "PRIVATE_ANSWER",
  "PRIVATE_ARGS",
  "PRIVATE_REPLY",
  "PRIVATE_REVIEW",
  "PRIVATE_TITLE",
  "PRIVATE_FRAME",
];

let sequence = 0;

export interface EnvelopeOptions {
  /** The session the record is of, whose folder's name its stream names. Defaults to `SESSION_ID`. */
  session?: string;
  /** Another stream, as a subagent's task run writes in its parent's log. */
  stream?: { kind: string; id: string } | null;
  /** Defaults to 1. */
  schemaVersion?: unknown;
  /** `recorded_at` as written, in place of the time in microseconds; `undefined` leaves the key out. */
  recordedAt?: unknown;
}

/**
 * One record line, with its line break: the envelope's keys in Meta's order,
 * `recorded_at` in microseconds since the epoch.
 */
export function record(
  payloadType: string,
  payload: unknown,
  at: number,
  options: EnvelopeOptions = {},
): string {
  sequence += 1;
  const session = options.session ?? SESSION_ID;
  const fields: Record<string, unknown> = {
    schema_version: "schemaVersion" in options ? options.schemaVersion : 1,
    id: idOf("record", sequence),
    ...(options.stream === null
      ? {}
      : { stream: options.stream ?? { kind: "session", id: session } }),
    sequence,
    ...("recordedAt" in options
      ? options.recordedAt === undefined
        ? {}
        : { recorded_at: options.recordedAt }
      : { recorded_at: Math.floor(at) * 1000 }),
    record_type: "event",
    durability: "durable",
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  };
  return `${JSON.stringify(fields)}\n`;
}

const run = (runId: string, event: Record<string, unknown>) => ({
  kind: "run",
  run_id: runId,
  event,
});
const approval = (runId: string, event: Record<string, unknown>) => ({
  kind: "approval",
  run_id: runId,
  event,
});

/** A run's start, with the person's prompt after its kind. */
export const started = (
  runId: string,
  at: number,
  options?: EnvelopeOptions,
  prompt = PRIVATE_PROMPT,
) => record("runtime.session", run(runId, { kind: "started", prompt }), at, options);

/** A run's end. */
export const terminal = (
  runId: string,
  at: number,
  end: unknown = "completed",
  options?: EnvelopeOptions,
) =>
  record(
    "runtime.session",
    run(runId, { kind: "terminal", reason: null, terminal: end }),
    at,
    options,
  );

export const retracted = (runId: string, at: number, options?: EnvelopeOptions) =>
  record("runtime.session", run(runId, { kind: "run_retracted" }), at, options);

/** Another event of a run: a reply committed, with its text. */
export const replied = (runId: string, at: number, options?: EnvelopeOptions) =>
  record(
    "runtime.session",
    run(runId, {
      kind: "assistant_message_committed",
      message_id: idOf("other", 1),
      text: PRIVATE_REPLY,
    }),
    at,
    options,
  );

/** A sample of the run's use of resources, written while it runs. */
export const sampled = (runId: string, at: number, options?: EnvelopeOptions) =>
  record(
    "runtime.session",
    run(runId, { kind: "resource_usage_sampled", cpu_percent: 12 }),
    at,
    options,
  );

/** A question to the person, by `request_user_input`. */
export const asked = (runId: string, prompt: string, at: number, options?: EnvelopeOptions) =>
  record(
    "runtime.session",
    run(runId, {
      kind: "user_input_prompt_requested",
      prompt_id: prompt,
      run_stream: { kind: "run", id: runId },
      tool_call_id: `call_${prompt}`,
      tool_name: "request_user_input",
      questions: [{ id: "q1", header: "Choice", question: PRIVATE_QUESTION, options: [] }],
    }),
    at,
    options,
  );

/** Its answer. */
export const settled = (runId: string, prompt: string, at: number, options?: EnvelopeOptions) =>
  record(
    "runtime.session",
    run(runId, {
      kind: "user_input_prompt_settled",
      prompt_id: prompt,
      tool_call_id: `call_${prompt}`,
      command_id: idOf("other", 2),
      outcome: "answered",
      answers: [{ id: "q1", selected_label: PRIVATE_ANSWER }],
    }),
    at,
    options,
  );

/** An approval's request, with its phase as its last key, or none. */
export const requested = (
  runId: string,
  action: string,
  at: number,
  phase?: string,
  options?: EnvelopeOptions,
) =>
  record(
    "runtime.session",
    approval(runId, {
      kind: "requested",
      session_stream: { kind: "session", id: options?.session ?? SESSION_ID },
      pending_action_id: action,
      run_stream: { kind: "run", id: runId },
      tool_name: "shell",
      raw_args: PRIVATE_ARGS,
      approval_subject: {
        kind: "tool_action",
        origin: { kind: "shell_command", command: PRIVATE_ARGS },
      },
      current_requirement_id: { pending_action_id: action, source_index: 0 },
      available_choices: [{ choice_id: "allow_once", decision: { kind: "approved" } }],
      ...(phase === undefined ? {} : { presentation_phase: phase }),
    }),
    at,
    options,
  );

export const reviewStarted = (
  runId: string,
  action: string,
  at: number,
  options?: EnvelopeOptions,
) =>
  record(
    "runtime.session",
    approval(runId, {
      kind: "automated_review_started",
      review_id: idOf("other", 3),
      pending_action_id: action,
      exact_action: { pending: { pending_action_id: action, raw_args: PRIVATE_ARGS } },
    }),
    at,
    options,
  );

export interface Completion {
  status?: string;
  timedOut?: boolean;
  failure?: unknown;
}

export const reviewCompleted = (
  runId: string,
  action: string,
  at: number,
  completion: Completion = {},
  options?: EnvelopeOptions,
) =>
  record(
    "runtime.session",
    approval(runId, {
      kind: "automated_review_completed",
      review_id: idOf("other", 3),
      pending_action_id: action,
      status: completion.status ?? "escalated",
      assessment: { risk_level: "low", outcome: "escalate", rationale: PRIVATE_REVIEW },
      failure: "failure" in completion ? completion.failure : null,
      timed_out: completion.timedOut ?? false,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    at,
    options,
  );

export const decided = (
  runId: string,
  action: string,
  at: number,
  decision = "approved",
  options?: EnvelopeOptions,
) =>
  record(
    "runtime.session",
    approval(runId, {
      kind: "decision_applied",
      session_stream: { kind: "session", id: options?.session ?? SESSION_ID },
      pending_action_id: action,
      decision,
      decision_source: { kind: "human_approval" },
    }),
    at,
    options,
  );

/** The effect's end for an approval's wait. */
export const waitEnded = (action: string, at: number, options?: EnvelopeOptions) =>
  record(
    "approval_wait.effect.terminal",
    { record: { pending_action_id: action, outcome: "decided" } },
    at,
    options,
  );

/** A task's record, which says nothing of the run's state. */
export const taskOutput = (runId: string, at: number, options?: EnvelopeOptions) =>
  record(
    "runtime.session",
    {
      kind: "task",
      run_id: runId,
      task_id: idOf("other", 4),
      event: { kind: "output", chunk: PRIVATE_REPLY },
    },
    at,
    options,
  );

/** The host let the session go. */
export const sessionEnd = (at: number, exitReason = "clean", options?: EnvelopeOptions) =>
  record("session.end", { record: { exit_reason: exitReason } }, at, options);

/** A host took the session up again. */
export const sessionResumed = (at: number, options?: EnvelopeOptions) =>
  record(
    "session.resumed",
    { record: { prior_turn_count: 1, resumed_from_sequence: 9 } },
    at,
    options,
  );

/** The session's metadata record, which names its workspace. */
export const metadata = (at: number, workspaceRoot: unknown = CWD, options?: EnvelopeOptions) =>
  record(
    "runtime.session.metadata",
    {
      kind: "metadata",
      record: {
        workspace_root: workspaceRoot,
        build: "demo",
        provider_id: "demo",
        web_search_mode: "off",
      },
    },
    at,
    options,
  );

/** A rename, which decides nothing. */
export const renamed = (at: number, options?: EnvelopeOptions) =>
  record("session.name.changed", { record: { name: PRIVATE_TITLE } }, at, options);

/** A change of model, which decides nothing. */
export const modelChanged = (at: number, options?: EnvelopeOptions) =>
  record("runtime.session.model_changed", { record: { model_id: "demo-model" } }, at, options);

/** A frame that wraps other records as strings, as readers see at a log's start. */
export const frame = (children: string[]) =>
  `${JSON.stringify({
    retained_frame: "session_permission_transaction",
    frame_schema_version: 1,
    outer_log_ordinal: 1,
    transaction_id: idOf("other", 5),
    children: children.map((child) => ({ record_json: child.trimEnd() })),
    content_sha256: "0".repeat(64),
  })}\n`;

/** A marker that stands for a record dropped as live only. */
export const marker = (kind = "runtime.session") =>
  `${JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: SESSION_ID },
    retained_marker: "omitted_live_only",
    position: 3,
    record_type: kind,
  })}\n`;

/** A log's opening: its metadata record and a run's start. */
export const opening = (at: number, runId: string = RUN, options?: EnvelopeOptions) =>
  `${metadata(at - SECOND, CWD, options)}${started(runId, at, options)}`;
