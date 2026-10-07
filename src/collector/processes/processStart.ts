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

/**
 * How far apart two start times can be and still be one process's.
 *
 * procps, the `ps` of Linux, does not keep a process's start time: it works it
 * out each time from the time the system booted, and that moves whenever the
 * clock is set, as it often is after waking from sleep. So the same process can
 * print a start time a second or more away from the one Claude Code recorded
 * when it started, which it never records again. A pid is given out again only
 * after every other pid has been, tens of thousands on a Mac and up to millions
 * on Linux, so a new process with the same pid that started within a minute of
 * the old one is not a case that happens. A clock set by more than this still
 * makes a running session look like a leftover.
 */
export const SAME_START_WITHIN_MS = 60_000;

/**
 * How far apart two start times can be for a process to be ended as the one a
 * registry file was written for: one second, the most `lstart`, which counts in
 * whole seconds, can move by when Linux's `ps` works it out again. A minute is
 * right for leaving a session in the list, where a mistake shows one leftover,
 * and too much for sending a signal, where a mistake ends another program. A
 * clock set by more than a second while a session runs leaves it with no Stop
 * that works until it is restarted.
 */
export const SAME_START_TO_STOP_WITHIN_MS = 1_000;

/**
 * What `ps -o lstart=` prints in the C locale, once runs of spaces are
 * collapsed: `Tue Oct 6 04:09:12 2026`. The `ps` of macOS and the BSDs and the
 * `ps` of Linux, procps, both print it this way.
 */
const LSTART_SHAPE = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * The moment a collapsed `lstart` value names, in milliseconds, read as UTC as
 * both Claude Code and this module ask `ps` for it. Undefined for any other value.
 */
function lstartMs(value: string): number | undefined {
  const match = LSTART_SHAPE.exec(value);
  const month = MONTHS.indexOf(match?.[1] ?? "");
  if (!match || month === -1) return undefined;
  const [day, hours, minutes, seconds, year] = match.slice(2).map(Number) as number[];
  return Date.UTC(year as number, month, day, hours, minutes, seconds);
}

/**
 * When a process started, from what `ps -o lstart=` printed with `TZ=UTC`, in
 * epoch milliseconds, to the second. Null for anything not in that form.
 */
export function processStartTime(value: string): number | null {
  return lstartMs(collapse(value)) ?? null;
}

/**
 * Compares the start time a registry file recorded with the one `ps` reports now.
 *
 * Only two values that both look like `ps` output and are more than a minute
 * apart are "different", or more than `withinMs` apart when that is given.
 * Anything that cannot be compared is "unknown".
 */
export function compareProcessStart(
  recorded: string | undefined,
  actual: string | undefined,
  withinMs: number = SAME_START_WITHIN_MS,
): StartMatch {
  if (recorded === undefined || actual === undefined) return "unknown";
  const before = collapse(recorded);
  const now = collapse(actual);
  if (before === "" || now === "") return "unknown";
  if (before === now) return "same";
  const beforeMs = lstartMs(before);
  const nowMs = lstartMs(now);
  if (beforeMs === undefined || nowMs === undefined) return "unknown";
  return Math.abs(beforeMs - nowMs) <= withinMs ? "same" : "different";
}

/** The arguments that ask `ps` when each of these processes started, and nothing else. */
export function psStartArgs(pids: readonly number[]): string[] {
  return ["-o", "pid=,lstart=", "-p", pids.join(",")];
}

/**
 * Reads what `ps -o pid=,lstart= -p <pids>` printed: each pid and its start
 * time, as printed. The padding differs between the `ps` of macOS and that of
 * Linux, and does not matter. A line that is not a pid and a time is left out.
 */
export function parseProcessStarts(stdout: string): Map<number, string> {
  const starts = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line);
    if (match) starts.set(Number(match[1]), match[2] as string);
  }
  return starts;
}

/**
 * Asks `ps` when the given processes started, in one run.
 *
 * `LC_ALL=C` and `TZ=UTC` are what Claude Code itself uses when it writes
 * `procStart`, so the two strings can be compared as they are. `ps` is run
 * directly, never through a shell, and found on a fixed `PATH`.
 */
export const readProcessStartsWithPs: ReadProcessStarts = async (pids) => {
  if (pids.length === 0) return new Map();
  const answer = await runPs(psStartArgs(pids), { utc: true });
  // `ps` reports an error when one of the pids has gone and still prints the
  // others, so the output is read whatever the exit code was.
  return parseProcessStarts(answer.stdout);
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
