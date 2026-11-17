// How fx's session logs map onto the session model. Pure, so the collector
// today and a browser or desktop host later share one mapping.
//
// fx keeps each session in one log, `log.jsonl`, and writes into it when a
// turn starts, each finished piece of a turn, and how the turn ended. It
// writes nothing while it waits for the person or between turns, and the only
// sign that a session is open is a lock fx holds on a file beside the log,
// which Agent Lookout never takes or tries. So this mapping reads the log's
// last turn and whether an fx program runs. It was worked out from fx's
// source at v0.0.17, not checked on a computer running it. See
// docs/adapters/fx.md.

import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus } from "../../sessions/session.ts";
import { CLOCK_SLACK_MS } from "../../time.ts";

/** What a session's log says of its last turn, as the collector reads it. */
export type FxTail =
  /** A turn is open: its newest deciding line starts it or is one of its pieces. */
  | { turn: "open" }
  /** The last turn ended, as failed or not, at the time on its line. */
  | { turn: "ended"; failed: boolean; at: number }
  /** No turn of this session's own has started. */
  | { turn: "none" }
  /** The log ends in a way this does not read. */
  | { turn: "unknown" };

/**
 * Whether an fx program runs, from `ps`: none, at least one, or "unknown"
 * when `ps` could not say.
 */
export type FxPrograms = "none" | "some" | "unknown";

export interface FxStatusFacts {
  tail: FxTail;
  programs: FxPrograms;
  /**
   * Whether every fx program running now was missing from a `ps` answer
   * taken after the log's last write, so none of them made it.
   */
  writerGone: boolean;
  /** The log's modified time, in epoch milliseconds. */
  writtenAt: number;
  now: number;
}

/**
 * A session's status. The rows are taken in this order:
 *
 * | Row | Last turn                  | fx programs                 | Status   |
 * | --- | -------------------------- | --------------------------- | -------- |
 * | 1   | unknown                    | any                         | unknown  |
 * | 2   | ended as failed            | any                         | failed   |
 * | 3   | open, ended or none        | ps could not say            | unknown  |
 * | 4   | open, ended or none        | none                        | finished |
 * | 5   | ended, not failed, or none | some                        | unknown  |
 * | 6   | open                       | some, all since the write   | finished |
 * | 7   | open                       | some, quiet 30 min or ahead | unknown  |
 * | 8   | open                       | some                        | working  |
 *
 * - Row 2: fx writes a failed turn as such, and a failure stands.
 * - Row 4: fx's lock is freed when its process ends, so with no fx program
 *   no session is held.
 * - Row 5: a session fx holds between turns looks on disk as one it has let
 *   go, so it cannot be told from one that is over.
 * - Row 6: a running fx that was missing at an answer after the last write
 *   did not make it, and an fx that opened the log for writing since would
 *   have written that the turn was cut off, which moves the write.
 * - Row 7: fx sets no limit on a turn, so a turn a crash cut off, while some
 *   other fx runs, is believed for 30 quiet minutes and then shown as
 *   unknown. A write further ahead of the clock than the slack is not
 *   believed either.
 *
 * It is never `idle` or `needs-you`: fx writes nothing for either.
 */
export function mapFxStatus(facts: FxStatusFacts): SessionStatus {
  const { tail, programs } = facts;
  if (tail.turn === "unknown") return "unknown";
  if (tail.turn === "ended" && tail.failed) return "failed";
  if (programs === "unknown") return "unknown";
  if (programs === "none") return "finished";
  if (tail.turn !== "open") return "unknown";
  if (facts.writerGone) return "finished";
  const quiet = facts.now - facts.writtenAt;
  if (quiet >= KEEP_AWAKE_WORKING_MS || facts.writtenAt > facts.now + CLOCK_SLACK_MS) {
    return "unknown";
  }
  return "working";
}
