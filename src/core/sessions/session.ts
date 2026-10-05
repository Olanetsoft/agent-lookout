// The session model. Adapters produce these types and the dashboard consumes them.
// Adding a field is fine. Renaming or removing one is not.

export type SourceId = "claude-code" | "codex";

export type Surface = "terminal" | "vscode" | "desktop" | "cloud" | "browser" | "unknown";

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

export interface Session {
  /** Stable across polls: `${source}:${vendor session id, or pid when there is none}`. */
  id: string;
  source: SourceId;
  surface: Surface;
  /** Display name. Falls back to the project folder name, then to the id. */
  name: string;
  /** Absolute working directory, when known. */
  cwd: string | null;
  /** Last path segment of cwd. */
  project: string | null;
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

export type SourceState = "ok" | "searching" | "unavailable" | "error";

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
