import { CLAUDE_CODE_OPEN_LINK } from "@core/mapping/claudeCodeMapping";
import {
  SOURCE_STATE_LABEL,
  surfaceLabel,
  type Session,
  type SessionEvent,
  type SessionStatus,
  type SourceId,
  type TerminalApp,
} from "@core/sessions/session";
import { formatDuration } from "@dashboard/lib/format";

// The core keeps the surfaces' words, which an email uses too. An app that is
// not known has none, and is left out wherever the app would be named. It keeps
// the words for a source's state too, which `agent-lookout mcp` says.
export { SOURCE_STATE_LABEL, surfaceLabel };

/** The words the interface uses for each status. Colour is never the only signal. */
export const STATUS_LABEL: Record<SessionStatus, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  finished: "Finished",
  failed: "Failed",
  unknown: "Unknown",
};

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

/** The words before the length of a wait that is over, in the event log. */
export const STOPPED_WAITING = "stopped waiting after";

/** What the log says of a session Agent Lookout stopped, at the person's request. */
export const STOPPED_HERE = "was stopped from Agent Lookout";

/** What the log says of a permission prompt answered from Agent Lookout, at the person's request. */
export const ALLOWED_HERE = "had a request allowed from Agent Lookout";
export const DENIED_HERE = "had a request denied from Agent Lookout";

/**
 * What happened, as the words that follow the session's name in the event log.
 *
 * A move out of "needs you" says how long the wait lasted when the page holds
 * the event that began it, `waitedMs`. Without that it is said as the move it
 * was, since a length that was not seen is not guessed.
 */
export function eventPhrase(
  event: Pick<SessionEvent, "kind" | "from" | "to" | "decision">,
  waitedMs: number | null = null,
): string {
  if (event.kind === "appeared") return "appeared";
  if (event.kind === "ended") return "ended";
  if (event.kind === "stopped") return STOPPED_HERE;
  if (event.kind === "answered") return event.decision === "deny" ? DENIED_HERE : ALLOWED_HERE;
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
  "claude-code": CLAUDE_CODE_OPEN_LINK,
};

/** The session's Jump address when it is one this source is known to build, or null. */
export function safeJumpLink(session: Pick<Session, "source" | "links">): string | null {
  const link: unknown = session.links.open;
  if (typeof link !== "string") return null;
  const allowed = Object.hasOwn(JUMP_LINK, session.source) ? JUMP_LINK[session.source] : undefined;
  return allowed?.test(link) ? link : null;
}

/**
 * How Jump reaches a session, with where it goes in words for its label.
 *
 * link      an address the browser opens, which hands the session to its own app
 * tmux      a pane the collector selects when the page asks it to
 * terminal  a tab of Terminal or iTerm2 the collector brings forward when the page asks it to
 */
export type JumpWay =
  | { by: "link"; href: string; where: string }
  | { by: "tmux"; where: string }
  | { by: "terminal"; app: TerminalApp; where: string };

/**
 * The way Jump reaches this session, or null when it has none and gets no
 * button. A session with a safe link keeps it. Otherwise a session the
 * collector found in a tmux pane is reached there, "tmux, work:2.1", and one
 * it found in a tab of Terminal or iTerm2 there, "Terminal".
 */
export function jumpWay(
  session: Pick<Session, "source" | "surface" | "links" | "jump">,
): JumpWay | null {
  const href = safeJumpLink(session);
  if (href !== null) {
    return { by: "link", href, where: surfaceLabel(session.surface) ?? "its app" };
  }
  if (session.jump?.kind === "tmux") return { by: "tmux", where: `tmux, ${session.jump.place}` };
  if (session.jump?.kind === "terminal") {
    return { by: "terminal", app: session.jump.app, where: session.jump.place };
  }
  return null;
}
