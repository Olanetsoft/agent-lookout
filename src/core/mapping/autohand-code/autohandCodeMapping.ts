import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { CLOCK_SLACK_MS, plausibleTime } from "../../time.ts";

/**
 * How an Autohand Code session's status follows from its heartbeats, its
 * `metadata.json` and whether the process its heartbeat names runs. Pure: the
 * adapter reads, this decides. Built from Autohand Code's source at v0.9.11
 * and not yet checked on a computer running it. See
 * docs/adapters/autohand-code.md.
 */

/** A heartbeat's stage of work (`src/session/ActiveAgentRegistry.ts:19-24`). */
export type AutohandPhase = "idle" | "thinking" | "editing" | "running_command" | "waiting_input";

/** How a session's process runs: in a terminal, for one prompt, or for a client (`:313-317`). */
export type AutohandMode = "interactive" | "command" | "rpc";

/** How often Autohand Code rewrites a heartbeat (`src/session/ActiveAgentRegistry.ts:14`). */
export const AUTOHAND_HEARTBEAT_MS = 5_000;

/** How old a heartbeat may be and still count, as for Autohand Code itself (`:15`, `:131-136`). */
export const AUTOHAND_STALE_MS = 15_000;

/** Times written this little apart are the same moment. */
export const CLOSE_SLACK_MS = 1_000;
export const CRASH_SLACK_MS = 1_000;

/**
 * Whether a heartbeat was written recently enough to count: at most 15
 * seconds ago, as Autohand Code judges it, or ahead of this clock by no more
 * than the slack every time from a file is allowed.
 */
export function inFreshWindow(updatedAt: number | null, checkedAt: number): boolean {
  if (updatedAt === null) return false;
  const age = checkedAt - updatedAt;
  return age >= -CLOCK_SLACK_MS && age <= AUTOHAND_STALE_MS;
}

/**
 * What a heartbeat says of its session now:
 *
 * - `fresh`: its process runs and it was written within the window;
 * - `quiet`: its process runs and it is older, or its time cannot be read;
 * - `just-dead`: its process has gone and it was written within the window;
 * - `gone`: its process has gone and it is older.
 */
export type HeartbeatClass = "fresh" | "quiet" | "just-dead" | "gone";

export function heartbeatClass(
  updatedAt: number | null,
  alive: boolean,
  checkedAt: number,
): HeartbeatClass {
  const recent = inFreshWindow(updatedAt, checkedAt);
  if (alive) return recent ? "fresh" : "quiet";
  return recent ? "just-dead" : "gone";
}

/** One heartbeat of a session, as the status is chosen from it. */
export interface Candidate {
  /** The heartbeat file's name, to order two alike. */
  name: string;
  pid: number;
  updatedAt: number | null;
  phase: AutohandPhase | null;
  heartbeatClass: HeartbeatClass;
}

const CLASS_ORDER: readonly HeartbeatClass[] = ["fresh", "quiet", "just-dead", "gone"];

function phaseRank(phase: AutohandPhase | null): number {
  if (phase === "waiting_input") return 0;
  if (phase === "thinking" || phase === "editing" || phase === "running_command") return 1;
  return phase === "idle" ? 2 : 3;
}

/**
 * The heartbeat a session's status is taken from, of the ones its files hold:
 * a fresh one first, and of those one that waits for you, then one that works,
 * then an idle one. Of the others, the newest. Two alike go by name, then
 * process, so two processes that take turns writing give the same answer.
 */
export function chooseCandidate<T extends Candidate>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const one of candidates) {
    if (best === null || compareCandidates(one, best) < 0) best = one;
  }
  return best;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const byClass = CLASS_ORDER.indexOf(a.heartbeatClass) - CLASS_ORDER.indexOf(b.heartbeatClass);
  if (byClass !== 0) return byClass;
  if (a.heartbeatClass === "fresh") {
    const byPhase = phaseRank(a.phase) - phaseRank(b.phase);
    if (byPhase !== 0) return byPhase;
  } else {
    const newer = (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity);
    if (newer !== 0 && !Number.isNaN(newer)) return newer;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.pid - b.pid;
}

/** A session's `status` in its `metadata.json`, or `other` for a word this does not know. */
export type MetadataStatus = "active" | "completed" | "crashed" | "other";

/** What is kept of a session's `metadata.json`. */
export interface MetadataFacts {
  status: MetadataStatus;
  createdAt: number | null;
  lastActiveAt: number | null;
  closedAt: number | null;
  /** When the session was copied from another tool or the web, or null. */
  importedAt: number | null;
  /** The session's folder, when it is a whole path. */
  projectPath: string | null;
  /** The name given with `/rename` or `autohand --rename`, or null. */
  title: string | null;
  /** The app it was started from, when it is one this knows. */
  client: "terminal" | "vscode" | null;
}

/**
 * What a `metadata.json` says once it is read as Autohand Code wrote it:
 *
 * - `completed` with `lastActiveAt` more than a second past `closedAt`, or
 *   the time of a heartbeat of the session, `heartbeatAt`, more than 15
 *   seconds past it, is a session resumed since. Autohand Code keeps
 *   `completed` while a resumed session runs and saves nothing as it resumes
 *   one (`src/session/SessionManager.ts:164-178`), and each message moves
 *   `lastActiveAt` (`:598-611`). Every close but one stops the heartbeat
 *   first (`src/core/agent/AgentSessionAccounting.ts:350`;
 *   `src/core/agent/AgentLifecycleRunner.ts:332-336`). The idle timeout
 *   closes the session first and stops the heartbeat after
 *   (`src/core/agent/AgentSessionAccounting.ts:319-343`), and a close can
 *   wait up to 10 seconds on the session index's lock
 *   (`src/session/SessionManager.ts:26-30`, `:392-394`). For a copy of
 *   another tool's session or of one from the web, the time of the copy
 *   counts in place of an earlier `closedAt` or none. It counts as `active`.
 * - `crashed` saved after the crash, with `lastActiveAt` no more than a second
 *   before the file was written, is a session that went on: the crash's own
 *   write leaves `lastActiveAt` as it was
 *   (`src/core/agent/AgentLifecycleRunner.ts:2192-2206`). It counts as
 *   `active`. A misreading can only make a session finished or unknown.
 */
export function effectiveMetadataStatus(
  facts: MetadataFacts,
  writtenAt: number | null,
  now: number,
  heartbeatAt: number | null,
): MetadataStatus {
  const lastActiveAt = plausibleTime(facts.lastActiveAt, now);
  if (facts.status === "completed") {
    const since = later(plausibleTime(facts.closedAt, now), plausibleTime(facts.importedAt, now));
    const after = (at: number | null, slack: number) =>
      since !== null && at !== null && at > since + slack;
    if (
      after(lastActiveAt, CLOSE_SLACK_MS) ||
      after(plausibleTime(heartbeatAt, now), AUTOHAND_STALE_MS)
    ) {
      return "active";
    }
  }
  if (facts.status === "crashed" && writtenAt !== null && lastActiveAt !== null) {
    if (lastActiveAt >= writtenAt - CRASH_SLACK_MS) return "active";
  }
  return facts.status;
}

/** The later of two times, either of which may not be known. */
function later(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  return b === null ? a : Math.max(a, b);
}

/**
 * Whether a session is one Autohand Code copied from another tool, or from
 * the web, and you never resumed: written `completed` with the time of the
 * copy, and neither closed nor written to since: its `lastActiveAt` is no
 * more than a second past the copy, as each save of a resumed session moves it
 * (`src/import/importers/BaseImporter.ts:198-216`,
 * `src/session/transfer/transfer-session-store.ts:64-66`,
 * `src/session/SessionManager.ts:598-611`). It is not listed, unless a
 * heartbeat shows it running.
 */
export function importedAndNeverResumed(facts: MetadataFacts, now: number): boolean {
  if (facts.status !== "completed" || facts.importedAt === null) return false;
  if (facts.closedAt !== null && facts.closedAt > facts.importedAt) return false;
  const lastActiveAt = plausibleTime(facts.lastActiveAt, now);
  return lastActiveAt === null || lastActiveAt <= facts.importedAt + CLOSE_SLACK_MS;
}

/** Everything a session's status is decided from. */
export interface AutohandEvidence {
  /** The heartbeat chosen, of those that count, or null when the session has none now. */
  chosen: Candidate | null;
  /** The status its `metadata.json` counts as, `unreadable` for one that cannot be read, or null when it has none. */
  metadata: MetadataStatus | "unreadable" | null;
  /** Its last heartbeat's process, in a terminal or for one prompt, has a fresh heartbeat of another session. */
  movedOn: boolean;
  /** The status held over a late poll, or null. */
  standIn: SessionStatus | null;
  /** It was found ended before, and nothing has run in it since. */
  ended: boolean;
  /** The process its last heartbeat named has gone. */
  lastProcessGone: boolean;
}

export interface AutohandStatus {
  status: SessionStatus;
  waitingReason?: WaitingReason;
  /** The row of the table in docs/adapters/autohand-code.md that gave it. */
  row: number;
}

/**
 * The status, by the first row that applies:
 *
 * 1. a fresh heartbeat that waits for input: needs you. Autohand Code writes
 *    that while it asks you to approve a tool or answer a question, and the
 *    two cannot be told apart, so the reason is `other`;
 * 2. a fresh heartbeat that thinks, edits or runs a command: working;
 * 3. a fresh heartbeat that is idle: idle;
 * 4. a fresh heartbeat with no stage this knows: unknown;
 * 5. no heartbeat, and the process of its last one, in a terminal or for one
 *    prompt, has moved on to another session: finished, or failed when
 *    `metadata.json` says it crashed;
 * 6. what a late poll holds over: the status before;
 * 7. a heartbeat whose process runs and that is over 15 seconds old: unknown;
 * 8. a heartbeat whose process has gone within the last 15 seconds: unknown;
 * 9. a heartbeat whose process has gone, and `crashed`: failed;
 * 10. a heartbeat whose process has gone: finished;
 * 11. no heartbeat, and it was found ended or the process of its last one has
 *     gone: finished, or failed when it crashed;
 * 12. no heartbeat, and `completed`: finished;
 * 13. no heartbeat, and `crashed`: failed;
 * 14. no heartbeat, and `active` or no `metadata.json`: unknown;
 * 15. no heartbeat, and a status this does not know or a file it cannot read: unknown.
 */
export function autohandStatusOf(evidence: AutohandEvidence): AutohandStatus {
  const { chosen, metadata } = evidence;
  const crashed = metadata === "crashed";
  if (chosen?.heartbeatClass === "fresh") {
    const rank = phaseRank(chosen.phase);
    if (rank === 0) return { status: "needs-you", waitingReason: "other", row: 1 };
    if (rank === 1) return { status: "working", row: 2 };
    if (rank === 2) return { status: "idle", row: 3 };
    return { status: "unknown", row: 4 };
  }
  if (chosen === null && evidence.movedOn) {
    return { status: crashed ? "failed" : "finished", row: 5 };
  }
  if (evidence.standIn === "needs-you") {
    return { status: "needs-you", waitingReason: "other", row: 6 };
  }
  if (evidence.standIn !== null) return { status: evidence.standIn, row: 6 };
  if (chosen?.heartbeatClass === "quiet") return { status: "unknown", row: 7 };
  if (chosen?.heartbeatClass === "just-dead") return { status: "unknown", row: 8 };
  if (chosen !== null)
    return crashed ? { status: "failed", row: 9 } : { status: "finished", row: 10 };
  if (evidence.ended || evidence.lastProcessGone) {
    return { status: crashed ? "failed" : "finished", row: 11 };
  }
  if (metadata === "completed") return { status: "finished", row: 12 };
  if (metadata === "crashed") return { status: "failed", row: 13 };
  if (metadata === "active" || metadata === null) return { status: "unknown", row: 14 };
  return { status: "unknown", row: 15 };
}

/** What a finished or failed session's end is told from. */
export interface EndInput {
  facts: MetadataFacts | null;
  /** The status `facts` counts as. */
  effective: MetadataStatus | null;
  /** When its `metadata.json` was last written, in whole milliseconds, or null. */
  writtenAt: number | null;
  /** Its newest heartbeat's time, now or as last seen, or null. */
  updatedAt: number | null;
  now: number;
}

/**
 * When a finished or failed session ended:
 *
 * 1. its `closedAt`, when it was closed and not resumed since;
 * 2. else the latest of its heartbeat's time, its `lastActiveAt`, and, when
 *    it crashed or was marked `completed` with no close, when its
 *    `metadata.json` was written, which is when that was marked;
 * 3. else when its `metadata.json` was written;
 * 4. else not known.
 */
export function autohandEndedAt(input: EndInput): number | null {
  const { facts, now } = input;
  const writtenAt = plausibleTime(input.writtenAt, now);
  if (facts !== null && input.effective === "completed") {
    const closedAt = plausibleTime(facts.closedAt, now);
    if (closedAt !== null) return closedAt;
  }
  const marked =
    facts !== null &&
    (facts.status === "crashed" || (facts.status === "completed" && facts.closedAt === null));
  const times = [
    plausibleTime(input.updatedAt, now),
    plausibleTime(facts?.lastActiveAt ?? null, now),
    marked ? writtenAt : null,
  ].filter((at): at is number => at !== null);
  if (times.length > 0) return Math.max(...times);
  return writtenAt;
}
