// How Claude Code's own vocabulary maps onto the session model. Pure, so the
// collector today and a browser or desktop host later share one mapping.

import type { SessionStatus, Surface, WaitingReason } from "../sessions/session.ts";

/** The status fields of one entry, straight from `claude agents --json` or the registry. */
export interface ClaudeCodeStatusFields {
  /** Present while the process is alive: `busy`, `waiting` or `idle`. */
  status?: unknown;
  /** Background sessions only: `working`, `blocked`, `done`, `failed` or `stopped`. */
  state?: unknown;
  /** Present while waiting, for example `permission prompt`. */
  waitingFor?: unknown;
}

/**
 * Where an entry was read. The registry writes one live status the feed never
 * prints, so the two are mapped with slightly different tables.
 */
export type ClaudeCodeOrigin = "feed" | "registry";

export interface MappedStatus {
  status: SessionStatus;
  waitingReason?: WaitingReason;
  waitingDetail?: string;
}

const LIVE_STATUS = new Map<string, SessionStatus>([
  ["busy", "working"],
  ["waiting", "needs-you"],
  ["idle", "idle"],
]);

/**
 * Live statuses only the registry holds. The registry has a fourth status,
 * `shell`, which `claude agents --json` prints as `busy` (checked against
 * Claude Code 2.1.283), so a session read from the registry in that status is
 * working too. This is an assumption about an undocumented file and may need
 * to change.
 */
const REGISTRY_LIVE_STATUS = new Map<string, SessionStatus>([["shell", "working"]]);

const BACKGROUND_STATE = new Map<string, SessionStatus>([
  ["working", "working"],
  ["blocked", "needs-you"],
  ["done", "finished"],
  ["stopped", "finished"],
  ["failed", "failed"],
]);

const WAITING_REASON = new Map<string, WaitingReason>([
  ["permission prompt", "permission"],
  ["input needed", "question"],
]);

function liveStatusOf(status: unknown, origin: ClaudeCodeOrigin): SessionStatus | undefined {
  if (typeof status !== "string") return undefined;
  const known = LIVE_STATUS.get(status);
  if (known !== undefined || origin === "feed") return known;
  return REGISTRY_LIVE_STATUS.get(status);
}

/**
 * Maps a Claude Code entry to a session status.
 *
 * `status` describes a live process and `state` describes a background session.
 * A process that is busy or waiting is doing exactly that, so those two win
 * over any `state`. A process that is merely idle says the least: when the
 * background `state` reports that the job is done, stopped, failed or blocked,
 * that is the news, and it wins over `idle`. Without this a background job that
 * failed while its process stayed around would be shown as idle, and nothing
 * would ever be shown as finished or failed.
 *
 * A value we do not recognise becomes "unknown" rather than a guess.
 */
export function mapClaudeCodeStatus(
  fields: ClaudeCodeStatusFields,
  origin: ClaudeCodeOrigin = "feed",
): MappedStatus {
  const live = liveStatusOf(fields.status, origin);
  const background =
    typeof fields.state === "string" ? BACKGROUND_STATE.get(fields.state) : undefined;

  const backgroundSaysMore = background !== undefined && background !== "working";
  const status =
    live === "idle" && backgroundSaysMore ? background : (live ?? background ?? "unknown");

  if (status !== "needs-you") return { status };
  return { status, ...mapClaudeCodeWaitingFor(fields.waitingFor) };
}

/**
 * Maps `waitingFor` to a reason and keeps the vendor's wording as the detail.
 * A waiting session that does not say why gets the reason "other" and no detail.
 */
export function mapClaudeCodeWaitingFor(waitingFor: unknown): {
  waitingReason: WaitingReason;
  waitingDetail?: string;
} {
  if (typeof waitingFor !== "string" || waitingFor.trim() === "") {
    return { waitingReason: "other" };
  }
  return {
    waitingReason: WAITING_REASON.get(waitingFor.trim().toLowerCase()) ?? "other",
    waitingDetail: waitingFor,
  };
}

/**
 * Whether a registry entry of this `kind` is a session a person would look for.
 *
 * The registry also holds Claude Code's helper processes (`daemon`,
 * `daemon-worker`). `claude agents --json` lists only the kinds `interactive`
 * and `bg`, so the registry is read for the same two. An entry that names no
 * kind is kept, because nothing says it is a helper. This is an assumption
 * about an undocumented file and may need to change.
 */
export function isClaudeCodeSessionKind(kind: unknown): boolean {
  if (kind === undefined || kind === null || kind === "") return true;
  return kind === "interactive" || kind === "bg";
}

/**
 * Maps the registry's `entrypoint` to a surface. Any entrypoint other than the
 * VS Code extension and the desktop app is a terminal. No entrypoint at all means
 * the surface is not known, which is different from knowing it is a terminal.
 */
export function mapClaudeCodeSurface(entrypoint: unknown): Surface {
  if (typeof entrypoint !== "string" || entrypoint === "") return "unknown";
  if (entrypoint === "claude-vscode") return "vscode";
  if (entrypoint === "claude-desktop") return "desktop";
  return "terminal";
}

/**
 * The deep link that jumps to a session in its own app. Only the VS Code
 * extension documents a link to an existing session, so other surfaces get none.
 */
export function claudeCodeOpenLink(
  surface: Surface,
  sessionId: string | null | undefined,
): string | undefined {
  if (surface !== "vscode" || !sessionId) return undefined;
  return `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
}
