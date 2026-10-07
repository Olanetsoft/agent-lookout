// What another machine's Agent Lookout sent, as this machine shows it: its
// sessions, marked with the machine's name, and what its agents can report.
// Pure: the clock is passed in.
//
// The other machine is the person's own, but its answer is read as any answer
// from outside is. Each field is read on its own and cleaned again, a field
// that cannot be read is left out, and nothing in it can act here: a session
// on another machine has no Jump, no Stop, no request to answer and no link
// to open.

import {
  CAPABILITIES,
  isRemoteSource,
  remoteSourceId,
  SESSION_STATUSES,
  SOURCE_STATES,
  SURFACES,
  WAITING_REASONS,
  type AgentCapabilities,
  type Capability,
  type CapabilityCell,
  type GitHead,
  type Session,
  type SourceCapabilities,
  type SourceState,
} from "../../core/sessions/session.ts";
import { cut, MAX_NAME_LENGTH, sessionName, waitingText } from "../../core/text.ts";
import { plausibleTime } from "../../core/time.ts";
import { repositoryId } from "../git/repository.ts";

/** The most sessions taken from one machine. Far more than one person runs. */
export const MAX_REMOTE_SESSIONS = 500;

/**
 * The most of the other machine's sources taken, and so the most agents whose
 * capabilities are shown: Agent Lookout has three of its own, and a machine
 * that sends many more is not read for them.
 */
export const MAX_REMOTE_SOURCES = 20;

/** The longest session id taken. The other machine's own are far shorter. */
const MAX_ID_LENGTH = 512;

/** The longest folder taken. */
const MAX_PATH_LENGTH = 4_096;

/** The longest source id, agent name or reason taken. */
const MAX_WORD_LENGTH = 200;

/** One of the other machine's sources, as its card says it: its name and its state. */
export interface RemoteSource {
  label: string;
  state: SourceState;
}

/** The other machine's answer of `/api/sessions`, as this machine shows it. */
export interface RemoteSnapshot {
  sessions: Session[];
  /** Its own sources, in its order. */
  sources: RemoteSource[];
  /** What each agent there can report, for each source it found. */
  agents: AgentCapabilities[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/** Text that is already clean and short, as an id must be, or null. Never changed. */
function exact(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = cut(value, max);
  return cleaned === value ? value : null;
}

const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const REPOSITORY_ID = /^[0-9a-f]{16,64}$/;

/**
 * The branch or commit the other machine read, with its repository given an
 * id of this machine's own: a hash of the machine's name and the id it sent,
 * so a repository there is never grouped with one here that happens to have
 * the same path.
 */
function readGit(value: unknown, machine: string): GitHead | undefined {
  if (!isRecord(value)) return undefined;
  let head: GitHead;
  if (value.commit !== undefined) {
    if (value.branch !== undefined || typeof value.commit !== "string") return undefined;
    if (!COMMIT_ID.test(value.commit)) return undefined;
    head = { commit: value.commit };
  } else {
    const branch = cut(value.branch, MAX_NAME_LENGTH);
    if (branch === undefined) return undefined;
    head = { branch };
  }
  const repository = value.repository;
  if (isRecord(repository) && typeof repository.id === "string") {
    const name = sessionName(typeof repository.name === "string" ? repository.name : "");
    if (name !== undefined && REPOSITORY_ID.test(repository.id)) {
      head.repository = { id: repositoryId(`${machine}\n${repository.id}`), name };
    }
  }
  return head;
}

/**
 * One of the other machine's sessions, as one of this machine's: its id after
 * the machine's own source, `remote:devbox:claude-code:…`, its source the
 * machine's, its agent named in words as the other machine names it, and the
 * machine's name on it. What it is doing, where and since when are taken as
 * they were sent, cleaned again, and so is the other machine's word that its
 * wait was answered there. Its process, its Jump, its Stop, the permission
 * request held for it there and its link are left behind: each would act on
 * this machine.
 *
 * Null for one that cannot be told apart, and for one the other machine
 * itself read from yet another: only its own sessions are shown.
 */
function readSession(
  value: unknown,
  machine: string,
  sources: ReadonlyMap<string, string>,
  now: number,
  keepWaitingText: boolean,
): Session | null {
  if (!isRecord(value)) return null;
  const id = exact(value.id, MAX_ID_LENGTH);
  const source = exact(value.source, MAX_WORD_LENGTH);
  if (id === null || source === null) return null;
  if (isRemoteSource(source) || value.machine !== undefined) return null;

  const project = sessionName(typeof value.project === "string" ? value.project : "") ?? null;
  const status = oneOf(SESSION_STATUSES, value.status) ?? "unknown";
  // The agent as the other machine names it, by the rule `agentName` keeps:
  // the session's own, or else its source's label there.
  const agent = cut(value.agent, MAX_WORD_LENGTH) ?? sources.get(source) ?? source;
  const session: Session = {
    id: `${remoteSourceId(machine)}:${id}`,
    source: remoteSourceId(machine),
    agent,
    machine,
    surface: oneOf(SURFACES, value.surface) ?? "unknown",
    name: sessionName(typeof value.name === "string" ? value.name : "") ?? project ?? id,
    cwd: cut(value.cwd, MAX_PATH_LENGTH) ?? null,
    project,
    status,
    startedAt: plausibleTime(value.startedAt, now),
    statusSince: plausibleTime(value.statusSince, now),
    links: {},
    stale: value.stale === true,
  };

  if (status === "needs-you") {
    const reason = oneOf(WAITING_REASONS, value.waitingReason);
    if (reason) session.waitingReason = reason;
    const detail = cut(value.waitingDetail, MAX_WORD_LENGTH);
    if (detail !== undefined) session.waitingDetail = detail;
    // With what a session asks turned off on this computer, it is not shown
    // for a session there either.
    const asking = keepWaitingText ? waitingText(value.waitingText) : undefined;
    if (asking !== undefined) session.waitingText = asking;
    // Agent Lookout there answered this wait, by a press or a rule, and Claude
    // Code has not yet said what it does next. The wait is over here too. The
    // mark acts on nothing: it only keeps the wait from being told of again.
    if (value.answered === true) session.answered = true;
  }
  const lastWriteAt = plausibleTime(value.lastWriteAt, now);
  if (lastWriteAt !== null) session.lastWriteAt = lastWriteAt;
  if (typeof value.alive === "boolean") session.alive = value.alive;
  const git = readGit(value.git, machine);
  if (git) session.git = git;
  return session;
}

/** One cell of what a source can report, or null. */
function readCell(value: unknown): CapabilityCell | null {
  if (!isRecord(value)) return null;
  if (value.level === "yes") return { level: "yes" };
  const level = oneOf(["no", "partly"] as const, value.level);
  const reason = cut(value.reason, MAX_WORD_LENGTH);
  return level && reason !== undefined ? { level, reason } : null;
}

/** What acts on this computer only, and so is never offered for a session on another. */
const ACTS_HERE = ["jump", "stop", "answer"] as const satisfies readonly Capability[];

/**
 * What an agent on the other machine can report, as seen from here: what that
 * machine says, every cell of it, with Jump, Stop and Answer as no, since each
 * acts on this machine only. Those three are not read, so an older Agent
 * Lookout there that has not heard of one still has its row. Null unless
 * every other cell can be read.
 */
function readCapabilities(value: unknown, machine: string): SourceCapabilities | null {
  if (!isRecord(value)) return null;
  const read: Partial<Record<Capability, CapabilityCell>> = {};
  for (const capability of CAPABILITIES) {
    if ((ACTS_HERE as readonly Capability[]).includes(capability)) continue;
    const cell = readCell(value[capability]);
    if (!cell) return null;
    read[capability] = cell;
  }
  return {
    ...(read as Omit<SourceCapabilities, (typeof ACTS_HERE)[number]>),
    jump: { level: "no", reason: `Jump acts on this computer only, not on ${machine}.` },
    stop: { level: "no", reason: `Stop acts on this computer only, not on ${machine}.` },
    answer: { level: "no", reason: `Answer acts on this computer only, not on ${machine}.` },
  };
}

export interface RemoteSnapshotOptions {
  /**
   * Whether what a waiting session there is asking is kept. False when
   * `AGENT_LOOKOUT_WAITING_TEXT=off` is set on this computer, so a waiting
   * session there shows its reason alone, as one here does. Defaults to true.
   */
  waitingText?: boolean;
}

/**
 * The other machine's answer of `/api/sessions`, as this machine shows it, or
 * null when it is not one: no list of sessions, or no list of sources.
 *
 * Its sources are kept as their names and states, the first 20, and, for each
 * that is there, neither not found nor not set up, what its agent can report.
 * A source the other machine itself reads from yet another machine is left
 * out with that machine's sessions.
 */
export function readRemoteSnapshot(
  value: unknown,
  machine: string,
  now: number,
  options: RemoteSnapshotOptions = {},
): RemoteSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.sessions) || !Array.isArray(value.sources)) {
    return null;
  }

  const named = new Map<string, string>();
  const sources: RemoteSource[] = [];
  const agents: AgentCapabilities[] = [];
  for (const item of value.sources) {
    if (sources.length >= MAX_REMOTE_SOURCES) break;
    if (!isRecord(item)) continue;
    const id = exact(item.id, MAX_WORD_LENGTH);
    if (id === null || isRemoteSource(id) || item.machine !== undefined) continue;
    const label = cut(item.label, MAX_WORD_LENGTH) ?? id;
    const state = oneOf(SOURCE_STATES, item.state) ?? "error";
    if (named.has(id)) continue;
    named.set(id, label);
    sources.push({ label, state });
    if (state === "unavailable" || state === "not-set-up") continue;
    const capabilities = readCapabilities(item.capabilities, machine);
    if (capabilities) agents.push({ label, capabilities });
  }

  const sessions: Session[] = [];
  const seen = new Set<string>();
  for (const item of value.sessions) {
    if (sessions.length >= MAX_REMOTE_SESSIONS) break;
    const session = readSession(item, machine, named, now, options.waitingText !== false);
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    sessions.push(session);
  }
  return { sessions, sources, agents };
}
