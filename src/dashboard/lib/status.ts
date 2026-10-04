import type {
  Session,
  SessionEvent,
  SessionStatus,
  SourceId,
  SourceState,
  Surface,
  WaitingReason,
} from "@core/session";
import { formatDuration } from "@dashboard/lib/format";

/** The words the interface uses for each status. Colour is never the only signal. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  finished: "Finished",
  failed: "Failed",
  unknown: "Unknown",
};

export const SURFACE_LABEL: Record<Surface, string> = {
  terminal: "Terminal",
  vscode: "VS Code",
  desktop: "Desktop app",
  cloud: "Cloud",
  browser: "Browser",
  unknown: "Unknown app",
};

const WAITING_LABEL: Record<WaitingReason, string> = {
  permission: "Waiting for permission",
  question: "Asked you a question",
  other: "Waiting for you",
};

/** Why a session needs the person, in plain words. */
export function waitingLabel(session: Pick<Session, "waitingReason">): string {
  return WAITING_LABEL[session.waitingReason ?? "other"];
}

/**
 * The vendor's own wording, kept as a secondary detail. It is left out when it
 * only repeats what the plain label already says.
 */
export function waitingDetail(
  session: Pick<Session, "waitingReason" | "waitingDetail">,
): string | null {
  const detail = session.waitingDetail?.trim();
  if (!detail) return null;
  if (session.waitingReason === "permission" && /^permission prompt$/i.test(detail)) return null;
  if (session.waitingReason === "question" && /^input needed$/i.test(detail)) return null;
  return detail;
}

export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  ok: "Watching",
  searching: "Searching",
  unavailable: "Not found",
  error: "Not working",
};

/** The words before the length of a wait that is over, in the event log. */
export const STOPPED_WAITING = "stopped waiting after";

/**
 * What happened, as the words that follow the session's name in the event log.
 *
 * A move out of "needs you" says how long the wait lasted when the page holds
 * the event that began it, `waitedMs`. Without that it is said as the move it
 * was, since a length that was not seen is not guessed.
 */
export function eventPhrase(
  event: Pick<SessionEvent, "kind" | "from" | "to">,
  waitedMs: number | null = null,
): string {
  if (event.kind === "appeared") return "appeared";
  if (event.kind === "ended") return "ended";
  if (event.from === "needs-you" && event.to !== "needs-you" && waitedMs !== null) {
    return `${STOPPED_WAITING} ${formatDuration(waitedMs)}`;
  }
  switch (event.to) {
    case "needs-you":
      return "started waiting";
    case "working":
      return "started working";
    case "idle":
      return "went idle";
    case "finished":
      return "finished";
    case "failed":
      return "failed";
    default:
      return "changed status";
  }
}

/**
 * The only addresses a Jump button may open: one exact shape per source.
 *
 * Session data comes from other tools, so a link is never trusted for being a
 * link. Anything that is not the address this source is known to build is
 * refused: a web page, a file, another app's scheme, another extension of the
 * same editor. A source with no entry here gets no Jump button.
 *
 * Codex has none: it documents no address that opens one of its sessions.
 */
const JUMP_LINK: Partial<Record<SourceId, RegExp>> = {
  // The session id is as `encodeURIComponent` leaves it, and nothing may follow it.
  "claude-code": /^vscode:\/\/anthropic\.claude-code\/open\?session=[A-Za-z0-9\-_.!~*'()%]{1,200}$/,
};

/** The session's Jump address when it is one this source is known to build, or null. */
export function safeJumpLink(session: Pick<Session, "source" | "links">): string | null {
  const link: unknown = session.links.open;
  if (typeof link !== "string") return null;
  const allowed = Object.hasOwn(JUMP_LINK, session.source) ? JUMP_LINK[session.source] : undefined;
  return allowed?.test(link) ? link : null;
}
