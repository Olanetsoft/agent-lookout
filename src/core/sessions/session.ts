// The session model. Adapters produce these types and the dashboard consumes them.
// Adding a field is fine. Renaming or removing one is not.

/**
 * Another machine's Agent Lookout, read over SSH: `remote:` and the name
 * `AGENT_LOOKOUT_REMOTES` gives the machine, such as `remote:devbox`.
 */
export type RemoteSourceId = `remote:${string}`;

/**
 * Where sessions come from. `status-files` is not one tool: it is a folder in
 * which any agent writes a small file for each of its sessions. Nor is another
 * machine: its sessions belong to the agents on it, which each session names.
 */
export type SourceId = "claude-code" | "codex" | "status-files" | RemoteSourceId;

/** What every remote source's id begins with. */
export const REMOTE_SOURCE_PREFIX = "remote:";

/**
 * The longest name a machine may have. A name is letters, digits and dashes,
 * and short enough to sit beside a session's name on a phone.
 */
export const MAX_MACHINE_NAME_LENGTH = 24;

const MACHINE_NAME = new RegExp(`^[A-Za-z0-9][A-Za-z0-9-]{0,${MAX_MACHINE_NAME_LENGTH - 1}}$`);

/**
 * Whether text is a machine's name as `AGENT_LOOKOUT_REMOTES` allows one:
 * letters, digits and dashes, starting with a letter or a digit.
 */
export function isMachineName(value: unknown): value is string {
  return typeof value === "string" && MACHINE_NAME.test(value);
}

/** The source of the sessions read from the machine of this name: `remote:devbox`. */
export function remoteSourceId(machine: string): RemoteSourceId {
  return `${REMOTE_SOURCE_PREFIX}${machine}`;
}

/** Whether a source is another machine's, rather than an agent tool on this one. */
export function isRemoteSource(id: string): id is RemoteSourceId {
  return id.startsWith(REMOTE_SOURCE_PREFIX);
}

/**
 * The other machine a session's id names, "devbox" for
 * `remote:devbox:claude-code:…`, or null for a session on this machine. An
 * event, a wait or a row of the timeline carries the session's id and name
 * alone, and this is how each says which machine, so that two sessions of
 * the same name, one here and one there, can be told apart.
 */
export function machineInId(sessionId: string): string | null {
  if (!sessionId.startsWith(REMOTE_SOURCE_PREFIX)) return null;
  const rest = sessionId.slice(REMOTE_SOURCE_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) return null;
  const name = rest.slice(0, colon);
  return isMachineName(name) ? name : null;
}

/** "demo-local on devbox": a session's name and the other machine it runs on, in plain words. */
export function nameOnMachine(name: string, machine: string | null | undefined): string {
  return machine === null || machine === undefined ? name : `${name} on ${machine}`;
}

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

/** The two answers Agent Lookout can give a permission prompt, when the person presses Allow or Deny. */
export const ANSWER_DECISIONS = ["allow", "deny"] as const;

export type AnswerDecision = (typeof ANSWER_DECISIONS)[number];

/**
 * Why only Deny is offered for a request:
 *
 * edit              an edit, a new file or a notebook edit: the change itself is not shown
 * too-long          what it asks is too long to show whole: over 4,000 characters or 40 lines
 * hidden-characters it holds characters that cannot be shown as they are
 * not-yes-or-no     it is answered with more than yes or no, such as a plan or a question
 * right-to-left     a command holding right-to-left letters, which can redraw it in another order
 * blank-lines       more than two blank lines in a row, which could push what follows out of sight
 */
export const DENY_ONLY_REASONS = [
  "edit",
  "too-long",
  "hidden-characters",
  "not-yes-or-no",
  "right-to-left",
  "blank-lines",
] as const;

export type DenyOnlyReason = (typeof DENY_ONLY_REASONS)[number];

/** One input of a tool, as text, for a request that is not a shell command. */
export interface AskInput {
  name: string;
  value: string;
}

/**
 * A permission request a Claude Code session is waiting on, held by Agent
 * Lookout while the session waits, so the person can answer it from the
 * dashboard. It comes from the Agent Lookout plugin's hook, which Claude Code
 * runs before it asks, and only while that hook is held.
 *
 * It shows the whole of what Allow would allow: for Bash the full command,
 * every line of it, and for any other tool its name and every input. When
 * that cannot be shown whole, or the tool edits a file, only Deny is offered.
 * It is plain text, kept in memory for as long as the request is held, and is
 * never written to disk or copied into an event, the history, an email, a
 * webhook post or an MCP answer, as `waitingText` is not.
 */
export interface PermissionAsk {
  /** Agent Lookout's own id for the request, so an answer can only reach the request it was shown. */
  requestId: string;
  /** The tool's name, as Claude Code gives it: `Bash`, `Write`, `mcp__docs__search`. */
  tool: string;
  /** For Bash: the whole command, every line, as Claude Code would run it. */
  command?: string;
  /** For Bash: what the command is for, in the agent's words, on one line. */
  description?: string;
  /** For any other tool: each of its inputs, in full while Allow is offered. */
  inputs?: AskInput[];
  /** Whether Allow is offered. Deny always is. */
  allow: boolean;
  /** Why only Deny is offered, when Allow is not. */
  denyOnly?: DenyOnlyReason;
  /** Present when a subagent of the session asks, rather than the session itself. */
  subagent?: true;
  /** When Agent Lookout lets the request go unanswered, in epoch milliseconds. */
  until: number;
}

/**
 * Whether Agent Lookout can answer permission prompts, for the Settings view:
 *
 * - `state`: `on` while it listens for the plugin's requests, `off` with
 *   `AGENT_LOOKOUT_ANSWER=off`, and `unavailable` when it could not listen.
 * - `plugin`: `seen` once a request has reached it since the last permission
 *   prompt it missed, `missed` when a Claude Code session waited for
 *   permission and no request reached it, which is what a session without the
 *   plugin does, and `unknown` before either.
 */
export interface AnsweringStatus {
  state: "on" | "off" | "unavailable";
  plugin: "seen" | "missed" | "unknown";
  /** While unavailable: one sentence saying why. */
  problem?: string;
  /** How long a request is held, in milliseconds, before the session's own prompt is left to decide. */
  holdMs: number;
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
  /**
   * Stable across polls: `${source}:${vendor session id, or pid when there is
   * none}`. A session on another machine has that machine's id for it after its
   * own source, `remote:devbox:claude-code:…`, so two machines' ids never clash.
   */
  id: string;
  source: SourceId;
  /**
   * The agent's own name, in plain text, for a source whose sessions belong to
   * many agents: a status file names the agent that wrote it, such as
   * "Night Shift", and a session on another machine the agent it runs in there,
   * such as "Claude Code". Shown wherever a session's agent is named. Left
   * out, the agent is the source's own label.
   */
  agent?: string;
  /**
   * The name of the other machine the session runs on, as
   * `AGENT_LOOKOUT_REMOTES` gives it, such as "devbox". Shown beside the
   * session's name. Left out, the session runs on this machine. A session on
   * another machine has no Jump, no Stop and no request to answer: those act
   * on this machine only.
   */
  machine?: string;
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
   * is "needs-you" and source is "claude-code", or is another machine's whose
   * Agent Lookout sent it, and only when the last message of the session's
   * transcript says. Plain text, cleaned and cut to 200
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
  /**
   * Present while Agent Lookout holds a permission request of the session's,
   * which the person can answer from the dashboard: see `PermissionAsk`. Only
   * for a Claude Code session on this computer waiting for permission, with
   * the plugin.
   */
  ask?: PermissionAsk;
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
 * order the Sources view and docs/GUIDE.md list them: the last two, Stop and
 * Answer, are what Agent Lookout can do to a session when the person presses
 * Stop, or Allow or Deny on a permission prompt. The branch
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
  "answer",
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
  answer: "Answer",
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

/**
 * What one agent on another machine can report, as it is seen from here: what
 * that machine's Agent Lookout says its agent can report, with no Jump, no
 * Stop and no Answer, which act on this machine only.
 */
export interface AgentCapabilities {
  /** The agent's name, "Claude Code", as the other machine gives it. */
  label: string;
  capabilities: SourceCapabilities;
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
  /**
   * What the source's agent can report at all, whatever state the source is in:
   * fixed for each adapter, which declares it. The Sources view draws its table
   * of what each agent can report from this and from `agents`.
   */
  capabilities?: SourceCapabilities;
  /**
   * For another machine's source: the machine's name, as `AGENT_LOOKOUT_REMOTES`
   * gives it, which its sessions carry as their `machine`.
   */
  machine?: string;
  /**
   * For another machine's source: what each agent there can report, as last
   * read from it. A row each in the table of what each agent can report.
   */
  agents?: AgentCapabilities[];
  checkedAt: number;
}

export interface SessionsSnapshot {
  generatedAt: number;
  sources: SourceHealth[];
  sessions: Session[];
  /** Whether permission prompts can be answered from the dashboard. Left out by a collector that cannot. */
  answering?: AnsweringStatus;
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
 * answered        Agent Lookout answered a permission prompt of the session's,
 *                 when the person pressed Allow or Deny. It holds the decision
 *                 and nothing of what was asked
 *
 * A reader drops an event of a kind it does not know, so a later kind never
 * reads as one of these.
 */
export const EVENT_KINDS = ["appeared", "status-changed", "ended", "stopped", "answered"] as const;
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
  /** For a `stopped` or `answered` event: who acted, which is always Agent Lookout, at the person's request. */
  by?: EventActor;
  /** For an `answered` event: what the person answered. */
  decision?: AnswerDecision;
}

export interface HistoryPoint {
  at: number;
  needsYou: number;
  working: number;
  idle: number;
  total: number;
}

/**
 * The session without what it is asking, `waitingText` and a held permission
 * request, `ask`, for anything that is kept from one poll to the next or sent
 * anywhere: both belong to the wait they were read for, and are not
 * remembered past it. The same session is handed back when it has neither.
 */
export function withoutWaitingText<T extends Pick<Session, "waitingText"> & { ask?: unknown }>(
  session: T,
): T {
  if (session.waitingText === undefined && session.ask === undefined) return session;
  const { waitingText: _forgotten, ask: _held, ...rest } = session;
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
