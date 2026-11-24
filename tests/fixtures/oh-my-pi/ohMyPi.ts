// Test fixtures only. Every ID, name, path and word here is invented and
// generic. A session file follows the shape Oh My Pi's source at v19.0.0
// writes, with its approval lines as v19.1.1 writes them, as written up in
// docs/adapters/oh-my-pi.md: a title slot of 256 bytes, the header, then one
// entry a line, each `JSON.stringify` of its fields in the order Oh My Pi
// builds them. Nothing in it is copied from a
// real machine or from Oh My Pi's code: Oh My Pi was not run to make it.
// Product code never imports this file.

export const HOME = "/Users/example";

/** Oh My Pi's folder, its agent folder and its sessions folder, where the adapter looks when nothing names another. */
export const OMP_DIR = `${HOME}/.omp`;
export const AGENT_DIR = `${OMP_DIR}/agent`;
export const SESSIONS = `${AGENT_DIR}/sessions`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in. */
export const CWD = `${HOME}/code/demo-project`;

/** The folder Oh My Pi keeps that folder's sessions in: `-`, then the path under the home folder with each `/` as `-`. */
export const PROJECT_FOLDER_NAME = "-code-demo-project";
export const PROJECT_FOLDER = `${SESSIONS}/${PROJECT_FOLDER_NAME}`;

/** A generic session ID, in the UUID shape Oh My Pi gives one. */
export const sessionIdOf = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export const SESSION_ID = sessionIdOf(1);

/** A session's file, `<time>_<id>.jsonl`, in a project folder or another folder. */
export const sessionPath = (id: string = SESSION_ID, dir: string = PROJECT_FOLDER) =>
  `${dir}/2026-10-01T11-00-00-000Z_${id}.jsonl`;

/** Words that must never leave a session's file: written where a prompt, a reply, a tool or a summary go. */
export const PRIVATE_PROMPT = "PRIVATE_PROMPT placeholder prompt that must never leave the file";
export const PRIVATE_REPLY = "PRIVATE_REPLY placeholder reply that must never leave the file";
export const PRIVATE_ARGS = "PRIVATE_ARGS placeholder command that must never leave the file";
export const PRIVATE_INTENT = "PRIVATE_INTENT placeholder intent that must never leave the file";
export const PRIVATE_SUMMARY = "PRIVATE_SUMMARY placeholder summary that must never leave the file";
export const PRIVATE_BRANCH = "PRIVATE_BRANCH-placeholder";
export const PRIVATE_LABEL = "PRIVATE_LABEL placeholder";
export const PRIVATE_PATH = "/Users/example/PRIVATE_PATH/placeholder.jsonl";
export const PRIVATE_REASON = "PRIVATE_REASON placeholder reason that must never leave the file";
export const PRIVATE_GOAL = "PRIVATE_GOAL placeholder goal that must never leave the file";
/** Written where the header's own copy of the title goes, and in a slot with no source. */
export const PRIVATE_TITLE = "PRIVATE_TITLE placeholder title";
/** Written as a Codex session's copy's title, which is the first prompt typed in Codex. */
export const PRIVATE_CODEX_TITLE = "PRIVATE_CODEX_TITLE first prompt typed in Codex";

/** Every private word, for the tests that look for any of them. */
export const PRIVATE_WORDS = [
  "PRIVATE_PROMPT",
  "PRIVATE_REPLY",
  "PRIVATE_ARGS",
  "PRIVATE_INTENT",
  "PRIVATE_SUMMARY",
  "PRIVATE_BRANCH",
  "PRIVATE_LABEL",
  "PRIVATE_PATH",
  "PRIVATE_REASON",
  "PRIVATE_GOAL",
  "PRIVATE_TITLE",
  "PRIVATE_CODEX_TITLE",
];

/** A time as `Date.toISOString()` writes one. */
export const iso = (at: number) => new Date(at).toISOString();

/** One line of a file, as JSON with a line break. */
export const line = (fields: unknown) => `${JSON.stringify(fields)}\n`;

const SLOT_BYTES = 256;

/**
 * A title slot of exactly 256 bytes with its line break: `{"type":"title",
 * "v":1,"title":…,"source":…,"updatedAt":…,"pad":…}`, with no `source` when
 * none is given.
 */
export function titleSlot(
  options: { title?: string; source?: "user" | "auto"; updatedAt?: number } = {},
): string {
  const fields = (pad: string) => ({
    type: "title",
    v: 1,
    title: options.title ?? "",
    ...(options.source === undefined ? {} : { source: options.source }),
    updatedAt: iso(options.updatedAt ?? NOW - HOUR),
    pad,
  });
  const unpadded = Buffer.byteLength(line(fields("")));
  if (unpadded > SLOT_BYTES) throw new Error("The title is too long for the slot.");
  return line(fields(" ".repeat(SLOT_BYTES - unpadded)));
}

/** The header, the second line, with fields Oh My Pi writes that are dropped, each holding a private word. */
export function header(options: { id?: string; cwd?: string; version?: number; at?: number } = {}) {
  return line({
    type: "session",
    version: options.version ?? 3,
    id: options.id ?? SESSION_ID,
    timestamp: iso(options.at ?? NOW - HOUR),
    cwd: options.cwd ?? CWD,
    title: PRIVATE_TITLE,
    titleSource: "auto",
    parentSession: PRIVATE_PATH,
    previousSessionFiles: [PRIVATE_PATH],
    additionalDirectories: [`${HOME}/PRIVATE_PATH`],
    providerPromptCacheKey: "PRIVATE_PATH-key",
  });
}

let entryNumber = 0;

/** The fields every entry begins with, in Oh My Pi's order. */
function base(type: string, at: number, options: { id?: string; runtime?: boolean }) {
  entryNumber += 1;
  return {
    type,
    id: options.id ?? `a${String(entryNumber).padStart(7, "0")}`,
    parentId: entryNumber === 1 ? null : `a${String(entryNumber - 1).padStart(7, "0")}`,
    timestamp: iso(at),
    ...(options.runtime === false
      ? {}
      : {
          runtime: {
            version: "19.0.0",
            label: PRIVATE_LABEL,
            commit: "0abc",
            branch: PRIVATE_BRANCH,
          },
        }),
  };
}

/** A message entry of a role, whose message holds a private word, and for a tool's result its call after its role. */
export function message(
  role: string,
  options: { at?: number; id?: string; runtime?: boolean; callId?: string } = {},
): string {
  const at = options.at ?? NOW - MINUTE;
  const text = role === "assistant" ? PRIVATE_REPLY : PRIVATE_PROMPT;
  return line({
    ...base("message", at, options),
    message: {
      role,
      ...(role === "toolResult"
        ? { toolCallId: options.callId ?? "call-1", toolName: "bash" }
        : {}),
      content: [{ type: "text", text }],
      ...(role === "assistant"
        ? { stopReason: "stop", errorMessage: PRIVATE_REPLY }
        : { timestamp: at }),
    },
  });
}

/** A `custom` entry, `customType` second and `data` third, as Oh My Pi writes one. */
export function custom(
  customType: string,
  data: unknown,
  options: { at?: number; id?: string } = {},
) {
  const at = options.at ?? NOW - MINUTE;
  const { type, ...rest } = base("custom", at, options);
  return line({ type, customType, data, ...rest });
}

/** The line written just before a tool runs, with a private command and intent. */
export function toolStart(
  toolName: string,
  startedAt: number = NOW - MINUTE,
  options: { callId?: string; at?: number } = {},
): string {
  return custom(
    "tool_execution_start",
    {
      toolCallId: options.callId ?? "call-1",
      toolName,
      startedAt: iso(startedAt),
      args: { command: PRIVATE_ARGS, path: PRIVATE_PATH },
      intent: PRIVATE_INTENT,
    },
    { at: options.at ?? startedAt },
  );
}

/** The line written before a tool's approval prompt opens, with a private reason unless none is given. */
export function approvalRequest(
  requestedAt: number = NOW - MINUTE,
  options: { callId?: string; parentId?: string; reason?: string | null; toolName?: string } = {},
): string {
  const reason = options.reason === undefined ? PRIVATE_REASON : options.reason;
  return custom(
    "tool_approval_requested",
    {
      toolCallId: options.callId ?? "call-1",
      ...(options.parentId === undefined ? {} : { parentToolCallId: options.parentId }),
      toolName: options.toolName ?? "bash",
      approvalMode: "always-ask",
      ...(reason === null ? {} : { reason }),
      requestedAt: iso(requestedAt),
    },
    { at: requestedAt },
  );
}

/** The line written when that wait ends, with a private reason when it was not approved. */
export function approvalEnd(
  resolvedAt: number = NOW - MINUTE,
  options: { callId?: string; approved?: boolean } = {},
): string {
  const approved = options.approved ?? true;
  return custom(
    "tool_approval_resolved",
    {
      toolCallId: options.callId ?? "call-1",
      toolName: "bash",
      approved,
      ...(approved ? {} : { reason: PRIVATE_REASON }),
      resolvedAt: iso(resolvedAt),
    },
    { at: resolvedAt },
  );
}

/** The line written when Oh My Pi stops, with a pending call that holds private words. */
export function sessionExit(
  kind: "normal" | "signal" | "fatal" | "process_exit" = "normal",
  recordedAt: number = NOW - MINUTE,
  reason = kind === "fatal" ? "uncaught_exception" : kind === "signal" ? "sigterm" : "dispose",
): string {
  return custom(
    "session_exit",
    {
      reason,
      kind,
      recordedAt: iso(recordedAt),
      pendingToolCalls: [
        {
          toolCallId: "call-1",
          toolName: "bash",
          args: { command: PRIVATE_ARGS },
          intent: PRIVATE_INTENT,
        },
      ],
    },
    { at: recordedAt },
  );
}

/** A provider's refusal of a reply. */
export const refusal = (at: number = NOW - MINUTE) =>
  custom("provider_refusal", { reason: PRIVATE_REPLY }, { at });

/** Lines that say nothing of the status, each holding private words. */
export function passedLines(at: number = NOW - MINUTE): string {
  return [
    line({
      ...base("model_usage", at, {}),
      purpose: "cache-warm",
      completion: { prompt: PRIVATE_PROMPT, reply: PRIVATE_REPLY },
    }),
    line({ ...base("title_change", at, {}), title: PRIVATE_TITLE, previousTitle: PRIVATE_TITLE }),
    line({
      ...base("compaction", at, {}),
      summary: PRIVATE_SUMMARY,
      shortSummary: PRIVATE_SUMMARY,
    }),
    line({ ...base("custom_message", at, {}), customType: "note", content: PRIVATE_PROMPT }),
    line({ ...base("session_init", at, {}), systemPrompt: PRIVATE_PROMPT, task: PRIVATE_GOAL }),
    line({ ...base("mode_change", at, {}), mode: "plan", data: { goal: PRIVATE_GOAL } }),
    custom("foreign_session_import", { source: PRIVATE_PATH, file: PRIVATE_PATH }, { at }),
  ].join("");
}

/** A whole session file: its slot, its header, then these lines. */
export function sessionText(
  lines: string = message("user") + message("assistant"),
  options: {
    slot?: Parameters<typeof titleSlot>[0];
    header?: Parameters<typeof header>[0];
  } = {},
): string {
  return (
    titleSlot(options.slot ?? { title: "Fix the flaky tests", source: "auto" }) +
    header(options.header) +
    lines
  );
}

/** The lines Oh My Pi made from a Codex session: IDs `codex-<base 36>`, no `runtime`. */
export function codexLines(first = 1): string {
  return (
    message("user", { id: `codex-${first.toString(36)}`, runtime: false }) +
    message("assistant", { id: `codex-${(first + 1).toString(36)}`, runtime: false })
  );
}
