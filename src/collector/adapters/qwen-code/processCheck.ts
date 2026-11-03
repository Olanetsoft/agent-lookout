import { plausibleTime } from "../../../core/time.ts";
import {
  processStartTime,
  readProcessStartsWithPs,
  SAME_START_WITHIN_MS,
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
  type StartMatch,
} from "../../processes/processStart.ts";

/**
 * Telling whether the process that has a Qwen Code record's pid now is the one
 * that wrote the record, before its session is given Jump.
 *
 * A record outlives a session that crashed, and the system later gives its pid
 * to another program, which can run in a tmux pane or a Terminal tab of its
 * own. Unlike Claude Code on a Mac, Qwen Code records no start time for its
 * process on a Mac or Windows, but every record says when its process
 * registered the session, `startedAt`, the clock's time as the record was made
 * (`core/services/session-registry.ts:482` at v0.25.1). That process was
 * running then, with that pid. A process with the pid now that started no
 * later was running then too, and two running processes never share a pid, so
 * it is the same one. A process that started later was given the pid after the
 * session's own had ended.
 *
 * That holds only for a `startedAt` that has passed. One more than a minute
 * ahead of the clock, as when the clock was fast as the record was written and
 * has been set back since, may not have come yet, so it proves nothing, and
 * the answer for it is "unknown".
 *
 * `ps` gives a start time to the second, and Linux's `ps` works it out again
 * from the clock each time, so it moves when the clock is set. So a start up to
 * a minute after `startedAt` still counts as the record's own process, as a
 * start within a minute of `procStart` does for Claude Code.
 */

/** A record's pid, and when its process registered the session, as Qwen Code wrote it. */
export interface RecordProcess {
  pid: number;
  startedAt: number | null;
}

/**
 * Whether a process `ps` says started at `start` can be the one that wrote a
 * record at `startedAt`, asked at `now`: "same" when it started no later, give
 * or take a minute, "different" when it started after, and "unknown" when
 * either is missing, `start` is not in the form `ps` prints, or `startedAt` is
 * not a time that could be real (`plausibleTime`): before 2020, or more than a
 * minute ahead of `now`.
 */
export function recordProcessMatch(
  startedAt: number | null,
  start: string | undefined,
  now: number,
): StartMatch {
  if (startedAt === null || start === undefined) return "unknown";
  if (plausibleTime(startedAt, now) === null) return "unknown";
  const startMs = processStartTime(start);
  if (startMs === null) return "unknown";
  return startMs <= startedAt + SAME_START_WITHIN_MS ? "same" : "different";
}

export interface RecordProcessCheck {
  /**
   * The records, of these, whose process `ps` says is the one that wrote them.
   * One that cannot be compared, as when `ps` did not answer about its process
   * or it has no `startedAt`, is not among them.
   */
  confirmed<T extends RecordProcess>(records: readonly T[]): Promise<Set<T>>;
}

interface Remembered {
  match: StartMatch;
  at: number;
}

/**
 * Checks records against `ps`, remembering each answer for 30 seconds, so a
 * poll every two seconds does not mean a `ps` every two seconds. When any
 * record's answer is due, every record that can be checked is asked about in
 * that one run, `ps -o pid=,lstart= -p <pids>`. A record that is not asked
 * about is forgotten.
 */
export function createRecordProcessCheck(
  read: ReadProcessStarts = readProcessStartsWithPs,
  now: () => number = Date.now,
  ttlMs: number = START_CHECK_TTL_MS,
): RecordProcessCheck {
  /** Each answer, by the record's pid and `startedAt`: one process can register two sessions. */
  const remembered = new Map<string, Remembered>();
  const keyOf = (record: RecordProcess) => `${record.pid} ${record.startedAt}`;

  return {
    async confirmed(records) {
      const at = now();
      const checkable = records.filter((record) => record.startedAt !== null);
      const due = checkable.some((record) => {
        const known = remembered.get(keyOf(record));
        // A clock that was set back counts as time enough.
        return known === undefined || at < known.at || at - known.at >= ttlMs;
      });

      if (due) {
        let starts = new Map<number, string>();
        try {
          starts = await read([...new Set(checkable.map((record) => record.pid))]);
        } catch {
          // No answer. Every comparison below comes out as "unknown".
        }
        for (const record of checkable) {
          remembered.set(keyOf(record), {
            match: recordProcessMatch(record.startedAt, starts.get(record.pid), at),
            at,
          });
        }
      }

      const asked = new Set(checkable.map(keyOf));
      for (const key of remembered.keys()) {
        if (!asked.has(key)) remembered.delete(key);
      }
      return new Set(checkable.filter((record) => remembered.get(keyOf(record))?.match === "same"));
    },
  };
}
