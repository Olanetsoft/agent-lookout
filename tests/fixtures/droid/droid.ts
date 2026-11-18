// Test fixtures only. Every id, name, path and word here is invented and
// generic. A session file follows the shape Factory's Droid SDKs read, the
// Python droid-sdk 0.5.0 (`src/droid_sdk/_high_level/discovery.py` and its
// test `tests/test_v5_discovery.py`) and the TypeScript @factory/droid-sdk
// 0.11.0 (`SessionStartEventSchema` and `SessionSettingsFileSchema` in its npm
// files), as written up in docs/adapters/droid.md. Nothing in it is copied from
// a real machine: Droid was not run to make it. Product code never imports
// this file.

export const HOME = "/Users/example";

/** Droid's folder, and its sessions folder, where the adapter looks when nothing names another. */
export const FACTORY_DIR = `${HOME}/.factory`;
export const SESSIONS = `${FACTORY_DIR}/sessions`;

/** Midday UTC on 1 October 2026. */
export const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The folder the fixture's sessions run in. */
export const CWD = `${HOME}/code/demo-project`;

/** The folder Droid keeps that folder's sessions in: `-`, then the path with each `/` as `-`. */
export const PROJECT_FOLDER_NAME = "-Users-example-code-demo-project";
export const PROJECT_FOLDER = `${SESSIONS}/${PROJECT_FOLDER_NAME}`;

/** A generic session ID, in the UUID shape Droid gives one. */
export const sessionIdOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SESSION_ID = sessionIdOf(1);

/** A session's file, in a project folder or loose in the sessions folder. */
export const sessionPath = (id: string = SESSION_ID, dir: string = PROJECT_FOLDER) =>
  `${dir}/${id}.jsonl`;

/** The settings file beside a session's file. */
export const settingsPath = (id: string = SESSION_ID, dir: string = PROJECT_FOLDER) =>
  `${dir}/${id}.settings.json`;

/** Written where the owner goes, which Factory's own test sets to an email address. */
export const OWNER = "owner@example.com";

/** Written where the title goes, which Droid makes from the first prompt. None may leave the file. */
export const PRIVATE_TITLE = "placeholder title that must never leave the session file";

/** Written where a prompt or a reply goes. */
export const PRIVATE_PROMPT = "placeholder prompt that must never leave the session file";

/** Written where a tag goes, which a person can write. */
export const PRIVATE_TAG = "placeholder tag that must never leave the settings file";

/** One line of a file, as JSON with a line break. */
export const line = (fields: unknown) => `${JSON.stringify(fields)}\n`;

/**
 * A session's first line, as an object a test can change. It always names a
 * `sessionId` other than its file's, which is never the session's ID.
 */
export function sessionStartFields(changes: Record<string, unknown> = {}) {
  return {
    type: "session_start",
    sessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    title: PRIVATE_TITLE,
    owner: OWNER,
    cwd: CWD,
    ...changes,
  };
}

/** A session's first line, with its line break. */
export const sessionStart = (changes: Record<string, unknown> = {}) =>
  line(sessionStartFields(changes));

/** A message line, as Factory's test writes one, with placeholder words where the text goes. */
export const messageLine = (text: string = PRIVATE_PROMPT) =>
  line({
    type: "message",
    message: { role: "user", content: [{ type: "text", text }], visibility: "user_only" },
  });

/** A whole session file: its first line, then a message. */
export const sessionText = (changes: Record<string, unknown> = {}, rest: string = messageLine()) =>
  sessionStart(changes) + rest;

/** A settings file, with fields Droid keeps beside `archivedAt`, each with placeholder values. */
export function settings(fields: Record<string, unknown> = {}) {
  return JSON.stringify({
    tags: [{ name: PRIVATE_TAG }],
    model: "demo-model",
    tokenUsage: { inputTokens: 100, outputTokens: 20, factoryCredits: 1 },
    ...fields,
  });
}
