// How an Unreal Agent session's file, and whether its program may still run,
// map onto the session model. Pure, so the collector today and a browser or
// desktop host later share one mapping.
//
// The file says what the session does (`unrealAgentReplay.ts`), and `ps` says
// whether a program that could hold it runs (`unrealAgentLiveness.ts`). This
// was worked out from Unreal Agent's source at v0.3.1, not checked on a
// computer running it. See docs/adapters/unreal-agent.md.

import { KEEP_AWAKE_WORKING_MS } from "../../keep-awake/keepAwakeRule.ts";
import type { SessionStatus } from "../../sessions/session.ts";
import { CLOCK_SLACK_MS } from "../../time.ts";
import type { UnrealAgentLiveness } from "./unrealAgentLiveness.ts";
import {
  unrealAgentPhase,
  type UnrealAgentPhase,
  type UnrealAgentReplay,
} from "./unrealAgentReplay.ts";

/**
 * How long a reply that is the file's newest line counts as a turn still
 * under way. A reply with tool calls is followed at once by their statuses
 * (loop.go:475-495), each one write, and the file's time moves with each.
 * A session no program could hold writes nothing more, so its reply is not
 * held back.
 */
export const REPLY_SETTLE_MS = 2_000;

/**
 * What the file says the session does, as the status is taken from it: what
 * it said at a hard stop, when one was written; else its phase now, with a
 * reply written less than 2 seconds ago counted as busy. With `settle` false,
 * as when no program could write after the reply, the reply is taken as it is.
 */
export function unrealAgentPhaseNow(
  replay: UnrealAgentReplay,
  writtenAt: number,
  now: number,
  settle = true,
): UnrealAgentPhase {
  if (replay.run.hard !== null) return replay.run.hard;
  const phase = unrealAgentPhase(replay);
  const settling =
    settle &&
    (phase.phase === "waiting" || phase.phase === "unsure") &&
    replay.endsOnReply &&
    now - writtenAt < REPLY_SETTLE_MS;
  return settling ? { phase: "busy", reply: null } : phase;
}

/**
 * Whether the file says the session ended: the terminal app wrote a hard stop
 * as it quit, or a runner, which asks to end once idle, is idle.
 */
export function unrealAgentEnded(
  replay: UnrealAgentReplay,
  writtenAt: number,
  now: number,
): boolean {
  if (replay.run.hard !== null) return true;
  return replay.run.whenIdle && unrealAgentPhaseNow(replay, writtenAt, now).phase === "waiting";
}

export interface UnrealAgentStatusFacts {
  replay: UnrealAgentReplay;
  /** Whether a program that could hold the session may still run. */
  liveness: UnrealAgentLiveness;
  /** The file's modified time, in epoch milliseconds. */
  writtenAt: number;
  now: number;
}

/**
 * A session's status. The rows are taken in this order:
 *
 * | Phase / reply                       | Ended | Liveness    | Status   |
 * | ----------------------------------- | ----- | ----------- | -------- |
 * | unread                              | any   | any         | unknown  |
 * | waiting, reply failed               | any   | any         | failed   |
 * | waiting, reply unclear              | any   | any         | unknown  |
 * | unsure, reply failed or unclear     | any   | any         | unknown  |
 * | busy, waiting or unsure             | yes   | any         | finished |
 * | the same                            | no    | closed      | finished |
 * | busy                                | no    | open or not | working  |
 * | waiting                             | no    | may be open | idle     |
 * | waiting                             | no    | cannot tell | unknown  |
 * | unsure                              | no    | open or not | unknown  |
 *
 * - A failed reply ends nothing: its tool calls still run (loop.go:231-259),
 *   and the session shows as failed once nothing is left to run.
 * - A busy session is working for 30 quiet minutes, and then unknown. Unreal
 *   Agent writes nothing during a model call, which can be silent that long,
 *   and while commands run it writes a heartbeat every 10 minutes. A write
 *   further ahead of the clock than the slack is not believed either.
 */
export function mapUnrealAgentStatus(facts: UnrealAgentStatusFacts): SessionStatus {
  const { replay, liveness, writtenAt, now } = facts;
  const { phase, reply } = unrealAgentPhaseNow(replay, writtenAt, now, liveness !== "closed");
  if (phase === "unread") return "unknown";
  if (phase === "waiting" && reply === "failed") return "failed";
  if (phase === "waiting" && reply === "unclear") return "unknown";
  if (phase === "unsure" && (reply === "failed" || reply === "unclear")) return "unknown";
  if (unrealAgentEnded(replay, writtenAt, now)) return "finished";
  if (liveness === "closed") return "finished";
  if (phase === "busy") {
    const quiet = now - writtenAt;
    return quiet < KEEP_AWAKE_WORKING_MS && writtenAt <= now + CLOCK_SLACK_MS
      ? "working"
      : "unknown";
  }
  if (phase === "waiting" && liveness === "may-be-open") return "idle";
  return "unknown";
}
