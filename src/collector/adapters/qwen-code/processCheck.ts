import { plausibleTime } from "../../../core/time.ts";
import { createStartTokenReader, type ReadStartTokens } from "../../processes/linuxProcesses.ts";
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
 * that wrote the record.
 *
 * A record outlives a session that crashed, and the system later gives its pid
 * to another program. Signal 0 then says the record's process runs, for as
 * long as that program does. Each answer here is "same", "different" or
 * "unknown", and only "different" is acted on: a session whose process cannot
 * be told stays as signal 0 says.
 *
 * On Linux, Qwen Code writes a start token into each record, `procStart`:
 * `<boot id>:<start>`, the boot's id and the process's start in clock ticks
 * since the boot. The token of the process with the pid now is read from
 * `/proc` (`linuxProcesses.ts`) and compared whole with the record's, as Qwen
 * Code compares them (`isSameProcess` in `core/utils/process-liveness.ts` at
 * v0.25.1). A token from another boot is different too: a restart ends every
 * process. When the token cannot be read, the answer is "unknown", as Qwen
 * Code then keeps the record.
 *
 * Unlike Claude Code on a Mac, Qwen Code records no start for its process on a
 * Mac or Windows, but every record says when its process registered the
 * session, `startedAt`, the clock's time as the record was made
 * (`core/services/session-registry.ts:482` at v0.25.1). That process was
 * running then, with that pid. A process with the pid now that started no
 * later was running then too, and two running processes never share a pid, so
 * it is the same one. A process that started later was given the pid after the
 * session's own had ended. So `ps` is asked when the process started: on a
 * Mac for every open record, which decides whether its session is open and
 * gives Jump, and on Linux only before Jump.
 *
 * That holds only for a `startedAt` that has passed. One more than a minute
 * ahead of the clock, as when the clock was fast as the record was written and
 * has been set back since, may not have come yet, so it proves nothing, and
 * the answer for it is "unknown". The one way it can say "different" for the
 * record's own process is a clock set back, between the process's start and
 * the record's write, which Qwen Code makes as it starts, by more than a
 * minute and the time between the two.
 *
 * `ps` gives a start time to the second, and Linux's `ps` works it out again
 * from the clock each time, so it moves when the clock is set. So a start up to
 * a minute after `startedAt` still counts as the record's own process, as a
 * start within a minute of `procStart` does for Claude Code.
 */

/** A record's pid, when its process registered the session, and its start token, as Qwen Code wrote them. */
export interface RecordProcess {
  pid: number;
  startedAt: number | null;
  /** `<boot id>:<start>`, written on Linux. None elsewhere. */
  procStart?: string | null;
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

/**
 * Whether the process with a record's pid now, whose start token is `token`,
 * is the one that wrote the record's `procStart`: "same" when the two are the
 * same, "different" when not, and "unknown" when either is missing.
 */
export function recordTokenMatch(
  procStart: string | null | undefined,
  token: string | undefined,
): StartMatch {
  if (procStart === null || procStart === undefined || token === undefined) return "unknown";
  return procStart === token ? "same" : "different";
}

export interface RecordProcessCheck {
  /**
   * Each of these records, with whether the process that has its pid now is
   * the one that wrote it. One that cannot be compared, as when nothing was
   * said about its process or it has nothing to compare, is "unknown".
   */
  matches<T extends RecordProcess>(records: readonly T[]): Promise<Map<T, StartMatch>>;
}

interface Remembered {
  match: StartMatch;
  at: number;
}

/** How one check reads processes and compares a record with what it read. */
interface Comparison {
  read: (pids: readonly number[]) => Promise<Map<number, string>>;
  /** What an answer is remembered by, or null for a record with nothing to compare. */
  keyOf: (record: RecordProcess) => string | null;
  compare: (record: RecordProcess, value: string | undefined, now: number) => StartMatch;
}

/**
 * Remembers each answer for 30 seconds, so a poll every two seconds does not
 * mean a read every two seconds. When any record's answer is due, every record
 * that can be checked is asked about in that one read. A record that is not
 * asked about is forgotten.
 */
function rememberingCheck(
  comparison: Comparison,
  now: () => number,
  ttlMs: number,
): RecordProcessCheck {
  const remembered = new Map<string, Remembered>();

  return {
    async matches<T extends RecordProcess>(records: readonly T[]) {
      const at = now();
      const keyed = records.map((record) => ({ record, key: comparison.keyOf(record) }));
      const checkable = keyed.filter(
        (item): item is { record: T; key: string } => item.key !== null,
      );
      const due = checkable.some(({ key }) => {
        const known = remembered.get(key);
        // A clock that was set back counts as time enough.
        return known === undefined || at < known.at || at - known.at >= ttlMs;
      });

      if (due) {
        let read = new Map<number, string>();
        try {
          read = await comparison.read([...new Set(checkable.map(({ record }) => record.pid))]);
        } catch {
          // No answer. Every comparison below comes out as "unknown".
        }
        for (const { record, key } of checkable) {
          remembered.set(key, { match: comparison.compare(record, read.get(record.pid), at), at });
        }
      }

      const asked = new Set(checkable.map(({ key }) => key));
      for (const key of remembered.keys()) {
        if (!asked.has(key)) remembered.delete(key);
      }
      return new Map(
        keyed.map(({ record, key }): [T, StartMatch] => [
          record,
          (key === null ? undefined : remembered.get(key)?.match) ?? "unknown",
        ]),
      );
    },
  };
}

/**
 * Checks records against `ps`, by `startedAt`, in one run of
 * `ps -o pid=,lstart= -p <pids>` for them all. A record with no `startedAt`
 * is not asked about.
 */
export function createRecordProcessCheck(
  read: ReadProcessStarts = readProcessStartsWithPs,
  now: () => number = Date.now,
  ttlMs: number = START_CHECK_TTL_MS,
): RecordProcessCheck {
  return rememberingCheck(
    {
      read,
      // By pid and `startedAt`: one process can register two sessions.
      keyOf: (record) => (record.startedAt === null ? null : `${record.pid} ${record.startedAt}`),
      compare: (record, start, at) => recordProcessMatch(record.startedAt, start, at),
    },
    now,
    ttlMs,
  );
}

/**
 * Checks records against the start tokens in `/proc`, on Linux. A record with
 * no `procStart` is not asked about.
 */
export function createRecordTokenCheck(
  read: ReadStartTokens = createStartTokenReader(),
  now: () => number = Date.now,
  ttlMs: number = START_CHECK_TTL_MS,
): RecordProcessCheck {
  return rememberingCheck(
    {
      read,
      keyOf: (record) =>
        record.procStart === null || record.procStart === undefined
          ? null
          : `${record.pid} ${record.procStart}`,
      compare: (record, token) => recordTokenMatch(record.procStart, token),
    },
    now,
    ttlMs,
  );
}
