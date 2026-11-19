import type { DeepseekHarnessWriter } from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
import { WRITE_TIME_STEP_MS } from "../../../core/time.ts";
import type { FileInfo } from "../../files/readOnlyIo.ts";
import { processStartTime, SAME_START_WITHIN_MS } from "../../processes/processStart.ts";
import type { RunPs } from "../antigravity/cli/agyProcesses.ts";

/**
 * Whether a program that could still write a DeepSeek Harness session runs,
 * from `ps` and from when the computer started. Built from DeepSeek
 * Harness's source at dsh-v0.2.2-rc.3 and not yet checked on a computer
 * running it.
 *
 * Nothing DeepSeek Harness writes marks an open session: its only marker is
 * a lock on `session.lock`, which is never touched (session-persistence-
 * jsonl/src/lease.ts:19), and no pid is written. A program writes to a
 * session only after it started. So a session is finished once every
 * program that could write it started after its last write, by a `ps` asked
 * 2 seconds or more after that write, as a disk can keep a write's time in
 * whole seconds or steps of 2 seconds, rounded down, or once the computer
 * started after it.
 *
 * Its command `dsh` is a Node.js script that names no title, so `ps` shows
 * it as `node` (apps/cli/src/bin.ts). Its desktop app, and the host that app
 * starts from the same program, show as `DeepSeek Harness`
 * (apps/desktop/scripts/electron-builder-config.mjs:119, apps/desktop/src/
 * main.ts:210, host-process.ts:211-224). On Linux the desktop app's program
 * is named from its package, `@deepseek-aidsh-desktop`, which Linux cuts to
 * its first 15 characters, `@deepseek-aidsh`; that was worked out from the
 * builder's rules and not seen. A process whose program has one of these
 * names, or a path ending in one, is taken for one that could write a
 * session. Any other `node` counts too, which can keep a session from
 * showing as finished, and nothing more.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale and in UTC (`../../processes/ps.ts`): `ps -A -o pid=,lstart=,comm=`,
 * each process's ID, when it started and the name it gives its program, and
 * nothing else. Of each line only whether it is Agent Lookout's own and, for
 * one of the names above, when it started and whether it is the desktop
 * app's, is kept, and the rest is dropped. The rest of a process's
 * arguments, its owner and its environment are never asked for. It is run on
 * macOS and Linux only.
 *
 * Oh My Pi's adapter asks and judges `ps` with this too, with names of its
 * own (`../oh-my-pi/index.ts`): `omp` and `.omp-wrapped` back a session as
 * the desktop app's names do here, and on macOS `bun` is one that may write
 * it, as `node` is here. So does when `ps` is asked (`createDshProcessAsker`).
 * Muse Code's adapter does too (`../muse-code/index.ts`): `muse`, `muse.exe`
 * and any name that begins `muse-` back a session, by `backingPrefix`, and no
 * name may write one.
 */

/** Each process's ID, when it started and the name it gives its program, and nothing else. */
export const DSH_TABLE_ARGS = ["-A", "-o", "pid=,lstart=,comm="] as const;

/** The names of the programs that could write a session: its command's and its desktop app's. */
export const NODE_PROGRAMS: ReadonlySet<string> = new Set(["node", "nodejs"]);
export const DESKTOP_PROGRAMS: ReadonlySet<string> = new Set([
  "DeepSeek Harness",
  "@deepseek-aidsh-desktop",
  "@deepseek-aidsh",
]);

/**
 * The names a table is read for: those of a program that backs a session,
 * as DeepSeek Harness's desktop app does, and those of one that may write
 * one, as any `node` may. With `backingPrefix`, a name that begins with it
 * and has more after it backs a session too, as Muse Code's running names
 * differ between installs.
 */
export interface DshNames {
  backing: ReadonlySet<string>;
  backingPrefix?: string;
  maybe: ReadonlySet<string>;
}

/** Whether a program's name, without its folders, is one that backs a session. */
export function backs(name: string, names: DshNames): boolean {
  if (names.backing.has(name)) return true;
  const prefix = names.backingPrefix;
  return prefix !== undefined && name.length > prefix.length && name.startsWith(prefix);
}

/** DeepSeek Harness's names, which a table is read for when no others are given. */
export const DSH_NAMES: DshNames = { backing: DESKTOP_PROGRAMS, maybe: NODE_PROGRAMS };

/** A line of the table: pid, `lstart` (five words) and the program, which can hold spaces. */
const TABLE_LINE =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

/** One program that could write a session. */
export interface DshProgram {
  /** When it started, or null when that cannot be read. */
  start: number | null;
  /**
   * Whether it is the desktop app: one of the backing names. For Oh My Pi
   * it is a program named `omp` or `.omp-wrapped`, and for Muse Code one
   * named `muse`, `muse.exe` or beginning `muse-`.
   */
  desktop: boolean;
}

/** What `ps` said: the programs that could write a session, and whether Agent Lookout's own process was among the lines. */
export type DshPrograms = { ok: false } | { ok: true; ownListed: boolean; programs: DshProgram[] };

/** Every program of these names in what `ps -A -o pid=,lstart=,comm=` printed, but Agent Lookout's own. */
export function dshInTable(
  stdout: string,
  ownPid: number,
  names: DshNames = DSH_NAMES,
): DshPrograms {
  const programs: DshProgram[] = [];
  let ownListed = false;
  for (const line of stdout.split("\n")) {
    const match = TABLE_LINE.exec(line);
    if (match === null) continue;
    if (Number(match[1]) === ownPid) {
      ownListed = true;
      continue;
    }
    const program = match[3] as string;
    const name = program.slice(program.lastIndexOf("/") + 1);
    const desktop = backs(name, names);
    if (!desktop && !names.maybe.has(name)) continue;
    programs.push({ start: processStartTime(match[2] as string), desktop });
  }
  return { ok: true, ownListed, programs };
}

export interface DshProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<DshPrograms>;
}

export function createDshProcessReader(options: {
  platform: NodeJS.Platform;
  run: RunPs;
  ownPid: number;
  /** The names looked for. Defaults to DeepSeek Harness's. */
  names?: DshNames;
}): DshProcessReader {
  const { platform, run, ownPid } = options;
  const names = options.names ?? DSH_NAMES;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(DSH_TABLE_ARGS, { utc: true });
        return table.ok ? dshInTable(table.stdout, ownPid, names) : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}

/** Whether `ps` answered with a table that can be trusted: one that lists Agent Lookout's own process. */
export function usable(answer: DshPrograms | null): answer is DshPrograms & { ok: true } {
  return answer !== null && answer.ok && answer.ownListed;
}

export interface WriterInput {
  platform: NodeJS.Platform;
  /** The newest write of the session's log, or a subagent's, whose time can be right, or null when none can. */
  writtenAt: number | null;
  /** When the computer started, the earliest the adapter has worked it out to be while it runs, or null when not known. */
  bootAt: number | null;
  /** What `ps` last said, and when it was asked. */
  answer: DshPrograms | null;
  answerAt: number;
  /** Whether that answer was asked because the clock was set back, and the logs behind this write are unchanged since the poll that asked it: then nothing is allowed for a rounded write time. */
  clockSetBack?: boolean;
  /** The clock guard's bounds (`DshClockGuard`): a last write stamped at or after `lowAt` and before `startFloor` is not finished by the start rule. */
  startFloor: number;
  lowAt: number;
}

/** What the clock guard keeps between polls, in memory only. */
export interface DshClockGuard {
  /** The latest time a poll had seen when the clock was set back: a write stamped at or after it may be finished by the start rule. */
  startFloor: number;
  /** No later than the time the clock was set back to: a write stamped before it was made before every set-back seen, so it may be finished by the start rule too. */
  lowAt: number;
  /** The latest time a poll has seen. */
  highAt: number;
  /** The last poll's time on the clock that can be set and on one that cannot, or null before the first. */
  last: { wall: number; mono: number } | null;
}

export const startDshClockGuard = (): DshClockGuard => ({
  startFloor: -Infinity,
  lowAt: Infinity,
  highAt: -Infinity,
  last: null,
});

/**
 * The guard after one more poll at `wall`, with `mono` from a clock that is
 * never set. On macOS a start stays as it was taken, so after the clock is
 * set back by more than a minute a program that started before then looks
 * started after the writes it makes since. A write stamped between the time
 * the clock was set back to and the latest time a poll saw is then not
 * finished by the start rule. The clock read no less than this poll's time,
 * less the time since the last poll, when it was set back, so a write stamped
 * earlier was made before then, on the clock the starts were taken on. That
 * time is read with `mono`, which stops while the Mac sleeps.
 */
export function guardDshClock(
  guard: DshClockGuard,
  platform: NodeJS.Platform,
  wall: number,
  mono: number,
): DshClockGuard {
  let { startFloor, lowAt } = guard;
  if (platform === "darwin" && wall < guard.highAt - SAME_START_WITHIN_MS) {
    startFloor = Math.max(startFloor, guard.highAt);
    // The clock read no less than this when it was set back, so no write since is stamped earlier.
    const elapsed = guard.last === null ? 0 : Math.max(0, mono - guard.last.mono);
    lowAt = Math.min(lowAt, wall - elapsed);
  }
  return { startFloor, lowAt, highAt: Math.max(guard.highAt, wall), last: { wall, mono } };
}

/**
 * Whether a program that could write a session may still run, on macOS and
 * Linux:
 *
 * - None could when its last write was more than a minute before the
 *   computer started, or when `ps`, asked 2 seconds or more after that write,
 *   as a disk can keep a write's time rounded down, shows no such program
 *   that started before it, or within a minute after, as Linux can move a
 *   start by that much. A start that cannot be read counts as before. An
 *   answer asked because the clock was set back allows nothing for that, for
 *   logs unchanged since the poll that asked it. On macOS, once a poll's time
 *   is more than a minute behind the latest one seen, a write stamped between
 *   the time the clock was set back to and that latest time is never finished
 *   this way while such a program runs.
 * - The desktop app backs it when such a program of its names runs.
 * - Otherwise one may. So it is on Windows, with no time that can be right,
 *   when `ps` could not say, and when its table did not list Agent Lookout's
 *   own process.
 */
export function dshWriter(input: WriterInput): DeepseekHarnessWriter {
  const { platform, writtenAt, bootAt, answer, answerAt, startFloor, lowAt } = input;
  if ((platform !== "darwin" && platform !== "linux") || writtenAt === null) return "maybe";
  if (bootAt !== null && writtenAt < bootAt - SAME_START_WITHIN_MS) return "gone";
  if (!usable(answer)) return "maybe";
  const before = answer.programs.filter(
    ({ start }) => start === null || start <= writtenAt + SAME_START_WITHIN_MS,
  );
  const step = input.clockSetBack === true ? 0 : WRITE_TIME_STEP_MS;
  // A program that started after the write finishes it only outside the clock guard's bounds.
  const startsTrusted =
    answer.programs.length === 0 || writtenAt >= startFloor || writtenAt < lowAt;
  if (answerAt >= writtenAt + step && before.length === 0 && startsTrusted) return "gone";
  return before.some(({ desktop }) => desktop) ? "backed" : "maybe";
}

/**
 * How soon `ps` is asked again when a session is written after it showed no
 * program of the names looked for, or up to 2 seconds before, as a disk can
 * keep a write's time rounded down, since one may have been started since.
 */
export const PROMPT_PROCESS_CHECK_MS = 2_000;

/** A file as a poll found it, by its `lstat` or as it was read: where it is, and its identity, size and time. */
export interface StampedFile {
  path: string;
  info: Pick<FileInfo, "ino" | "size" | "mtimeMs">;
}

/** When `ps` is asked, and what is kept of its last answer, from one poll to the next. */
export interface DshProcessAsker {
  /**
   * What `ps` says, asked again when it is due: every `processCheckMs`, and
   * sooner, though not within 2 seconds of the last ask, when a session was
   * written after an answer that listed no program of the names looked for,
   * or up to 2 seconds before, as a disk can keep a write's time rounded
   * down. A clock set back counts as time enough. When it is asked because
   * the clock was set back, each file this poll found is kept as it was
   * found. `writes` are the last writes of the sessions `ps` could change,
   * null for one whose time cannot be right.
   */
  programsFor(
    checkedAt: number,
    writes: readonly (number | null)[],
    files: readonly StampedFile[],
  ): Promise<DshPrograms>;
  /** Whether a file is as the poll that asked the answer in use found it, once the clock was set back. */
  asAsked(file: StampedFile): boolean;
  /**
   * When the computer started, the earliest worked out while this runs, after
   * one more look on this poll: the clock less `uptimeMs()`. Both count sleep,
   * so it moves only when the clock is set, by as much, and a clock set
   * forward cannot move it past writes made before then. Null where `ps` is
   * not asked, on a system other than macOS and Linux.
   */
  bootAt(checkedAt: number): number | null;
  /** What `ps` last said, null before it was first asked. */
  readonly lastAnswer: DshPrograms | null;
  /** When that answer was asked. */
  readonly answerAt: number;
  /** Whether that answer was asked because the clock was set back. */
  readonly clockSetBack: boolean;
}

/**
 * What asks `ps` for DeepSeek Harness's adapter, Oh My Pi's and Muse Code's, and keeps
 * its last answer, when it was asked and whether the clock had been set back,
 * with the earliest start of the computer worked out while it runs. It keeps
 * nothing on disk.
 */
export function createDshProcessAsker(options: {
  processes: DshProcessReader;
  platform: NodeJS.Platform;
  /** How often, at most, `ps` is asked. */
  processCheckMs: number;
  /** How long the computer has been on, in milliseconds. */
  uptimeMs: () => number;
}): DshProcessAsker {
  const { processes, platform, processCheckMs, uptimeMs } = options;
  const psRuns = platform === "darwin" || platform === "linux";
  let lastAnswer: DshPrograms | null = null;
  let answerAt = 0;
  let clockSetBack = false;
  /**
   * While it was, each file as the poll that asked it found it. Every write
   * that poll saw came before `ps` was asked. A file changed since may have
   * been written after, so a rounded write time is allowed for again.
   */
  const seenAtAsk = new Map<string, StampedFile["info"]>();
  let bootFloor: number | null = null;

  return {
    async programsFor(checkedAt, writes, files) {
      const since = checkedAt - answerAt;
      let due = lastAnswer === null || since < 0 || since >= processCheckMs;
      if (
        !due &&
        since >= PROMPT_PROCESS_CHECK_MS &&
        usable(lastAnswer) &&
        lastAnswer.programs.length === 0
      ) {
        due = writes.some((at) => at !== null && at + WRITE_TIME_STEP_MS > answerAt);
      }
      if (lastAnswer === null || due) {
        clockSetBack = since < 0;
        seenAtAsk.clear();
        if (clockSetBack) {
          for (const { path: file, info } of files) {
            seenAtAsk.set(file, { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs });
          }
        }
        lastAnswer = await processes.read();
        answerAt = checkedAt;
      }
      return lastAnswer;
    },
    asAsked(file) {
      const seen = seenAtAsk.get(file.path);
      return (
        seen !== undefined &&
        seen.ino === file.info.ino &&
        seen.size === file.info.size &&
        seen.mtimeMs === file.info.mtimeMs
      );
    },
    bootAt(checkedAt) {
      if (!psRuns) return null;
      const seen = checkedAt - uptimeMs();
      if (Number.isFinite(seen) && (bootFloor === null || seen < bootFloor)) bootFloor = seen;
      return bootFloor;
    },
    get lastAnswer() {
      return lastAnswer;
    },
    get answerAt() {
      return answerAt;
    },
    get clockSetBack() {
      return clockSetBack;
    },
  };
}
