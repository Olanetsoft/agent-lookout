// The session model. Adapters produce these types and the dashboard consumes them.
// Adding a field is fine. Renaming or removing one is not.

/**
 * Where sessions come from. `status-files` is not one tool: it is a folder in
 * which any agent writes a small file for each of its sessions.
 */
export type SourceId = "claude-code" | "codex" | "status-files";

/**
 * Every value of each kind below, as a list each type is made from, so a reader
 * of the API that checks a value against the list cannot fall behind the type:
 * a value added here is one the page, `agent-lookout status` and the MCP server
 * all accept.
 */
export const SURFACES = ["terminal", "vscode", "desktop", "cloud", "browser", "unknown"] as const;

export type Surface = (typeof SURFACES)[number];

/**
 * What each surface is called, in the dashboard and in an email. A surface that
 * is not known has no name: wherever the app would be named, it is left out.
 */
const SURFACE_LABEL: Record<Exclude<Surface, "unknown">, string> = {
  terminal: "Terminal",
  vscode: "VS Code",
  desktop: "Desktop app",
  cloud: "Cloud",
  browser: "Browser",
};

/** The app's name, "VS Code", or null when the app is not known. */
export function surfaceLabel(surface: Surface): string | null {
  return surface === "unknown" ? null : SURFACE_LABEL[surface];
}

/** Every status, in the order they are listed: the ones that need a person come first. */
export const SESSION_STATUSES = [
  "needs-you",
  "working",
  "idle",
  "finished",
  "failed",
  "unknown",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const WAITING_REASONS = ["permission", "question", "other"] as const;

export type WaitingReason = (typeof WAITING_REASONS)[number];

/** The terminal apps whose tabs the collector can bring forward, as they are named. */
export const TERMINAL_APPS = ["Terminal", "iTerm2"] as const;

export type TerminalApp = (typeof TERMINAL_APPS)[number];

/**
 * A place the collector can take the person to itself, when the dashboard asks
 * it to with `POST /api/jump`: a tmux pane, or a tab of Terminal or iTerm2.
 *
 * It names the place in words, for a label, and holds nothing a command could
 * be made of. What the collector acts on, the pane or the tab's terminal device
 * it found, never leaves it.
 */
export type JumpTarget =
  | {
      kind: "tmux";
      /** The session, window and pane as tmux writes them, for example `work:2.1`. */
      place: string;
    }
  | {
      kind: "terminal";
      app: TerminalApp;
      /** The app, in words for the button: `Terminal` or `iTerm2`. */
      place: string;
    };

/** The two ways the collector can stop a session it lists, when the person presses Stop. */
export const STOP_WAYS = ["signal", "background"] as const;

export type StopWay = (typeof STOP_WAYS)[number];

/**
 * That the collector can stop a session, when the dashboard asks it to with
 * `POST /api/sessions/stop`, and how:
 *
 * - `signal`: it ends the session's process with SIGTERM, as for a session in
 *   a terminal or in VS Code.
 * - `background`: it runs `claude stop` with the background job's id, since a
 *   background job runs under Claude Code's own supervisor.
 *
 * It holds nothing a command could be made of. What the collector acts on,
 * the process, its start time and the job's id, never leaves it.
 */
export interface StopOffer {
  how: StopWay;
}

/**
 * Where a session's folder stands in git: the branch it has checked out, or,
 * when it has none checked out, the commit it is on, as the first seven
 * characters of its ID. One or the other, never both.
 *
 * The collector reads it from the repository's `HEAD` file, for the sessions of
 * every source alike. The branch is cleaned and cut to a length as any text
 * from a file is, and is shown as plain text.
 *
 * With it comes the repository the folder belongs to, which the worktrees of
 * one repository share: see `GitRepository`.
 */
export interface GitHead {
  branch?: string;
  commit?: string;
  /** The repository, whenever the collector could tell it. */
  repository?: GitRepository;
  /**
   * The pull request on github.com for the branch, with
   * `AGENT_LOOKOUT_PULL_REQUESTS=on` only: see `PullRequest`.
   */
  pullRequest?: PullRequest;
}

/** Where a pull request stands: open, open as a draft, merged, or closed without merging. */
export const PULL_REQUEST_STATES = ["open", "draft", "merged", "closed"] as const;

export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/**
 * How a pull request's checks stand, from every check on its latest commit:
 * failing when any failed, pending when none failed and some have not
 * finished, passing when each one passed or was skipped, and none when it has
 * no checks at all.
 */
export const CHECKS_STATES = ["failing", "pending", "passing", "none"] as const;

export type ChecksState = (typeof CHECKS_STATES)[number];

/** A pull request's checks: how they stand, and how many are in each state. */
export interface PullRequestChecks {
  state: ChecksState;
  /** Checks that passed, were skipped or ended neutral. */
  passing: number;
  /** Checks that failed, timed out, were cancelled or need an action. */
  failing: number;
  /** Checks that have not finished. */
  pending: number;
}

/**
 * The pull request for a session's branch on github.com, as the person's own
 * GitHub CLI, gh, gave it. The collector asks only with
 * `AGENT_LOOKOUT_PULL_REQUESTS=on`, only for a repository whose remote is on
 * github.com, and not for the repository's default branch.
 */
export interface PullRequest {
  number: number;
  /** Its title, from GitHub, cleaned and cut as a session's name is, and shown as plain text. */
  title: string;
  state: PullRequestState;
  checks: PullRequestChecks;
  /**
   * Its page, `https://github.com/<owner>/<repository>/pull/<number>`, which
   * the collector builds from the remote and the number, not from GitHub's text.
   */
  url: string;
}

/**
 * The repository a session's folder belongs to, worked out from the `.git` the
 * branch was read through and, for a worktree, the `commondir` beside its
 * `HEAD`. A worktree belongs to the repository it was made from. A submodule,
 * and a repository inside another, is a repository of its own.
 */
export interface GitRepository {
  /**
   * What sessions are grouped by, and never shown: a hash of the path of the
   * repository's own git folder, the same for every worktree of it, so that
   * path is not sent where a session's own folder is not already.
   */
  id: string;
  /**
   * Its name, such as "storefront", cleaned as a session's name is: its main
   * working folder's, or for a worktree the one its git folder gives.
   */
  name: string;
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
  /**
   * Present when cwd is in a git repository whose `HEAD` could be read: the
   * branch or commit, the repository, and with `AGENT_LOOKOUT_PULL_REQUESTS=on`
   * the branch's pull request. See `GitHead`.
   */
  git?: GitHead;
  status: SessionStatus;
  /** Present only when status is "needs-you". */
  waitingReason?: WaitingReason;
  /** The vendor's own wording, shown as a secondary detail. */
  waitingDetail?: string;
  /**
   * What the session is asking, in a line or two: "Run: npm test", "Edit:
   * src/app.ts", or the question it put to the person. Present only when status
   * is "needs-you" and source is "claude-code", and only when the last message
   * of the session's transcript says. Plain text, cleaned and cut to 200
   * characters by the collector. It lives as long as the wait does: nothing
   * that is stored or remembered past the wait keeps it.
   */
  waitingText?: string;
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
  /** Present when the collector can stop the session, on the person's request: see `StopOffer`. */
  stop?: StopOffer;
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
export const SOURCE_STATES = ["ok", "searching", "unavailable", "not-set-up", "error"] as const;

export type SourceState = (typeof SOURCE_STATES)[number];

/** Each state in words, on the Sources view and in `agent-lookout mcp`. */
export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  ok: "Watching",
  searching: "Searching",
  unavailable: "Not found",
  "not-set-up": "Not set up",
  error: "Not working",
};

/**
 * One thing a source reads or runs, as a label and a value: for example
 * "Command" and "claude agents --json --all", or "Registry read" and
 * "every 2 seconds". The dashboard shows each as a row.
 */
export interface SourceFact {
  label: string;
  value: string;
}

/**
 * The things a source can tell about its sessions, and do to them, in the
 * order the Sources view and docs/GUIDE.md list them: the last, Stop, is what
 * Agent Lookout can do to a session when the person presses Stop. The branch
 * is not among them: it is read from each session's folder, the same way for
 * every source.
 */
export const CAPABILITIES = [
  "working-and-idle",
  "needs-you",
  "finished",
  "failed",
  "names",
  "jump",
  "quiet-for",
  "stop",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** What each capability is called, at the head of its column. */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  "working-and-idle": "Working and idle",
  "needs-you": "Needs you",
  finished: "Finished",
  failed: "Failed",
  names: "Names",
  jump: "Jump",
  "quiet-for": "Quiet for",
  stop: "Stop",
};

/** How much of one thing a source can tell: all of it, none of it, or some. */
export const CAPABILITY_LEVELS = ["yes", "no", "partly"] as const;

export type CapabilityLevel = (typeof CAPABILITY_LEVELS)[number];

/** The word for each level, in a cell. */
export const CAPABILITY_LEVEL_LABEL: Record<CapabilityLevel, string> = {
  yes: "Yes",
  no: "No",
  partly: "Partly",
};

/**
 * What a source can tell of one thing. Anything short of yes carries one short
 * plain sentence saying why, so a signal that never shows is not read as good news.
 */
export type CapabilityCell = { level: "yes" } | { level: "no" | "partly"; reason: string };

/** What a source can tell of every capability. Each adapter declares its own, once. */
export type SourceCapabilities = Readonly<Record<Capability, CapabilityCell>>;

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
  /**
   * What the source's agent can report at all, whatever state the source is in:
   * fixed for each adapter, which declares it. The Sources view draws its table
   * of what each agent can report from this alone.
   */
  capabilities?: SourceCapabilities;
  checkedAt: number;
}

export interface SessionsSnapshot {
  generatedAt: number;
  sources: SourceHealth[];
  sessions: Session[];
}

/**
 * What an event says happened:
 *
 * appeared        a session was found
 * status-changed  its status changed
 * ended           it left the list
 * stopped         Agent Lookout stopped it, when the person pressed Stop or
 *                 ended it with the sessions left running. Its leaving the
 *                 list is an `ended` event of its own, at the next poll
 *
 * A reader drops an event of a kind it does not know, so a later kind never
 * reads as one of these.
 */
export const EVENT_KINDS = ["appeared", "status-changed", "ended", "stopped"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The kinds that say what a session's status was, which the timeline and the waits are drawn from. */
export const STATUS_EVENT_KINDS = [
  "appeared",
  "status-changed",
  "ended",
] as const satisfies readonly EventKind[];

/** Whether an event says what a session's status was, rather than what was done to it. */
export function isStatusEvent(event: Pick<SessionEvent, "kind">): boolean {
  return (STATUS_EVENT_KINDS as readonly EventKind[]).includes(event.kind);
}

/** Who did what an event says was done to a session: Agent Lookout, at the person's request. */
export const EVENT_ACTORS = ["agent-lookout"] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];
export const EVENT_SEVERITIES = ["advisory", "warning", "critical"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export interface SessionEvent {
  id: string;
  at: number;
  sessionId: string;
  sessionName: string;
  kind: EventKind;
  from?: SessionStatus;
  to?: SessionStatus;
  severity: EventSeverity;
  /** For a `stopped` event: who stopped it, which is always Agent Lookout, at the person's request. */
  by?: EventActor;
}

export interface HistoryPoint {
  at: number;
  needsYou: number;
  working: number;
  idle: number;
  total: number;
}

/**
 * The session without what it is asking, for anything that is kept from one
 * poll to the next: the text belongs to the wait it was read for, and is not
 * remembered past it. The same session is handed back when it has none.
 */
export function withoutWaitingText<T extends Pick<Session, "waitingText">>(session: T): T {
  if (session.waitingText === undefined) return session;
  const { waitingText: _forgotten, ...rest } = session;
  return rest as T;
}

/**
 * The agent a session belongs to, in its own plain name: a status file names
 * its own, such as "Night Shift", and every other source is its own agent,
 * named as the source is, "Claude Code" or "Codex". Null when neither is known.
 * The page, the emails and posts, `agent-lookout status` and the MCP server all
 * name an agent by this rule.
 */
export function agentName(
  session: Pick<Session, "source" | "agent">,
  sources: readonly Pick<SourceHealth, "id" | "label">[],
): string | null {
  return session.agent ?? sources.find((source) => source.id === session.source)?.label ?? null;
}
