// Test fixtures only. Every id, name, path and word here is invented and
// generic. A manifest follows the shape Cline's source writes at cli-v3.0.74
// (`session/models/session-manifest.ts`), as written up in
// docs/adapters/cline.md, and nothing in it is copied from a real machine:
// Cline was not run to make it. Product code never imports this file.

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder. */
export const CLINE_DIR = `${HOME}/.cline`;
export const SESSIONS_DIR = `${CLINE_DIR}/data/sessions`;

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

/** A generic session id, as Cline makes one from the time and five characters. */
export const sessionIdOf = (n: number) => `${NOW - HOUR}_demo${n}`;

/** Words written where a prompt, a setting or a secret goes. None may leave the manifest. */
export const PRIVATE_WORDS = "placeholder words that must never leave the manifest";

/** Written where a system prompt goes, in `metadata`, as a hub session's can be. */
export const PRIVATE_SYSTEM_PROMPT = "placeholder system prompt that must never be kept";

/** What the conversation file holds. Agent Lookout never opens it. */
export const PLACEHOLDER = "Placeholder. Agent Lookout never opens this file.";

export const STARTED_AT = NOW - HOUR;

const iso = (at: number) => new Date(at).toISOString();

/** A manifest's path, for a session in the folder the adapter looks in. */
export const manifestFile = (id: string, dir = SESSIONS_DIR) => `${dir}/${id}/${id}.json`;

/** A session's messages file, which holds the whole conversation. */
export const messagesFile = (id: string, dir = SESSIONS_DIR) => `${dir}/${id}/${id}.messages.json`;

/**
 * A manifest as Cline writes one for a session in a turn, with every field its
 * schema has but `ended_at`, which `ended` adds, as an object a test can change.
 * Keys are in the order Cline's schema gives them.
 */
export function manifestFields(id: string, changes: Record<string, unknown> = {}) {
  return {
    version: 1,
    session_id: id,
    source: "cli",
    pid: PID,
    started_at: iso(STARTED_AT),
    exit_code: null,
    status: "running",
    interactive: true,
    provider: "demo-provider",
    model: "demo-model",
    cwd: PROJECT,
    workspace_root: PROJECT,
    team_name: "team-demo",
    enable_tools: true,
    enable_spawn: true,
    enable_teams: false,
    prompt: PRIVATE_WORDS,
    metadata: {
      title: "demo task",
      systemPrompt: PRIVATE_SYSTEM_PROMPT,
      totalCost: 0.25,
      usage: { inputTokens: 100, outputTokens: 20 },
      checkpointEnabled: true,
    },
    messages_path: messagesFile(id),
    compaction_path: `${SESSIONS_DIR}/${id}/${id}.compaction.json`,
    ...changes,
  };
}

/** A manifest as text, as Cline writes it: two spaces and a line break at the end. */
export function manifestText(id: string, changes: Record<string, unknown> = {}): string {
  return `${JSON.stringify(manifestFields(id, changes), null, 2)}\n`;
}

/** The fields of a session that ended, as Cline writes them. */
export const ended = (status: string, at: number) => ({
  status,
  ended_at: iso(at),
  exit_code: status === "failed" ? 1 : 0,
});

/** When the fixture's imported session was imported. */
export const IMPORTED_AT = NOW - HOUR;

/** The mark an import leaves in `metadata`, for a session from another tool. */
export const importMark = {
  tool: "codex",
  sourceSessionId: "demo-source-session",
  sourcePath: `${HOME}/.codex/sessions/demo-rollout.jsonl`,
  importedAt: iso(IMPORTED_AT),
  sourceProvider: "demo-provider",
  sourceModel: "demo-model",
};

/**
 * The fields of a session as Cline's desktop app leaves it once it is imported
 * (`services/session-import/service.ts`): `completed`, with pid 0, the times it
 * had in the other tool, and the mark.
 */
export const imported = {
  source: "desktop",
  pid: 0,
  started_at: iso(IMPORTED_AT - 3 * HOUR),
  ...ended("completed", IMPORTED_AT - 2 * HOUR),
  metadata: {
    title: "demo imported task",
    sessionHistoryOrigin: { mode: "import", trigger: "codex" },
    importedFrom: importMark,
  },
};

/** The same session in its first turn after a resume: the mark and pid 0 stay, `ended_at` goes. */
export const resumed = { ...imported, status: "running", ended_at: undefined, exit_code: null };
