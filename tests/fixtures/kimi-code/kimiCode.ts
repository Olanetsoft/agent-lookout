// Test fixtures only. Every id, name, path and word here is invented and
// generic. Each file follows the shape Kimi Code's source writes at 2.4.1, as
// written up in docs/adapters/kimi-code.md, and nothing in it is copied from a
// real machine: Kimi Code was not run to make it. Product code never imports this
// file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const KIMI_HOME = `${HOME}/.kimi-code`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The process the fixture's sessions run in, unless a test gives another. */
export const PID = 41001;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** The bucket of that folder, in the form `encodeWorkDirKey` gives one. */
export const BUCKET = "wd_demo-project_0a1b2c3d4e5f";

/** A generic session id, as Kimi Code makes one. */
export const sessionIdOf = (n: number) =>
  `session_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** When the fixture's sessions were made. */
export const CREATED_AT = NOW - HOUR;

/** When they were last written. */
export const UPDATED_AT = NOW - 5 * MINUTE;

/** When their locks were taken. */
export const LOCKED_AT = NOW - MINUTE;

/** Words written where a prompt, an answer or a tool's input goes. None may leave a file. */
export const PRIVATE_WORDS = "placeholder words that must never leave the file";

export const sessionFolder = (id: string, home = KIMI_HOME, bucket = BUCKET) =>
  `${home}/sessions/${bucket}/${id}`;

export const indexFile = (home = KIMI_HOME) => `${home}/session_index.jsonl`;

export const stateFile = (id: string, home = KIMI_HOME) => `${sessionFolder(id, home)}/state.json`;

export const lockFile = (id: string, home = KIMI_HOME) => `${home}/locks/sessions/${id}.lock`;

export const wireFile = (id: string, home = KIMI_HOME) =>
  `${sessionFolder(id, home)}/agents/main/wire.jsonl`;

/** The line Kimi Code appends to the index when it makes a session. */
export function indexLine(id: string, changes: Record<string, unknown> = {}): string {
  const line = { sessionId: id, sessionDir: sessionFolder(id), workDir: PROJECT, ...changes };
  return `${JSON.stringify(line)}\n`;
}

/** The line Kimi Code appends to the index when it deletes a session. */
export const deletedLine = (id: string) => `${JSON.stringify({ sessionId: id, deleted: true })}\n`;

/**
 * A `state.json` as Kimi Code writes one after a first turn, with the first
 * prompt as its title, as an object a test can change.
 */
export function stateFields(id: string, changes: Record<string, unknown> = {}) {
  return {
    id,
    version: 2,
    cwd: PROJECT,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    archived: false,
    agents: { main: { homedir: `${sessionFolder(id)}/agents/main`, type: "main" } },
    custom: {},
    title: PRIVATE_WORDS,
    titleKind: "replaceable",
    lastPrompt: PRIVATE_WORDS,
    lastTurnReason: "completed",
    isCustomTitle: false,
    ...changes,
  };
}

/** A `state.json` as text, as Kimi Code writes it. */
export function stateText(id: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify(stateFields(id, changes), null, 2);
}

/** A lock as text, as Kimi Code writes it, with every field it has. */
export function lockText(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    token: `${PID}:00000000-0000-4000-8000-000000000000`,
    pid: PID,
    hostname: "demo-host",
    startedAt: LOCKED_AT,
    clientIdentity: "kimi_code_cli",
    clientDisplayName: "Kimi Code CLI",
    ...changes,
  });
}

/** An event file's first line. */
export const wireStart = (at = CREATED_AT) =>
  `${JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: at })}\n`;

/** A line of what was said, as Kimi Code writes every other record. */
export const wirePrompt = (at = LOCKED_AT) =>
  `${JSON.stringify({
    type: "turn.prompt",
    agentId: "main",
    input: [{ type: "text", text: PRIVATE_WORDS }],
    origin: "user",
    time: at,
  })}\n`;

/** The line Kimi Code writes as it asks for an approval or an answer. */
export function wireAsked(
  id: string,
  kind: string,
  at: number,
  changes: Record<string, unknown> = {},
): string {
  return `${JSON.stringify({
    type: "interaction.request",
    agentId: "main",
    id,
    kind,
    toolCallId: "call_demo",
    request: { toolName: "demo-tool", action: PRIVATE_WORDS, display: { detail: PRIVATE_WORDS } },
    time: at,
    ...changes,
  })}\n`;
}

/** The line Kimi Code writes as it is answered. */
export const wireAnswered = (id: string, at: number) =>
  `${JSON.stringify({
    type: "interaction.resolved",
    agentId: "main",
    id,
    response: { decision: "approved", feedback: PRIVATE_WORDS },
    time: at,
  })}\n`;
