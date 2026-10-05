// The session model. Adapters produce these types and the dashboard consumes them.
// Adding a field is fine. Renaming or removing one is not.

/**
 * Where sessions come from. `status-files` is not one tool: it is a folder in
 * which any agent writes a small file for each of its sessions.
 */
export type SourceId = "claude-code" | "codex" | "status-files";

export type Surface = "terminal" | "vscode" | "desktop" | "cloud" | "browser" | "unknown";

/** What each surface is called, in the dashboard and in an email. */
export const SURFACE_LABEL: Record<Surface, string> = {
  terminal: "Terminal",
  vscode: "VS Code",
  desktop: "Desktop app",
  cloud: "Cloud",
  browser: "Browser",
  unknown: "Unknown app",
};

export type SessionStatus = "needs-you" | "working" | "idle" | "finished" | "failed" | "unknown";

export type WaitingReason = "permission" | "question" | "other";

/**
 * A place the collector can take the person to itself, when the dashboard asks
 * it to with `POST /api/jump`. Today that is a tmux pane.
 *
 * It names the place in words, for a label, and holds nothing a command could
 * be made of. What the collector acts on, the pane it found, never leaves it.
 */
export interface JumpTarget {
  kind: "tmux";
  /** The session, window and pane as tmux writes them, for example `work:2.1`. */
  place: string;
}

/**
 * Where a session's folder stands in git: the branch it has checked out, or,
 * when it has none checked out, the commit it is on, as the first seven
 * characters of its ID. One or the other, never both.
 *
 * The collector reads it from the repository's `HEAD` file, for the sessions of
 * every source alike. The branch is cleaned and cut to a length as any text
 * from a file is, and is shown as plain text.
 */
export interface GitHead {
  branch?: string;
  commit?: string;
}

export interface Session {
  /** Stable across polls: `${source}:${vendor session id, or pid when there is none}`. */
  id: string;
  source: SourceId;
  /**
   * The agent's own name, in plain text, for a source whose sessions belong to
   * many agents: a status file names the agent that wrote it, such as
   * "Night Shift". Shown wherever a session's agent is named. Left out, the
   * agent is the source's own label.
   */
  agent?: string;
  surface: Surface;
  /** Display name. Falls back to the project folder name, then to the id. */
  name: string;
  /** Absolute working directory, when known. */
  cwd: string | null;
  /** Last path segment of cwd. */
  project: string | null;
  /** Present when cwd is in a git repository whose `HEAD` could be read: see `GitHead`. */
  git?: GitHead;
  status: SessionStatus;
  /** Present only when status is "needs-you". */
  waitingReason?: WaitingReason;
  /** The vendor's own wording, shown as a secondary detail. */
  waitingDetail?: string;
  /** Epoch milliseconds. */
  startedAt: number | null;
  /**
   * When the status last changed, when the source reports it. For a session
   * that needs the person it must not move while the wait goes on: a later
   * time on a session still waiting is read as a new wait.
   */
  statusSince: number | null;
  /**
   * When the agent last wrote to the file this session is read from, in epoch
   * milliseconds: the file's own modified time, and nothing read from inside
   * it. Present only for a source whose file is written as the session works,
   * and only when the time could be right. It is a measurement, not a status:
   * a working session that has written nothing for a while may be waiting for
   * an approval its agent does not record, or may have hung, and the page says
   * how long, not which.
   */
  lastWriteAt?: number;
  pid?: number;
  /** Whether the process still exists, when a pid is known. */
  alive?: boolean;
  /** Deep links. `open` jumps to the session in its own app. */
  links: { open?: string };
  /** Present when the collector can take the person to the session: see `JumpTarget`. */
  jump?: JumpTarget;
  /** True when the session has been idle longer than the stale threshold. */
  stale: boolean;
}

/**
 * - `ok`: read.
 * - `searching`: the first read has not finished.
 * - `unavailable`: the tool is not on this computer.
 * - `not-set-up`: nothing to read until the person sets it up, as with a
 *   folder of status files that has not been made. Not a problem, and not news
 *   outside the Sources view.
 * - `error`: the sessions could not be read.
 */
export type SourceState = "ok" | "searching" | "unavailable" | "not-set-up" | "error";

/**
 * One thing a source reads or runs, as a label and a value: for example
 * "Command" and "claude agents --json --all", or "Registry read" and
 * "every 2 seconds". The dashboard shows each as a row.
 */
export interface SourceFact {
  label: string;
  value: string;
}

export interface SourceHealth {
  id: SourceId;
  /** Plain label, for example "Claude Code". */
  label: string;
  state: SourceState;
  /** Plain-language detail: which way of reading is in force, or what went wrong. Never a stack trace. */
  detail?: string;
  /** What the source reads and runs, and how often, so nothing has to be picked out of `detail`. */
  watching?: SourceFact[];
  /** One plain sentence saying what the person can do about a problem, when the collector knows. */
  advice?: string;
  /**
   * Names the way the sessions were read, for a source that has more than one,
   * such as Claude Code's registry alone while its command fails. Two ways of
   * reading do not see exactly the same sessions, so answers are compared only
   * with answers read the same way.
   */
  basis?: string;
  checkedAt: number;
}

export interface SessionsSnapshot {
  generatedAt: number;
  sources: SourceHealth[];
  sessions: Session[];
}

export type EventKind = "appeared" | "status-changed" | "ended";
export type EventSeverity = "advisory" | "warning" | "critical";

export interface SessionEvent {
  id: string;
  at: number;
  sessionId: string;
  sessionName: string;
  kind: EventKind;
  from?: SessionStatus;
  to?: SessionStatus;
  severity: EventSeverity;
}

export interface HistoryPoint {
  at: number;
  needsYou: number;
  working: number;
  idle: number;
  total: number;
}
