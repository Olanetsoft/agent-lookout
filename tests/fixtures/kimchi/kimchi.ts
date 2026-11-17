// Test fixtures only. Every id, name, path and word here is invented and
// generic. A session file follows the shape Kimchi's source writes at v1.35.0,
// through Pi's coding agent at 1.3.0 (`packages/coding-agent/src/core/
// session-manager.ts`), and the shape of the two lines Kimchi writes itself to
// mark a session as its own (`src/extensions/agents/manager/session-file.ts`
// and `src/extensions/ferment-v2/evaluator.ts`), as written up in
// docs/adapters/kimchi.md. Nothing in it is copied from a real machine: Kimchi
// was not run to make it. Product code never imports this file.

import { line, PRIVATE_WORDS, sessionIdOf } from "@tests/fixtures/pi/pi";

export {
  conversationLines,
  DAY,
  HOUR,
  line,
  MINUTE,
  NOW,
  PRIVATE_ARGUMENTS,
  PRIVATE_SYSTEM_PROMPT,
  PRIVATE_WORDS,
  SECOND,
  sessionIdOf,
} from "@tests/fixtures/pi/pi";

export const HOME = "/Users/example";

/** Where the adapter looks when nothing names another folder: Kimchi's agent folder, then `sessions`. */
export const AGENT_DIR = `${HOME}/.config/kimchi/harness`;
export const SESSIONS_DIR = `${AGENT_DIR}/sessions`;

/** The folder the fixture's sessions run in. */
export const PROJECT = `${HOME}/code/demo-project`;

/** The folder Kimchi keeps that folder's sessions in, with `/` as `-`, between `--` and `--`. */
export const projectFolderOf = (cwd: string, dir = SESSIONS_DIR) =>
  `${dir}/--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

export const PROJECT_FOLDER = projectFolderOf(PROJECT);

/** Midday UTC on 1 October 2026, less an hour. */
export const STARTED_AT = Date.UTC(2026, 9, 1, 11, 0, 0);

export const SESSION_ID = sessionIdOf(1);

const iso = (at: number) => new Date(at).toISOString();

/** A session file's path, named as Pi names one: its header's time, then its id. */
export const sessionPath = (id: string, dir = PROJECT_FOLDER, at = STARTED_AT) =>
  `${dir}/${iso(at).replace(/[:.]/g, "-")}_${id}.jsonl`;

/** A side chat's file, which Kimchi keeps in a folder of the session's own (`side-chat/store.ts`). */
export const sideChatPath = (mainId: string, id: string, dir = PROJECT_FOLDER) =>
  `${dir}/side-chats/${mainId}/${id}.jsonl`;

/** A session's header, as an object a test can change. Keys are in the order Pi writes them. */
export function headerFields(id: string, changes: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: iso(STARTED_AT),
    cwd: PROJECT,
    ...changes,
  };
}

/** A header that names the file it came from, as a subagent's, a branch's and a side chat's do. */
export const childHeader = (id: string, changes: Record<string, unknown> = {}) =>
  line(headerFields(id, { parentSession: sessionPath(SESSION_ID), ...changes }));

/**
 * The second line of a subagent's file, as `prepareAgentSessionFile` writes it
 * with the header in one write, keys in its order.
 */
export const subagentMarkerLine = (agentType = "explore") =>
  line({
    type: "custom",
    id: "0190a1b2-c3d4-7e5f-8a9b-00000000aaaa",
    parentId: null,
    timestamp: iso(STARTED_AT),
    customType: "kimchi:subagent-session",
    data: { type: agentType },
  });

/**
 * The second line of a file Ferment's evaluator writes, through Pi's
 * `appendCustomEntry`, keys in its order.
 */
export const internalMarkerLine = () =>
  line({
    type: "custom",
    customType: "kimchi:internal-session",
    data: { kind: "ferment-evaluator" },
    id: "a1b2c3d4",
    parentId: null,
    timestamp: iso(STARTED_AT),
  });

/** A `custom` line of another kind, as one of Kimchi's extensions writes. */
export const otherCustomLine = (customType = "work_identity") =>
  line({
    type: "custom",
    customType,
    data: { note: PRIVATE_WORDS },
    id: "b2c3d4e5",
    parentId: null,
    timestamp: iso(STARTED_AT),
  });

/**
 * The name Kimchi gives a session after its first turn, from the person's
 * first messages (`session-name.ts`), so it holds their words.
 */
export const nameLine = (name = PRIVATE_WORDS.slice(0, 50)) =>
  line({
    type: "session_info",
    id: "c3d4e5f6",
    parentId: "d4e5f6a7",
    timestamp: iso(STARTED_AT + 60_000),
    name,
  });

/** What Kimchi's shutdown marker writes when a run ends (`shutdown-marker.ts`). */
export const agentEndLine = () =>
  line({
    type: "custom",
    customType: "agent_end",
    data: { timestamp: STARTED_AT + 120_000 },
    id: "e5f6a7b8",
    parentId: "f6a7b8c9",
    timestamp: iso(STARTED_AT + 120_000),
  });
