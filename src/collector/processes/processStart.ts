import { runPs } from "./ps.ts";

/**
 * Telling whether a pid still belongs to the process a registry file was
 * written for.
 *
 * A registry file outlives a crashed session, and the system hands its pid to
 * another program sooner or later. "Is this pid alive" then says yes for a
 * session that is long gone. Claude Code guards against this by recording
 * `procStart`, the process's start time as `ps` prints it, and comparing it
 * with what `ps` prints later. This module does the same.
 *
 * The comparison only ever removes an entry when it is sure. If `ps` cannot be
 * run, or the recorded value is not in the form `ps` prints, the answer is
 * "unknown" and the entry is kept: wrongly hiding every real session would be
 * far worse than showing one leftover.
 */

/** When each of the given processes started, by pid. A pid `ps` says nothing about is left out. */
export type ReadProcessStarts = (pids: readonly number[]) => Promise<Map<number, string>>;

export type StartMatch = "same" | "different" | "unknown";

/** How long an answer for one pid is trusted before `ps` is asked again. */
export const START_CHECK_TTL_MS = 30_000;

/** What `ps -o lstart=` prints in the C locale, once runs of spaces are collapsed. */
const LSTART_SHAPE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Compares the start time a registry file recorded with the one `ps` reports now.
 *
 * Only two values that both look like `ps` output and differ are "different".
 * Anything that cannot be compared is "unknown".
 */
export function compareProcessStart(
  recorded: string | undefined,
  actual: string | undefined,
): StartMatch {
  if (recorded === undefined || actual === undefined) return "unknown";
  const before = collapse(recorded);
  const now = collapse(actual);
  if (before === "" || now === "") return "unknown";
  if (before === now) return "same";
  return LSTART_SHAPE.test(before) && LSTART_SHAPE.test(now) ? "different" : "unknown";
}

/**
 * Asks `ps` when the given processes started, in one run.
 *
 * `LC_ALL=C` and `TZ=UTC` are what Claude Code itself uses when it writes
 * `procStart`, so the two strings can be compared as they are. `ps` is run
 * directly, never through a shell, and found on a fixed `PATH`.
 */
export const readProcessStartsWithPs: ReadProcessStarts = async (pids) => {
  const starts = new Map<number, string>();
  if (pids.length === 0) return starts;
  const answer = await runPs(["-o", "pid=,lstart=", "-p", pids.join(",")], { utc: true });
  // `ps` reports an error when one of the pids has gone and still prints the
  // others, so the output is read whatever the exit code was.
  for (const line of answer.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (match) starts.set(Number(match[1]), match[2] as string);
  }
  return starts;
};

export interface ProcessStartCheck {
  /**
   * The pids, among the given entries, that now belong to a different process
   * from the one the entry was written for.
   */
  reused(entries: readonly { pid: number; procStart?: string }[]): Promise<Set<number>>;
}

interface Remembered {
  recorded: string;
  match: StartMatch;
  at: number;
}

/**
 * Checks entries against `ps`, remembering each answer for a short while so a
 * poll every two seconds does not mean a `ps` every two seconds.
 *
 * When any entry's answer is due, every entry that can be checked is asked
 * about in that one run. One `ps` costs the same for one pid as for many, and
 * the answers then fall due together: sessions that started at different times
 * still cost one `ps` every 30 seconds between them, not one each.
 */
export function createProcessStartCheck(
  read: ReadProcessStarts = readProcessStartsWithPs,
  now: () => number = Date.now,
  ttlMs: number = START_CHECK_TTL_MS,
): ProcessStartCheck {
  const remembered = new Map<number, Remembered>();

  return {
    async reused(entries) {
      const at = now();
      const checkable: { pid: number; recorded: string }[] = [];
      const current = new Set<number>();
      let due = false;

      for (const entry of entries) {
        current.add(entry.pid);
        // An entry that recorded no start time cannot be checked.
        if (entry.procStart === undefined) continue;
        checkable.push({ pid: entry.pid, recorded: entry.procStart });
        const known = remembered.get(entry.pid);
        const fresh =
          known !== undefined &&
          known.recorded === entry.procStart &&
          at - known.at < ttlMs &&
          at >= known.at;
        if (!fresh) due = true;
      }
      const toAsk = due ? checkable : [];

      if (toAsk.length > 0) {
        let starts = new Map<number, string>();
        try {
          starts = await read(toAsk.map((item) => item.pid));
        } catch {
          // No answer. Every comparison below comes out as "unknown".
        }
        for (const { pid, recorded } of toAsk) {
          remembered.set(pid, {
            recorded,
            match: compareProcessStart(recorded, starts.get(pid)),
            at,
          });
        }
      }

      // Forget pids whose registry file has gone, so the map cannot grow for ever.
      for (const pid of remembered.keys()) {
        if (!current.has(pid)) remembered.delete(pid);
      }

      const reused = new Set<number>();
      for (const entry of entries) {
        if (entry.procStart === undefined) continue;
        if (remembered.get(entry.pid)?.match === "different") reused.add(entry.pid);
      }
      return reused;
    },
  };
}
