// Test fixtures only. Every id, name, path and word here is invented and
// generic. Each file follows the shapes docs/adapters/kiro-cli.md describes,
// taken from Kiro's documentation and from open-source readers of its files,
// and nothing in it is copied from a real computer or from another program's
// files: Kiro CLI was not run to make it. Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const KIRO_HOME = `${HOME}/.kiro`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The process the fixture's sessions are open in, unless a test gives another. */
export const PID = 52001;

/** The folder the fixture's sessions were started in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** A V3 bucket, a name of sixteen hex digits as one reader saw them. */
export const BUCKET = "0a1b2c3d4e5f6a7b";

/** A generic UUID. */
export const uuidOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A V3 session's ID, its folder's name. */
export const v3IdOf = (n: number) => `sess_${uuidOf(n)}`;

/** When the fixture's sessions were made. */
export const CREATED_AT = NOW - HOUR;

/** When their locks were taken. */
export const LOCKED_AT = NOW - 30 * MINUTE;

/** Words written where a prompt, a reply, a question or a tool's input goes. None may leave a file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the file";

const iso = (at: number) => new Date(at).toISOString();

export const sessionsDir = (home = KIRO_HOME) => `${home}/sessions`;

export const v3Folder = (id: string, home = KIRO_HOME, bucket = BUCKET) =>
  `${sessionsDir(home)}/${bucket}/${id}`;

export const v3Paths = (id: string, home = KIRO_HOME, bucket = BUCKET) => ({
  folder: v3Folder(id, home, bucket),
  header: `${v3Folder(id, home, bucket)}/session.json`,
  log: `${v3Folder(id, home, bucket)}/messages.jsonl`,
  lock: `${v3Folder(id, home, bucket)}/.lock`,
});

export const v2Paths = (id: string, home = KIRO_HOME) => ({
  header: `${sessionsDir(home)}/cli/${id}.json`,
  log: `${sessionsDir(home)}/cli/${id}.jsonl`,
  lock: `${sessionsDir(home)}/cli/${id}.lock`,
});

/** A V3 `session.json`. */
export function v3Header(id: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    title: "Tidy the demo tests",
    workspacePaths: [PROJECT],
    createdAt: iso(CREATED_AT),
    lastModifiedAt: iso(NOW - MINUTE),
    modelId: "demo-model",
    ...changes,
  });
}

/**
 * A V2 `<uuid>.json`. Its title is the first prompt word for word, as V2
 * writes it, and `session_created_reason` is `subagent`, which V2 writes for a
 * top-level session too.
 */
export function v2Header(id: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: id,
    cwd: PROJECT,
    title: PRIVATE_WORDS,
    session_created_reason: "subagent",
    created_at: iso(CREATED_AT),
    updated_at: iso(NOW - MINUTE),
    session_state: { version: "v1", conversation_metadata: { user_turn_metadatas: [] } },
    ...changes,
  });
}

/** A lock's body. */
export function lockText(pid = PID, startedAt: number | string = LOCKED_AT): string {
  return JSON.stringify({
    pid,
    started_at: typeof startedAt === "number" ? iso(startedAt) : startedAt,
  });
}

let rowNumber = 0;

/** One V3 row, with a newline. */
export function v3Row(payload: Record<string, unknown>, at = NOW - 10 * MINUTE): string {
  rowNumber += 1;
  return `${JSON.stringify({ id: `row-${rowNumber}`, timestamp: iso(at), payload })}\n`;
}

export const v3User = (at?: number) =>
  v3Row({ type: "user", content: PRIVATE_WORDS, documents: [], images: [] }, at);

export const v3TurnStart = (at?: number, execution = "exec-1") =>
  v3Row({ type: "turn_start", executionId: execution }, at);

export const v3Assistant = (at?: number) =>
  v3Row({ type: "assistant", content: PRIVATE_WORDS, executionId: "exec-1" }, at);

export const v3TurnEnd = (at?: number, execution = "exec-1") =>
  v3Row({ type: "turn_end", stopReason: "end_turn", executionId: execution }, at);

export const v3Pending = (toolCallId: string, at?: number, interactionType = "tool_approval") =>
  v3Row(
    {
      type: "pending_interaction",
      interactionType,
      toolCallId,
      question: PRIVATE_WORDS,
      options: [{ optionId: "accept" }, { optionId: "reject" }],
      executionId: "exec-1",
      consentRound: 1,
    },
    at,
  );

export const v3Resolved = (toolCallId: string, at?: number) =>
  v3Row(
    {
      type: "interaction_resolved",
      toolCallId,
      outcome: "selected",
      selectedOption: "accept",
      executionId: "exec-1",
    },
    at,
  );

export const v3Note = (at?: number) => v3Row({ type: "agent_note", content: PRIVATE_WORDS }, at);

/** One V2 record, with a newline. */
export function v2Record(kind: string, data: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: "v1", kind, data })}\n`;
}

export const v2Prompt = (at = NOW - 10 * MINUTE) =>
  v2Record("Prompt", {
    content: [{ kind: "text", data: PRIVATE_WORDS }],
    meta: { timestamp: at / 1000 },
  });

export const v2Reply = () =>
  v2Record("AssistantMessage", { content: [{ kind: "text", data: PRIVATE_WORDS }] });

export const v2ToolUse = () =>
  v2Record("AssistantMessage", {
    content: [
      { kind: "text", data: PRIVATE_WORDS },
      { kind: "toolUse", data: { name: "demo_tool", input: { words: PRIVATE_WORDS } } },
    ],
  });

export const v2ToolResults = () =>
  v2Record("ToolResults", {
    content: [{ kind: "toolResult", data: { status: "success", content: PRIVATE_WORDS } }],
  });

export const v2Clear = () => `${JSON.stringify({ version: "v1", kind: "Clear" })}\n`;
