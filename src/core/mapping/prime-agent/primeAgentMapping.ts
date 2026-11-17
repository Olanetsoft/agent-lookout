// How Prime Agent's leases and its workers' recovery journals map onto the
// session model. Pure, so the collector today and a browser or desktop host
// later share one mapping.
//
// Prime Agent writes no status into a session's file. A process that opens a
// session first takes the session's lease, `session-leases/<hash>.lock`, whose
// `owner.json` names the process, and gives it up when it closes the session.
// A daemon worker also records each step it takes in its recovery journal,
// `<worker ID>.recovery.jsonl`, which the lease names through the worker's ID.
// This mapping reads only what those say, and was worked out from Prime
// Agent's source at v0.10.3, not checked on a computer running it. See
// docs/adapters/prime-agent.md.

import type { SessionStatus } from "../../sessions/session.ts";

/** How a start Prime Agent wrote compares with the start of the process with that pid now. */
export type StartComparison = "same" | "different" | "unknown";

/** What is known of the process one lease names. */
export interface LeaseProcessFacts {
  /** Whether signal 0 found a process with the lease's pid. */
  alive: boolean;
  /**
   * The lease's `processStartId` against the process with its pid now: from
   * `/proc` on Linux for a `proc:` start, or from `ps` for a `ps:` start.
   * "unknown" when it was not compared.
   */
  start: StartComparison;
  /** Whether the lease was taken before the computer last started. */
  beforeBoot: boolean;
  /**
   * What `ps` said the process's program is, or null when `ps` was not asked,
   * as on Windows. `not-listed` when `ps` named no process with the pid, or
   * could not be run.
   */
  program: "prime-agent" | "other" | "not-listed" | null;
}

/** Whether a lease's process holds it: it runs, it has gone, or it cannot be told. */
export type LeaseProcess = "runs" | "gone" | "unknown";

/**
 * Whether the process a lease names still holds it. The rows are taken in
 * this order:
 *
 * | Rule | Facts                                         | Answer  |
 * | ---- | --------------------------------------------- | ------- |
 * | H3   | signal 0 finds no process                     | gone    |
 * | H4   | its start differs from the lease's            | gone    |
 * | H5   | its start is the lease's                      | runs    |
 * | H6   | no start compared, and taken before the boot  | gone    |
 * | H7   | `ps` names `prime-agent`                      | runs    |
 * | H7b  | `ps` names another program                    | unknown |
 * | H7c  | `ps` names none, or could not be run          | unknown |
 * | H8   | `ps` not asked, as on Windows                 | unknown |
 *
 * Prime Agent's own rule is the first two (`owner_alive` in `lease.rs`). A
 * start that matches proves the pid is still the one that took the lease, so
 * the boot rule is not used then. Without one, a process given the pid since
 * could be any program, so only one `ps` names `prime-agent` counts.
 */
export function primeAgentLeaseProcess(facts: LeaseProcessFacts): LeaseProcess {
  if (!facts.alive) return "gone";
  if (facts.start === "different") return "gone";
  if (facts.start === "same") return "runs";
  if (facts.beforeBoot) return "gone";
  return facts.program === "prime-agent" ? "runs" : "unknown";
}

/** What the leases say of one listed session. */
export interface HolderFacts {
  /** False when `session-leases/` is missing, is not a folder or could not be listed. */
  listed: boolean;
  /** What each lease that names the session's file says of its process. */
  leases: readonly LeaseProcess[];
  /** Whether some lease since the boot could not be read, so it could be this session's. */
  stray: boolean;
}

/** Who holds a session: a running process, none, or it cannot be told. */
export type Holder = "runs" | "none" | "unknown";

/**
 * Who holds a session's lease:
 *
 * | Rule | Facts                                             | Holder  |
 * | ---- | ------------------------------------------------- | ------- |
 * | H2   | the leases could not be listed                    | unknown |
 * | H10  | one of its leases runs                            | runs    |
 * | H10  | else one of them cannot be told                   | unknown |
 * | H9   | else some lease could not be read                 | unknown |
 * | H1   | else                                              | none    |
 *
 * A daemon worker takes the lease before it opens or makes the file, and
 * print and RPC runs take it too, so no lease that runs means no Prime Agent
 * has the session open.
 */
export function primeAgentHolder(facts: HolderFacts): Holder {
  if (!facts.listed) return "unknown";
  if (facts.leases.includes("runs")) return "runs";
  if (facts.leases.includes("unknown")) return "unknown";
  return facts.stray ? "unknown" : "none";
}

/** What is kept of one record line of a journal. */
export interface JournalRecord {
  /** The session the worker had open, by its ID. */
  sessionId: string;
  /** The name of the session's file, without its folders, or null when the line has none. */
  sessionFile: string | null;
  busy: boolean;
  operation: string;
  /** When the line was written, in epoch milliseconds. */
  recordedAt: number;
}

/** What is kept of the newest queue line, null when there is none, or `unreadable`. */
export type QueueState = { suspended: boolean; recordedAt: number } | "unreadable" | null;

/** One record line, with the queue line last read before it. */
export interface TrailEntry {
  record: JournalRecord;
  queue: QueueState;
}

/**
 * The record lines that settle a turn: Prime Agent's `Settle` checkpoints, and
 * `queue_resumed`, which writes `busy` the same way.
 */
const SETTLES: ReadonlySet<string> = new Set([
  "turn_end",
  "queue_purged",
  "queue_cleared",
  "queue_mutated",
  "queue_resumed",
]);

/** The record lines that say work is waiting in a lane: `Admitted`, and a settle that leaves some. */
const QUEUED: ReadonlySet<string> = new Set([
  "steer_queued",
  "follow_up_queued",
  "turn_end",
  "queue_purged",
  "queue_cleared",
  "queue_mutated",
  "queue_resumed",
]);

/** Whether a record line could show its session as working, whatever its queue says. */
export function mayBeWorking(record: JournalRecord): boolean {
  return record.busy && (record.operation === "prompt_accepted" || QUEUED.has(record.operation));
}

/** Whether a record line shows its session as idle, whatever its queue says. */
export function mayBeIdle(record: JournalRecord): boolean {
  return !record.busy && SETTLES.has(record.operation);
}

/**
 * What one record line says, with the queue line read before it:
 *
 * | Record                                       | busy  | Queue           | Status  |
 * | -------------------------------------------- | ----- | --------------- | ------- |
 * | `prompt_accepted`                            | true  | any             | working |
 * | `steer_queued`, `follow_up_queued`, a settle | true  | not parked      | working |
 * | the same                                     | true  | parked, or none | unknown |
 * | a settle                                     | false | any             | idle    |
 * | `create`, and anything else                  | any   | any             | unknown |
 *
 * A settle is `turn_end`, `queue_purged`, `queue_cleared`, `queue_mutated`
 * or `queue_resumed`. `busy` alone says nothing: Prime Agent writes it true on every create and
 * reopen. A prompt is accepted only while a turn runs or into one it starts.
 * Queued work runs unless the queue is parked, which a parked queue line
 * says, or the worker is compacting, which nothing says.
 */
export function primeAgentRecordStatus(
  record: JournalRecord,
  queue: QueueState,
): "working" | "idle" | "unknown" {
  if (!record.busy) return mayBeIdle(record) ? "idle" : "unknown";
  if (record.operation === "prompt_accepted") return "working";
  if (!QUEUED.has(record.operation)) return "unknown";
  return queue !== null && queue !== "unreadable" && !queue.suspended ? "working" : "unknown";
}

/** What is known of one session's worker from its journal. */
export interface JournalFacts {
  /** The session, by its ID in its file. */
  sessionId: string;
  /** When the lease of the process that holds it was taken, in epoch milliseconds. */
  createdAt: number;
  /** The record lines of the worker's slot, oldest first, with what was read of the queue before each. */
  trail: readonly TrailEntry[];
  /** The newest queue line of the slot. */
  queue: QueueState;
  /**
   * When the slot's run of idle records of one session, to its newest, began,
   * in epoch milliseconds, or null when its newest is not idle.
   */
  idleSince: number | null;
}

/** Whether a record line is this session's and was written since the lease was taken. */
function counts(record: JournalRecord, sessionId: string, createdAt: number): boolean {
  const own =
    record.sessionFile === null
      ? record.sessionId === sessionId
      : record.sessionFile === `${sessionId}.jsonl`;
  return own && record.recordedAt >= createdAt;
}

/** A queue line, unless it was written before the lease was taken. */
function since(queue: QueueState, createdAt: number): QueueState {
  if (queue === null || queue === "unreadable") return queue;
  return queue.recordedAt >= createdAt ? queue : null;
}

/**
 * A session's status, and since when, from the journal of the worker its
 * lease names, while a process that runs holds the lease. The newest record
 * line counts only if it names the session's file, or its ID when it names
 * no file, and was written since the lease was taken: one before is another
 * run's, and a worker can move to another session with `/new`. Otherwise the
 * session is unknown. The newest queue line counts only if it was written
 * since the lease was taken too.
 *
 * A working session's time is the first line of the run of lines at the end
 * that each say working. An idle one's is when its run of idle records began,
 * which the reader keeps across Prime Agent's rewrite of the journal, when
 * that was since the lease was taken, else its line's.
 */
export function primeAgentJournalStatus(facts: JournalFacts): {
  status: "working" | "idle" | "unknown";
  since: number | null;
} {
  const { sessionId, createdAt, trail } = facts;
  const last = trail.at(-1);
  if (last === undefined || !counts(last.record, sessionId, createdAt)) {
    return { status: "unknown", since: null };
  }
  const status = primeAgentRecordStatus(last.record, since(facts.queue, createdAt));
  if (status === "unknown") return { status, since: null };
  if (status === "idle") {
    const from = facts.idleSince;
    return {
      status,
      since:
        from !== null && from >= createdAt && from <= last.record.recordedAt
          ? from
          : last.record.recordedAt,
    };
  }
  let first = last.record.recordedAt;
  for (let index = trail.length - 2; index >= 0; index -= 1) {
    const { record, queue } = trail[index] as TrailEntry;
    if (!counts(record, sessionId, createdAt)) break;
    if (primeAgentRecordStatus(record, since(queue, createdAt)) !== "working") break;
    first = record.recordedAt;
  }
  return { status, since: first };
}

/** A session's status from who holds it, before its journal is read. */
export function primeAgentHolderStatus(holder: Holder): SessionStatus | null {
  if (holder === "none") return "finished";
  if (holder === "unknown") return "unknown";
  return null;
}
