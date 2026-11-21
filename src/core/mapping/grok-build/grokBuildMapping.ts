// How Grok Build's files map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// Grok Build's terminal app lists the sessions it has open, each with its
// process's ID and when it opened it, and writes an event log for each
// session: a line when a turn starts and when it ends, and lines for its model
// rounds, its tools and its permission checks. A question it asks the person
// is a call to its tool `ask_user_question`, and a plan waiting for approval is
// a flag in `plan_mode.json`. Built from Grok Build's source at 1.0.45 (commit
// 2bdd1d6) and not yet checked on a machine running it. See
// docs/adapters/grok-build.md for where each value comes from.

import type { SessionStatus, WaitingReason } from "../../sessions/session.ts";
import { CLOCK_SLACK_MS, plausibleTime, WRITE_TIME_STEP_MS } from "../../time.ts";

/**
 * How long a turn can write nothing from the model, no first token, no text,
 * no tool call and no permission check, before it is taken to be over without
 * a line that ends it: a rewind or an error before the model was asked leaves
 * a turn's start with no end (`cancel.rs:122-128`, `turn.rs:990-999`).
 */
export const NO_OUTPUT_MS = 120_000;

/** How a turn ended, as `turn_ended` writes it, or `other` for a word Grok Build 1.0.45 does not write. */
export type GrokBuildOutcome = "completed" | "cancelled" | "error" | "interrupted" | "other";

/**
 * The little the adapter keeps of a session's event log, from its newest
 * turn's start or end on: numbers and flags, and no text.
 */
export interface GrokBuildTurn {
  /** The newest line that starts or ends a turn, or `none` when the log has neither. */
  boundary: "none" | "started" | "ended";
  /** That line's `ts`, as written, in epoch milliseconds. */
  at: number | null;
  /** For `ended`, how the turn ended. */
  outcome: GrokBuildOutcome | null;
  /** For `started`, whether it is of the format this reads, `schema_version` 1.x. */
  schemaOk: boolean;
  /** No line that starts or ends a turn in the last 8 MiB, or more than 8 MiB written since it. */
  tooFar: boolean;
  /** A whole line that is not one Grok Build writes, at or after that line. */
  malformed: boolean;
  /** How many `ask_user_question` calls are open since that line. */
  openQuestions: number;
  /** When the open questions began: the `ts` of the call that opened the first of them. */
  questionSince: number | null;
  /** The `ts` of the newest `exit_plan_mode` call since that line. */
  planToolAt: number | null;
  /** Whether the model wrote anything since that line: a first token, text, a tool call or a permission check. */
  outputSeen: boolean;
  /** The newest `ts` of a line of a turn's own since that line. */
  turnLineAt: number | null;
}

/** A log with nothing in it: no turn has started. */
export function emptyGrokBuildTurn(): GrokBuildTurn {
  return {
    boundary: "none",
    at: null,
    outcome: null,
    schemaOk: false,
    tooFar: false,
    malformed: false,
    openQuestions: 0,
    questionSince: null,
    planToolAt: null,
    outputSeen: false,
    turnLineAt: null,
  };
}

/** What the adapter could read of a session's event log. */
export type GrokBuildLog =
  | { state: "ok"; turn: GrokBuildTurn }
  /** No folder found for the session, or two that hold its ID. */
  | { state: "no-folder" }
  /** No `events.jsonl`, or one that could not be read or is not one this reads. */
  | { state: "unreadable" };

/** Everything a session's status hangs on, read this poll. */
export interface GrokBuildFacts {
  /** Whether the session's process runs: signal 0, and on a Mac its start (`processCheck.ts`). */
  alive: boolean;
  /** Whether Grok Build lists it now. A session it lists no more whose process runs is watched. */
  listed: boolean;
  log: GrokBuildLog;
  /** The event log's modified time, as written, or null. */
  writtenAt: number | null;
  /** What `plan_mode.json` says of a plan waiting for approval. */
  plan: boolean | "unknown";
  /** `plan_mode.json`'s modified time, as written, or null. */
  planWrittenAt: number | null;
  /** When Grok Build listed the session, as its list says, in epoch milliseconds. */
  openedAt: number;
  /**
   * When the process that lists it first listed it, as far as Agent Lookout
   * saw: an earlier `openedAt` of the same process, which lists a session
   * again when it goes back to it after /new or the welcome screen. Left out,
   * it is `openedAt`.
   */
  firstOpenedAt?: number;
  now: number;
}

/** What a needs-you session waits on, so the adapter can keep the wait's start. */
export type GrokBuildWait = "question" | "plan-call" | "plan-file";

export interface GrokBuildStatus {
  status: SessionStatus;
  /** When the status began, when it is known. */
  since: number | null;
  /** Present only when the status is "needs-you". */
  waitingReason?: WaitingReason;
  /** Present only when the status is "needs-you". */
  wait?: GrokBuildWait;
}

/** The later of two times that could be right, or the one that could. */
function later(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * When a session that has ended ended: the later of when it was listed and
 * when its event log was last written, among the two that could be right.
 * The same for a session Agent Lookout saw close and for one a crash left
 * listed, so a restart gives it the same time.
 */
export function grokBuildFinishedAt(
  openedAt: number,
  writtenAt: number | null,
  now: number,
): number | null {
  const written = writtenAt === null ? null : plausibleTime(Math.floor(writtenAt), now);
  return later(plausibleTime(openedAt, now), written);
}

/**
 * Whether an open turn is left over rather than under way, by either of two
 * rules. A time that cannot be right takes part in neither, so it never ends
 * a turn.
 *
 * 1. Nothing from the model since the turn started, and the log written
 *    nothing for 2 minutes, plus 2 seconds for a disk that keeps a write's time
 *    rounded down.
 * 2. The turn started more than a minute before the process that lists the
 *    session first listed it, and no line of a turn's own was written at or
 *    after that listing: a turn an earlier process left open, which Grok
 *    Build did not close on loading. The same process going back to the
 *    session mid-turn lists it again, and that does not make its turn left over.
 */
export function turnIsLeftOver(turn: GrokBuildTurn, facts: GrokBuildFacts): boolean {
  if (turn.boundary !== "started") return false;
  const { now } = facts;
  const written = facts.writtenAt === null ? null : plausibleTime(Math.floor(facts.writtenAt), now);
  if (!turn.outputSeen && written !== null && now - written >= NO_OUTPUT_MS + WRITE_TIME_STEP_MS) {
    return true;
  }
  const listedAt = facts.firstOpenedAt ?? facts.openedAt;
  const startedAt = plausibleTime(turn.at, now);
  const openedAt = plausibleTime(listedAt, now);
  if (startedAt === null || openedAt === null) return false;
  return (
    startedAt < openedAt - CLOCK_SLACK_MS &&
    (turn.turnLineAt === null || turn.turnLineAt < listedAt)
  );
}

/** Why a log leaves a listed session's status unknown, or null when it says enough. */
function logIsUnknown(turn: GrokBuildTurn): boolean {
  if (turn.tooFar || turn.malformed) return true;
  if (turn.boundary === "started") return !turn.schemaOk;
  if (turn.boundary === "ended") return turn.outcome === "other" || turn.outcome === null;
  return false;
}

const FINISHED = (facts: GrokBuildFacts): GrokBuildStatus => ({
  status: "finished",
  since: grokBuildFinishedAt(facts.openedAt, facts.writtenAt, facts.now),
});

/**
 * A session's status. The first row that holds wins:
 *
 * | Row | When                                                                 | Status    | Since                         |
 * | --- | -------------------------------------------------------------------- | --------- | ----------------------------- |
 * | 1   | its process has ended, or it is watched and its turn is over          | finished  | `grokBuildFinishedAt`         |
 * | 2   | listed, and its log or plan file cannot say, or its turn is left over | unknown   | none                          |
 * | 3   | a question open in its open turn, or a plan waiting for approval      | needs-you | the question's, or the plan's |
 * | 4   | its newest turn started                                               | working   | the turn's start              |
 * | 5   | its newest turn ended on an error, or a crash cut it off              | failed    | the turn's end, or the listing when later |
 * | 6   | its newest turn ended, or none has started                            | idle      | the turn's end, or the listing when later |
 *
 * A watched session, one Grok Build lists no more whose process runs, as after
 * /new, is shown only while its log shows a turn under way or a question, or
 * its plan file a plan waiting. Anything else, a log it cannot read among
 * them, is its turn being over. A wait for a tool's approval is not told from
 * a tool that runs, since Grok Build writes the same lines for both: it is
 * working.
 *
 * A question's time is when the first of the open questions was asked, which
 * stays the same while they are open. A plan's is its newest `exit_plan_mode`
 * call in the open turn, or else the later of when `plan_mode.json` was last
 * written and the listing, which the adapter keeps for as long as the wait
 * lasts. Every time is judged against the clock here, on every poll.
 */
export function mapGrokBuildStatus(facts: GrokBuildFacts): GrokBuildStatus {
  if (!facts.alive) return FINISHED(facts);
  const { log, now } = facts;
  const turn = log.state === "ok" ? log.turn : null;
  const readable = turn !== null && !logIsUnknown(turn);
  const leftOver = turn !== null && turnIsLeftOver(turn, facts);
  const openTurn = readable && turn.boundary === "started" && !leftOver;
  const asking = openTurn && turn.openQuestions > 0;

  if (!facts.listed) {
    if (!openTurn && facts.plan !== true) return FINISHED(facts);
  } else if (!readable || leftOver || facts.plan === "unknown") {
    return { status: "unknown", since: null };
  }

  if (asking && turn !== null) {
    return {
      status: "needs-you",
      since: plausibleTime(turn.questionSince, now),
      waitingReason: "question",
      wait: "question",
    };
  }
  if (facts.plan === true) {
    const call = openTurn && turn !== null ? plausibleTime(turn.planToolAt, now) : null;
    if (call !== null) {
      return { status: "needs-you", since: call, waitingReason: "question", wait: "plan-call" };
    }
    const file =
      facts.planWrittenAt === null ? null : plausibleTime(Math.floor(facts.planWrittenAt), now);
    return {
      status: "needs-you",
      since: later(file, plausibleTime(facts.openedAt, now)),
      waitingReason: "question",
      wait: "plan-file",
    };
  }
  if (turn === null) return { status: "unknown", since: null };
  if (openTurn) return { status: "working", since: plausibleTime(turn.at, now) };
  if (turn.boundary === "ended") {
    const failed = turn.outcome === "error" || turn.outcome === "interrupted";
    // A session resumed after its last turn ended has been so since it was listed.
    const since = later(plausibleTime(turn.at, now), plausibleTime(facts.openedAt, now));
    return { status: failed ? "failed" : "idle", since };
  }
  return { status: "idle", since: plausibleTime(facts.openedAt, now) };
}
