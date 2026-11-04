// Test fixtures only. Every id, name, path and word here is invented and
// generic. A session file follows the shape Pi's source writes at v1.5.0
// (`packages/coding-agent/src/core/session-manager.ts`), as written up in
// docs/adapters/pi.md, and nothing in it is copied from a real machine: Pi was
// not run to make it. Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const AGENT_DIR = `${HOME}/.pi/agent`;
export const SESSIONS_DIR = `${AGENT_DIR}/sessions`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** The folder Pi keeps that folder's sessions in, with `/` as `-`, between `--` and `--`. */
export const projectFolderOf = (cwd: string, dir = SESSIONS_DIR) =>
  `${dir}/--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export const PROJECT_FOLDER = projectFolderOf(PROJECT);

export const STARTED_AT = NOW - HOUR;

/** A generic session id, in the UUID shape Pi gives one. */
export const sessionIdOf = (n: number) => `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, "0")}`;

export const SESSION_ID = sessionIdOf(1);

/** Words written where a prompt, a reply or a tool's output goes. None may leave the file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the session file";

/** Written where a tool's arguments go. */
export const PRIVATE_ARGUMENTS = "placeholder arguments that must never leave the session file";

/** Written where a system prompt goes. */
export const PRIVATE_SYSTEM_PROMPT = "placeholder system prompt that must never leave the file";

const iso = (at: number) => new Date(at).toISOString();

/** A session file's path, named as Pi names one: its header's time, then its id. */
export const sessionPath = (id: string, dir = PROJECT_FOLDER, at = STARTED_AT) =>
  `${dir}/${iso(at).replace(/[:.]/g, "-")}_${id}.jsonl`;

/** A session's header, as an object a test can change. Keys are in the order Pi writes them. */
export function headerFields(id: string, changes: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: iso(STARTED_AT),
    cwd: PROJECT,
    parentSession: `${PROJECT_FOLDER}/earlier-session.jsonl`,
    ...changes,
  };
}

/** One line of a file, as Pi writes each. */
export const line = (fields: unknown) => `${JSON.stringify(fields)}\n`;

/** What `/name`, `--name`, the session picker, `set_session_name` and an extension write. */
export const nameLine = (name: string, at = NOW - 30 * MINUTE) =>
  line({
    type: "session_info",
    id: "a0b1c2d3",
    parentId: "b1c2d3e4",
    timestamp: iso(at),
    name,
  });

/** Lines of every kind that holds what was said, with placeholder words where it goes. */
export function conversationLines(at = STARTED_AT): string {
  const base = (type: string, id: string) => ({
    type,
    id,
    parentId: "c2d3e4f5",
    timestamp: iso(at),
  });
  const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 };
  const message = (id: string, fields: Record<string, unknown>) =>
    line({ ...base("message", id), message: { ...fields, timestamp: at } });
  return [
    line({ ...base("model_change", "d3e4f5a6"), provider: "demo-provider", modelId: "demo-model" }),
    line({ ...base("thinking_level_change", "e4f5a6b7"), thinkingLevel: "high" }),
    message("f5a6b7c8", {
      role: "system",
      content: "",
      sections: { preamble: PRIVATE_SYSTEM_PROMPT },
    }),
    message("a6b7c8d9", { role: "user", content: PRIVATE_WORDS }),
    message("b7c8d9e0", {
      role: "assistant",
      content: [
        { type: "text", text: PRIVATE_WORDS },
        {
          type: "toolCall",
          id: "call_1",
          name: "bash",
          arguments: { command: PRIVATE_ARGUMENTS },
        },
      ],
      provider: "demo-provider",
      model: "demo-model",
      usage,
      stopReason: "toolUse",
    }),
    message("c8d9e0f1", {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: PRIVATE_WORDS }],
      isError: false,
    }),
    line({
      ...base("compaction", "d9e0f1a2"),
      summary: PRIVATE_WORDS,
      firstKeptEntryId: "a6b7c8d9",
      tokensBefore: 50000,
    }),
    line({ ...base("custom_message", "e0f1a2b3"), customType: "demo", content: PRIVATE_WORDS }),
  ].join("");
}

/** A whole session file: its header, then the lines given, or a conversation. */
export const sessionText = (id: string, rest: string = conversationLines()) =>
  line(headerFields(id)) + rest;
