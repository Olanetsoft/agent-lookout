// Whether an Unreal Agent session's program may still run, from when each
// Unreal Agent program started and when each session was last written. Pure.
//
// Unreal Agent writes no lock or pid file, and a session's file names no
// process (docs/adapters/unreal-agent.md). What `ps` gives is when each
// Unreal Agent program started. A terminal app or a runner holds one session
// at most (TUI run.go:202-203, runner run.go:291), and writes to it only after
// it started. So a session last written before every running program started
// is held by none of them. This was worked out from Unreal Agent's source at
// v0.3.1, not checked on a computer running it.

/** How far apart a start and a write can be and still be taken in either order (`SAME_START_WITHIN_MS`). */
export const START_SLACK_MS = 60_000;

/** How far a file's modified time can fall behind its write: some disks keep whole seconds, or steps of 2 seconds. */
export const WRITE_TIME_STEP_MS = 2_000;

/** How far the clock may move between two polls, past the time that passed, before it is taken as set. */
export const CLOCK_STEP_MS = 60_000;

/** What `ps` said of the Unreal Agent programs: when each started, or that it could not say. */
export type UnrealAgentPrograms =
  | { ok: false }
  | {
      ok: true;
      /** When each Unreal Agent program started, in epoch milliseconds, to the second. */
      starts: readonly number[];
      /** Whether some Unreal Agent program's start could not be read. */
      unknownStart: boolean;
    };

/** Whether a session's program may still run. */
export type UnrealAgentLiveness = "closed" | "may-be-open" | "cannot-tell";

/** Which rule gave a session's liveness, as docs/adapters/unreal-agent.md numbers them. */
export type UnrealAgentLivenessRule = "L0" | "L1" | "L2" | "Lx" | "L3" | "L4" | "L5";

/** One listed session, as liveness needs it. */
export interface UnrealAgentHeld {
  /** The file's modified time. */
  writtenAt: number;
  /** When its run began, or its last write when that is not known. */
  key: number;
  /** Whether the file says it ended, when it takes no part in the count. */
  ended: boolean;
}

/** A session's liveness, and the rule that gave it. */
export interface UnrealAgentLivenessAnswer {
  liveness: UnrealAgentLiveness;
  rule: UnrealAgentLivenessRule;
}

export interface UnrealAgentProcessFacts {
  /** What `ps` last said, or null when it was not run. */
  programs: UnrealAgentPrograms | null;
  /** When `ps` was last asked. */
  processesAt: number;
  /** When `ps` last showed no Unreal Agent program, or null. */
  noUnrealAt: number | null;
  /** The earliest write the start rule may close, after the clock was set. */
  l3Floor: number;
}

/**
 * Each session's liveness, by these rules in order:
 *
 * | Rule | Evidence                                                    | Liveness    |
 * | ---- | ----------------------------------------------------------- | ----------- |
 * | L0   | `ps` failed or was not run                                  | cannot-tell |
 * | L1   | `ps` shows no Unreal Agent program                          | closed      |
 * | L2   | written over 2 s before a `ps` that showed none             | closed      |
 * | Lx   | some program's start could not be read                      | cannot-tell |
 * | L3   | every program started over 60 s after the last write        | closed      |
 * | L4   | more sessions look open than programs that started before   | cannot-tell |
 * | L5   | otherwise                                                   | may-be-open |
 *
 * L3 counts only a write at or after `l3Floor`, which a clock set since
 * raises. L4: of the sessions not ended, not closed and whose run began by
 * the time `ps` was asked, ordered by when their run began, a session is
 * cannot-tell when some session whose run began as late or later has more
 * sessions begun by then than programs started by then. Each program holds
 * one session at most, so one of them has none, and which cannot be told.
 */
export function unrealAgentLiveness(
  facts: UnrealAgentProcessFacts,
  sessions: readonly UnrealAgentHeld[],
): UnrealAgentLivenessAnswer[] {
  const { programs } = facts;
  if (programs === null || !programs.ok) {
    return sessions.map(() => ({ liveness: "cannot-tell", rule: "L0" }));
  }
  if (programs.starts.length === 0 && !programs.unknownStart) {
    return sessions.map(() => ({ liveness: "closed", rule: "L1" }));
  }
  const answers = sessions.map(({ writtenAt }): UnrealAgentLivenessAnswer => {
    if (facts.noUnrealAt !== null && writtenAt < facts.noUnrealAt - WRITE_TIME_STEP_MS) {
      return { liveness: "closed", rule: "L2" };
    }
    if (programs.unknownStart) return { liveness: "cannot-tell", rule: "Lx" };
    if (
      writtenAt >= facts.l3Floor &&
      programs.starts.every((start) => start > writtenAt + START_SLACK_MS)
    ) {
      return { liveness: "closed", rule: "L3" };
    }
    return { liveness: "may-be-open", rule: "L5" };
  });

  const candidates = sessions
    .map((session, index) => ({ key: session.key, index }))
    .filter(
      ({ key, index }) =>
        !sessions[index]?.ended && answers[index]?.rule === "L5" && key <= facts.processesAt,
    )
    .sort((a, b) => a.key - b.key);
  const starts = [...programs.starts].sort((a, b) => a - b);
  let short = -Infinity;
  for (const [position, { key }] of candidates.entries()) {
    // Every candidate up to here, and any after it with the same key.
    let need = position + 1;
    while (candidates[need]?.key === key) need++;
    const have = starts.filter((start) => start <= key + START_SLACK_MS).length;
    if (need > have) short = Math.max(short, key);
  }
  for (const { key, index } of candidates) {
    if (key <= short) answers[index] = { liveness: "cannot-tell", rule: "L4" };
  }
  return answers;
}

/** What the clock guard keeps between polls, in memory only. */
export interface UnrealAgentClockGuard {
  /** The earliest write the start rule may close. */
  l3Floor: number;
  /** The latest time a poll has seen. */
  highWall: number;
  /** The last poll's time and monotonic clock. */
  last: { wall: number; mono: number } | null;
}

export function startUnrealAgentClockGuard(): UnrealAgentClockGuard {
  return { l3Floor: -Infinity, highWall: -Infinity, last: null };
}

/**
 * The guard after one more poll, at `wall` by the clock and `mono` by a clock
 * that is never set. A clock set while programs run moves either their start
 * times or new writes, so the start rule (L3) could close a session that
 * still runs. It only stops L3 from closing writes made before the step.
 *
 * - On Linux, `ps` works a start out from the time the system started, which
 *   moves with the clock (`processStart.ts`). A clock set forward makes every
 *   start later, so writes before it are left alone.
 * - On macOS, a start stays as it was taken. A clock set back makes new writes
 *   earlier than starts taken before, so writes before the latest time seen
 *   are left alone.
 */
export function guardUnrealAgentClock(
  guard: UnrealAgentClockGuard,
  sample: { platform: string; wall: number; mono: number },
): UnrealAgentClockGuard {
  const { platform, wall, mono } = sample;
  let { l3Floor } = guard;
  if (platform === "linux" && guard.last !== null) {
    const drift = wall - guard.last.wall - (mono - guard.last.mono);
    if (drift > CLOCK_STEP_MS) l3Floor = Math.max(l3Floor, wall);
  }
  if (platform === "darwin" && wall < guard.highWall - CLOCK_STEP_MS) {
    l3Floor = Math.max(l3Floor, guard.highWall);
  }
  return { l3Floor, highWall: Math.max(guard.highWall, wall), last: { wall, mono } };
}
