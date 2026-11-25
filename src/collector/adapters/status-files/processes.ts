import { EARLIEST_PLAUSIBLE_TIME_MS, plausibleTime } from "../../../core/time.ts";
import {
  processStartTime,
  SAME_START_WITHIN_MS,
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
} from "../../processes/processStart.ts";

/**
 * Telling whether a status file's process still runs.
 *
 * An agent that is killed leaves its file behind, and the system later gives
 * its pid to another program. Signal 0 then says the process runs, for as long
 * as that program does.
 *
 * - A process found gone never comes back. So a file whose process was found
 *   gone is left behind, whoever gets its pid, until it is written again: its
 *   modified time or its pid is another.
 * - On a Mac `ps` says when each process that runs started. An agent that names
 *   its own pid started before it wrote its file, so a process that started
 *   more than a minute after the later of the file's modified time and a
 *   `since` that could be right was given the pid since.
 *
 * That second rule acts only when it is sure, and is not used:
 *
 * - For a process whose start was seen ahead of the clock. A fast clock gave
 *   it, and it says nothing of when, also once the clock has passed it.
 * - For a file seen written, or seen to appear, between two polls that listed
 *   the folder, while the process that ran then has its pid. The times can be
 *   wrong, as of a copy that kept an older time, and the write is not.
 * - For a file whose modified time is before 2020, as of a disk that keeps none.
 *
 * On Linux `ps` works a start out again from the clock each time, and Windows
 * has no `ps`, so there a pid that another program has before its process was
 * found gone is not told from the agent's.
 */

/** A status file that names a process, as last read. */
export interface NamedProcess {
  fileName: string;
  pid: number;
  mtimeMs: number;
  since?: number;
}

/** What is known of a file's process while the file stands as it was written. */
interface Seen {
  pid: number;
  mtimeMs: number;
  /** Its process was found gone, or to be another program's. */
  gone: boolean;
  /** Its write was seen: it changed or appeared between two polls. */
  written: boolean;
  /** When the process started that had the pid as the write was seen. */
  writerStart: number | null;
}

/** What `ps` last said of one process. */
interface Start {
  startedAt: number | null;
  /** When `ps` was asked. */
  at: number;
  /** This start was seen ahead of the clock. */
  ahead: boolean;
}

export interface StatusFileProcesses {
  /**
   * The names of those files whose process still runs. `listed` is every
   * status file in the folder, so one that is not read this time is not forgotten.
   */
  running(
    files: readonly NamedProcess[],
    listed: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>>;
  /** Says the folder could not be listed, so what is in it next may have been there all along. */
  notListed(): void;
}

export function createStatusFileProcesses(options: {
  isAlive: (pid: number) => boolean;
  /** Reads when processes started, or null where `ps` is not asked. */
  readStarts: ReadProcessStarts | null;
  now: () => number;
}): StatusFileProcesses {
  const { isAlive, readStarts, now } = options;
  const seen = new Map<string, Seen>();
  let lastListed: ReadonlySet<string> | null = null;
  let starts = new Map<number, Start>();

  /**
   * Asks when these processes started, all in one run of `ps`, when one was not
   * asked about in the last 30 seconds. It goes by pid, so an agent that writes
   * its file often does not make it run more. A run that says nothing of a
   * process leaves what was known of it.
   */
  async function askStarts(read: ReadProcessStarts, pids: ReadonlySet<number>): Promise<void> {
    const before = starts;
    starts = new Map();
    for (const pid of pids) {
      const known = before.get(pid);
      // A clock set back counts as time enough.
      const age = known === undefined ? -1 : now() - known.at;
      if (known !== undefined && age >= 0 && age < START_CHECK_TTL_MS) starts.set(pid, known);
    }
    if (starts.size === pids.size) return;

    const answer = await read([...pids]).catch(() => new Map<number, string>());
    const at = now();
    for (const pid of pids) {
      const known = before.get(pid);
      const startedAt = processStartTime(answer.get(pid) ?? "") ?? known?.startedAt ?? null;
      const wasAhead = known !== undefined && known.ahead && known.startedAt === startedAt;
      starts.set(pid, {
        startedAt,
        at,
        ahead: wasAhead || (startedAt !== null && startedAt > at),
      });
    }
  }

  /** Whether the process with a file's pid started after the file was last written. */
  function startedSince(file: NamedProcess, entry: Seen): boolean {
    const start = starts.get(file.pid);
    if (start === undefined || start.startedAt === null || start.ahead) return false;
    if (entry.written) {
      entry.writerStart ??= start.startedAt;
      if (entry.writerStart === start.startedAt) return false;
    }
    if (file.mtimeMs < EARLIEST_PLAUSIBLE_TIME_MS) return false;
    const lastSaid = Math.max(file.mtimeMs, plausibleTime(file.since, now()) ?? 0);
    return start.startedAt > lastSaid + SAME_START_WITHIN_MS;
  }

  return {
    async running(files, listed) {
      for (const name of seen.keys()) if (!listed.has(name)) seen.delete(name);
      const held: { file: NamedProcess; entry: Seen }[] = [];
      for (const file of files) {
        const { fileName, pid, mtimeMs } = file;
        const before = seen.get(fileName);
        const entry =
          before?.pid === pid && before.mtimeMs === mtimeMs
            ? before
            : {
                pid,
                mtimeMs,
                gone: false,
                written: lastListed !== null && (before !== undefined || !lastListed.has(fileName)),
                writerStart: null,
              };
        seen.set(fileName, entry);
        if (!entry.gone && !isAlive(pid)) entry.gone = true;
        if (!entry.gone) held.push({ file, entry });
      }
      lastListed = listed;

      if (readStarts !== null) {
        await askStarts(readStarts, new Set(held.map(({ file }) => file.pid)));
        for (const { file, entry } of held) entry.gone = startedSince(file, entry);
      }
      return new Set(held.filter(({ entry }) => !entry.gone).map(({ file }) => file.fileName));
    },
    notListed() {
      lastListed = null;
    },
  };
}
