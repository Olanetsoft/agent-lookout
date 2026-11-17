import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { plausibleTime } from "../../time.ts";

/**
 * A DeepSeek Harness session's status, from the lines of its event log and
 * of its subagents' logs. Built from DeepSeek Harness's source at
 * dsh-v0.2.2-rc.3 and not yet checked on a computer running it. See
 * docs/adapters/deepseek-harness.md.
 *
 * The reader (`src/collector/adapters/deepseek-harness/lines.ts`) turns each
 * line it looks at into one of `DeepseekHarnessLine`, from bytes. The fold
 * here keeps only what the status needs: whether a turn is open, since when,
 * and which approvals and questions it waits on. No text is kept.
 */

/**
 * How long a session may write nothing and still show as working, or as
 * needing you without the desktop app: 30 minutes, the same as keep-awake's.
 * A crash leaves an open turn behind, and nothing marks it.
 */
export const QUIET_MS = KEEP_AWAKE_WORKING_MS;

/** The most approvals and questions one turn may wait on at once. More makes the turn unsure. */
export const PENDING_MAX = 64;

/**
 * How a turn ended, from `turn/end`'s reason kind (core/session/src/types.ts:206-235).
 * `disposed` is an `aborted` turn whose own reason is `disposed`: DeepSeek
 * Harness closed the session mid-turn (core/agent-loop/src/agent.ts:93-108).
 * `other` is a kind this does not know.
 */
export type DeepseekHarnessEnd =
  | "completed"
  | "blocked"
  | "max-tokens"
  | "interrupted"
  | "forked"
  | "aborted"
  | "disposed"
  | "error"
  | "other";

/** One line of a log, as far as the status needs it. */
export type DeepseekHarnessLine =
  | { kind: "turn-start"; time: number | null }
  | { kind: "turn-end"; end: DeepseekHarnessEnd; time: number | null }
  | { kind: "approval-asked"; id: string; time: number | null }
  | { kind: "approval-decided"; id: string }
  /** A call of `ask_user_question` or `exit_plan_mode`, which waits for the person. */
  | { kind: "question-asked"; callId: string; time: number | null }
  /** The result of a tool call, with its call's ID, or null when the line is in another layout. */
  | { kind: "tool-result"; callId: string | null }
  /** `session/end-seed`: with `inherited`, where a fork's copied lines end; without, a reopened session. */
  | { kind: "end-seed"; inherited: boolean; time: number | null }
  /** A line of a kind the status needs, in a layout this does not know, or lines that were not read. */
  | { kind: "unsure" }
  /** Any other line. */
  | { kind: "other" };

/** Where a log's turns stand after the lines read so far. */
export type DeepseekHarnessTurn =
  /** No turn yet, since the session began or was reopened. */
  | { state: "none"; since: number | null }
  | {
      state: "open";
      since: number | null;
      /** The approvals asked and not answered, by ID, with when each was asked. */
      approvals: Map<string, number | null>;
      /** The questions and plan reviews asked and not answered, by call ID, with when. */
      questions: Map<string, number | null>;
      /** When the turn began to wait, while it waits. */
      waitSince: number | null;
    }
  | { state: "ended"; end: DeepseekHarnessEnd; at: number | null }
  /** Not known until the next turn begins or ends. */
  | { state: "unsure" };

/** A log's turns before any line: none, since the session began. */
export function startDeepseekHarnessTurn(createdAt: number | null): DeepseekHarnessTurn {
  return { state: "none", since: createdAt };
}

/** A copy that a fold can change while the original stands. */
export function copyDeepseekHarnessTurn(turn: DeepseekHarnessTurn): DeepseekHarnessTurn {
  if (turn.state !== "open") return { ...turn };
  return { ...turn, approvals: new Map(turn.approvals), questions: new Map(turn.questions) };
}

function waits(turn: Extract<DeepseekHarnessTurn, { state: "open" }>): boolean {
  return turn.approvals.size > 0 || turn.questions.size > 0;
}

/** Adds one wait to an open turn, or makes it unsure past `PENDING_MAX`. */
function asked(
  turn: Extract<DeepseekHarnessTurn, { state: "open" }>,
  pending: Map<string, number | null>,
  id: string,
  time: number | null,
): DeepseekHarnessTurn {
  if (!pending.has(id) && turn.approvals.size + turn.questions.size >= PENDING_MAX) {
    return { state: "unsure" };
  }
  if (!waits(turn)) turn.waitSince = time;
  pending.set(id, time);
  return turn;
}

function answered(
  turn: Extract<DeepseekHarnessTurn, { state: "open" }>,
  pending: Map<string, number | null>,
  id: string,
): DeepseekHarnessTurn {
  pending.delete(id);
  if (!waits(turn)) turn.waitSince = null;
  return turn;
}

/**
 * The turns after one more line. It may change `turn` in place, so a caller
 * that keeps the one before folds into a copy.
 *
 * - `turn/start` opens a turn, waiting on nothing, from any state.
 * - `turn/end` ends it, from any state but none: a fork's copied lines end
 *   with `session/end-seed`, and the closers DeepSeek Harness adds after it
 *   end the source's turn, not the fork's (core/session/src/fork.ts:21-29).
 * - `session/end-seed` starts again with no turn: since the session began
 *   for a fork's, since the line for a reopened session's
 *   (core/session/src/index.ts:728-731).
 * - An approval or a question counts only in an open turn: one left in an
 *   earlier turn stays in the log, unanswered, for ever.
 * - A tool's result answers a question of the same call ID. One in another
 *   layout, while a question waits, makes the turn unsure.
 */
export function applyDeepseekHarnessLine(
  turn: DeepseekHarnessTurn,
  line: DeepseekHarnessLine,
  createdAt: number | null,
): DeepseekHarnessTurn {
  switch (line.kind) {
    case "turn-start":
      return {
        state: "open",
        since: line.time,
        approvals: new Map(),
        questions: new Map(),
        waitSince: null,
      };
    case "turn-end":
      return turn.state === "none" ? turn : { state: "ended", end: line.end, at: line.time };
    case "end-seed":
      return { state: "none", since: line.inherited ? createdAt : (line.time ?? createdAt) };
    case "unsure":
      return { state: "unsure" };
    case "approval-asked":
      return turn.state === "open" ? asked(turn, turn.approvals, line.id, line.time) : turn;
    case "approval-decided":
      return turn.state === "open" ? answered(turn, turn.approvals, line.id) : turn;
    case "question-asked":
      return turn.state === "open" ? asked(turn, turn.questions, line.callId, line.time) : turn;
    case "tool-result":
      if (turn.state !== "open" || turn.questions.size === 0) return turn;
      if (line.callId === null) return { state: "unsure" };
      return answered(turn, turn.questions, line.callId);
    default:
      return turn;
  }
}

/** Whether a process that could write a session's logs may still run, from `ps` and the computer's start. */
export type DeepseekHarnessWriter =
  /** None could: the session is finished. */
  | "gone"
  /** The desktop app runs, and started before the last write. */
  | "backed"
  /** One may. */
  | "maybe";

/** A subagent's log, of a session shown, that could be read. */
export interface DeepseekHarnessChild {
  turn: DeepseekHarnessTurn;
  /** When its log was last written, or null when that time cannot be right. */
  writtenAt: number | null;
}

export interface DeepseekHarnessFamily {
  /** The session's own turns, or null when its log cannot be used: too long, stuck or of a newer format. */
  own: DeepseekHarnessTurn | null;
  /** Its subagents' logs that could be read and used. */
  children: readonly DeepseekHarnessChild[];
  /** When it or a subagent's log was last written, or null when that cannot be right. */
  writtenAt: number | null;
  writer: DeepseekHarnessWriter;
  now: number;
}

/** What a session waits on, for telling a wait that goes on from a new one. */
export interface DeepseekHarnessWait {
  since: number | null;
  /** The approvals' IDs and the questions' call IDs it waits on. */
  ids: string[];
}

export interface DeepseekHarnessStatus {
  status: SessionStatus;
  since: number | null;
  waitingReason?: WaitingReason;
  wait?: DeepseekHarnessWait;
  /** Whether the session's last write is shown: only while it works. */
  showsLastWrite: boolean;
}

function earliest(times: readonly (number | null)[]): number | null {
  const known = times.filter((time): time is number => time !== null);
  return known.length === 0 ? null : Math.min(...known);
}

function quietFor(writtenAt: number | null, now: number): boolean {
  return writtenAt === null || now - writtenAt >= QUIET_MS;
}

/** Ends that leave a session idle, waiting for the person's next prompt. */
const IDLE_ENDS: ReadonlySet<DeepseekHarnessEnd> = new Set([
  "completed",
  "blocked",
  "max-tokens",
  "interrupted",
  "forked",
  "aborted",
]);

/**
 * A session's status, from its own turns and its subagents', the first row
 * that holds:
 *
 * 1. Its own log cannot be used, or its turns are unsure: unknown.
 * 2. Its last turn ended on an error: failed, since then.
 * 3. Its last turn was aborted as DeepSeek Harness closed it: finished, since then.
 * 4. No process that could write it runs: finished, since its last write.
 * 5. A turn of its own or a subagent's waits for an approval, a question or
 *    a plan review, and the desktop app backs it or it wrote within 30
 *    minutes: needs you, since the wait began.
 * 6. Such a wait, with neither: unknown, as a crash leaves a wait behind.
 * 7. Its own turn is open and it wrote within 30 minutes: working, since the turn began.
 * 8. Its own turn is open, quiet longer: unknown.
 * 9. Its last turn ended in a way this does not know: unknown.
 * 10. A subagent's turn is open and its log was written within 30 minutes:
 *     working, since the earliest such turn began.
 * 11. Its last turn ended otherwise: idle, since then.
 * 12. No turn yet: idle, since the session began or was reopened.
 *
 * A log's times are kept as written, and each is judged against `now` here,
 * on every poll: one more than a minute ahead of it is none.
 */
export function deepseekHarnessStatusOf(family: DeepseekHarnessFamily): DeepseekHarnessStatus {
  const { own, children, writtenAt, writer, now } = family;
  // A log's times are kept as written, and judged against the clock here, on every poll.
  const believed = (time: number | null) => plausibleTime(time, now);
  if (own === null || own.state === "unsure") {
    return { status: "unknown", since: null, showsLastWrite: false };
  }
  if (own.state === "ended" && own.end === "error") {
    return { status: "failed", since: believed(own.at), showsLastWrite: false };
  }
  if (own.state === "ended" && own.end === "disposed") {
    return { status: "finished", since: believed(own.at), showsLastWrite: false };
  }
  if (writer === "gone") return { status: "finished", since: writtenAt, showsLastWrite: false };

  const quiet = quietFor(writtenAt, now);
  const turns = [own, ...children.map((child) => child.turn)];
  const open = turns.filter(
    (turn): turn is Extract<DeepseekHarnessTurn, { state: "open" }> => turn.state === "open",
  );
  const waiting = open.filter(waits);
  if (waiting.length > 0) {
    if (writer !== "backed" && quiet)
      return { status: "unknown", since: null, showsLastWrite: false };
    const ids = waiting.flatMap((turn) => [
      ...[...turn.approvals.keys()].map((id) => `approval:${id}`),
      ...[...turn.questions.keys()].map((id) => `question:${id}`),
    ]);
    const since = earliest(waiting.map((turn) => believed(turn.waitSince)));
    return {
      status: "needs-you",
      since,
      waitingReason: waiting.some((turn) => turn.approvals.size > 0) ? "permission" : "question",
      wait: { since, ids },
      showsLastWrite: false,
    };
  }
  if (own.state === "open") {
    return quiet
      ? { status: "unknown", since: null, showsLastWrite: false }
      : { status: "working", since: believed(own.since), showsLastWrite: true };
  }
  if (own.state === "ended" && !IDLE_ENDS.has(own.end)) {
    return { status: "unknown", since: null, showsLastWrite: false };
  }
  const working = children.filter(
    (child) => child.turn.state === "open" && !quietFor(child.writtenAt, now),
  );
  if (working.length > 0) {
    const since = earliest(
      working.map((child) => (child.turn.state === "open" ? believed(child.turn.since) : null)),
    );
    return { status: "working", since, showsLastWrite: true };
  }
  return {
    status: "idle",
    since: believed(own.state === "ended" ? own.at : own.since),
    showsLastWrite: false,
  };
}

/**
 * A wait as a poll found it, given the one the poll before found. It goes on
 * while any approval or question it waited on still stands, so it keeps the
 * time it began, as `continuedVibeWait` does for Mistral Vibe: with two
 * open, answering the older leaves the person waited on, and a later time on
 * a session still waiting would read as a new wait. A wait that shares
 * nothing with the one before is new.
 */
export function continuedDeepseekHarnessWait(
  before: DeepseekHarnessWait | undefined,
  wait: DeepseekHarnessWait,
): DeepseekHarnessWait {
  if (before === undefined || !wait.ids.some((id) => before.ids.includes(id))) return wait;
  const since = earliest([before.since, wait.since]);
  return { ...wait, since };
}
