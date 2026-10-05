// How Codex's session files map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// Codex records when a turn starts and when it ends, and nothing about a wait
// for approval: those events are never written to its files. So a Codex session
// is working, idle or finished here, and never "needs-you". See
// docs/adapters/codex.md for where each value comes from.

import type { SessionStatus, Surface } from "../sessions/session.ts";

/**
 * Whether Codex has the session open, from its folder of open-session locks:
 * true or false when the lock says, "unknown" when it cannot (see `codexLiveness`).
 */
export type CodexLiveness = boolean | "unknown";

export interface CodexStatusFields {
  /**
   * The `payload.type` of the last turn line in the session's file.
   *
   * `null` means the whole file was read and holds no turn line: a session whose
   * first turn has not begun. Anything that is not a string or `null`, such as
   * `undefined` for a file whose last turn line lies beyond the scan limit, is
   * not known.
   */
  lastTurn: unknown;
  live: CodexLiveness;
}

/** Turn lines that say a turn is under way. `turn_started` is the alias Codex also accepts. */
const TURN_UNDER_WAY = new Set(["task_started", "turn_started"]);

/** Turn lines that say a turn is over, whether it completed or was stopped. */
const TURN_OVER = new Set(["task_complete", "turn_complete", "turn_aborted"]);

/**
 * Maps what a Codex session's file and its lock say to a session status.
 *
 * | Last turn line                              | Open, or not known | Not open |
 * | ------------------------------------------- | ------------------ | -------- |
 * | `task_started`, `turn_started`              | working            | finished |
 * | `task_complete`, `turn_complete`, `turn_aborted` | idle          | finished |
 * | none yet, the whole file read               | idle               | finished |
 * | anything else, or not found                 | unknown            | unknown  |
 *
 * It never returns "needs-you": Codex does not write approval waits to its
 * files, so a session waiting for approval is in a turn that has started, and
 * shows as working. A turn line it does not recognise becomes "unknown" rather
 * than a guess, whatever the lock says.
 */
export function mapCodexStatus(fields: CodexStatusFields): SessionStatus {
  const { lastTurn, live } = fields;
  let open: SessionStatus;
  if (lastTurn === null) {
    open = "idle";
  } else if (typeof lastTurn !== "string") {
    return "unknown";
  } else if (TURN_UNDER_WAY.has(lastTurn)) {
    open = "working";
  } else if (TURN_OVER.has(lastTurn)) {
    open = "idle";
  } else {
    return "unknown";
  }
  return live === false ? "finished" : open;
}

/** The first Codex release that keeps a lock file for each open session. */
export const WRITER_LOCKS_SINCE = [0, 155, 0] as const;

/** `major.minor.patch`, with an optional pre-release after `-` and build after `+`. */
const VERSION =
  /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/**
 * Whether the Codex that created a session keeps a lock file while it has a
 * session open, from the `cli_version` its `session_meta` line records.
 *
 * Only a release of 0.155.0 or later does. A pre-release of 0.155.0, a build
 * from source (which calls itself 0.0.0), and a missing or unreadable version
 * do not count: with no lock to expect, a missing one says nothing.
 */
export function keepsWriterLocks(cliVersion: unknown): boolean {
  if (typeof cliVersion !== "string") return false;
  const match = VERSION.exec(cliVersion);
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (const [index, since] of WRITER_LOCKS_SINCE.entries()) {
    const part = parts[index] as number;
    if (part !== since) return part > since;
  }
  // Exactly 0.155.0: a pre-release comes before the release.
  return match[4] === undefined;
}

/**
 * Whether Codex has a session open, from its lock and the version that created
 * it. `true` when its lock is there. When the lock folder is there and the lock
 * is not, `false` only for a session made by a Codex that keeps locks: an older
 * Codex writing into the same folder never makes one, so for its sessions the
 * missing lock is "unknown". With no lock folder at all, every session is "unknown".
 */
export function codexLiveness(fields: {
  lockFolder: boolean;
  locked: boolean;
  cliVersion: unknown;
}): CodexLiveness {
  if (!fields.lockFolder) return "unknown";
  if (fields.locked) return true;
  return keepsWriterLocks(fields.cliVersion) ? false : "unknown";
}

/**
 * The turn ids Codex gives the turns it copies in when the Codex desktop app
 * imports another agent's past session (`external-import-turn-1` and so on, in
 * codex-rs/external-agent-migration/src/sessions/export.rs). A turn Codex runs
 * itself has a UUID.
 */
const IMPORTED_TURN_ID = /^external-import-turn-\d{1,9}$/;

/** Whether a turn line's `turn_id` says the turn was imported from another agent, not run by Codex. */
export function isImportedCodexTurn(turnId: unknown): boolean {
  return typeof turnId === "string" && IMPORTED_TURN_ID.test(turnId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `originator` the Codex desktop app records. The app records its sessions
 * with `source` `vscode`, as the IDE extension does, so only this tells them apart.
 */
export const CODEX_DESKTOP_ORIGINATOR = "Codex Desktop";

/**
 * Maps where a Codex session was started to a surface. The Codex desktop app
 * is known by its `originator`. Otherwise the `source` decides: the terminal
 * app and `codex exec` are terminals, the IDE extension is VS Code, and the
 * ChatGPT desktop app records itself as `{"custom":"chatgpt"}`. Anything else,
 * including no source at all, is not known.
 */
export function mapCodexSurface(source: unknown, originator?: unknown): Surface {
  if (originator === CODEX_DESKTOP_ORIGINATOR) return "desktop";
  if (source === "cli" || source === "exec") return "terminal";
  if (source === "vscode") return "vscode";
  if (isRecord(source) && source.custom === "chatgpt") return "desktop";
  return "unknown";
}

/**
 * Sources that are not sessions a person started: subagents a session spawned,
 * Codex's own internal threads, and threads run for another program through
 * `codex mcp-server` or the app-server.
 */
const NOT_A_SESSION_SOURCE = new Set(["subagent", "internal", "mcp"]);

/** `thread_source` values that belong only to subagents and internal threads. */
const NOT_A_SESSION_THREAD = new Set(["subagent", "guardian_review", "memory_consolidation"]);

/**
 * Whether a Codex thread is a session a person would look for.
 *
 * Subagents, internal threads and threads run for another program are left out,
 * as is any thread that names a parent: each belongs to a session that is
 * already listed. A thread whose source is missing or unfamiliar is kept,
 * because nothing says it is a helper.
 */
export function isCodexSessionSource(
  source: unknown,
  meta: { parentThreadId?: unknown; threadSource?: unknown } = {},
): boolean {
  if (typeof meta.parentThreadId === "string" && meta.parentThreadId !== "") return false;
  if (typeof meta.threadSource === "string" && NOT_A_SESSION_THREAD.has(meta.threadSource)) {
    return false;
  }
  if (typeof source === "string") return !NOT_A_SESSION_SOURCE.has(source);
  if (isRecord(source)) return !Object.keys(source).some((kind) => NOT_A_SESSION_SOURCE.has(kind));
  return true;
}
