import type { FxPrograms } from "../../../core/mapping/fx/fxMapping.ts";
import { WRITE_TIME_STEP_MS } from "../../../core/time.ts";
import { runPs } from "../../processes/ps.ts";
import type { RunPs } from "../opencode/processes.ts";

/**
 * Which fx programs run, from `ps`, so a session can be shown as finished once
 * none does, or once none could have made its last write.
 *
 * fx holds a lock on a file in each session's folder while a process has the
 * session open, and the system lets it go when the process ends, however it
 * ends. That lock is the only sign fx gives that a session is open, and
 * Agent Lookout never takes or tries it: trying it can make an fx that opens
 * the session at that moment fail. A session's log names no process. So this
 * says which fx programs run, never which session one has.
 *
 * fx is one program built from Zig, named `fx` (`build.zig`), and its
 * installer puts it in `~/.local/bin` (`README.md`). A process whose program
 * is `fx`, or a path ending in `/fx`, is taken for it. Anything else called
 * `fx`, such as a JSON viewer of that name, counts too: it can keep a session
 * from showing as finished, and nothing more (`fxMapping.ts`). fx run through
 * Node, as its library libfx is, shows as `node`, and is not seen.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o pid=,comm=`, each process's ID and the name it gives its
 * program, and nothing else. Each line is compared with the name, and only
 * the IDs of programs called `fx` are kept, in memory. The rest of a process's
 * arguments, and its environment, are never asked for. It is run on macOS and
 * Linux only.
 */

/** Each process's ID and the name it gives its program, and nothing else about any of them. */
export const FX_TABLE_ARGS = ["-A", "-o", "pid=,comm="] as const;

/** The name of fx's program. */
export const FX_PROGRAM = "fx";

/** What `ps` said: the IDs of the fx programs it lists, or that it could not say. */
export type FxProcessAnswer =
  | { ok: false }
  | {
      ok: true;
      /** The IDs of the processes whose program is fx. */
      pids: number[];
      /** How many lines named fx without an ID that could be read. */
      unparsed: number;
    };

const LINE = /^\s*(\d+)\s+(\S.*?)\s*$/;

function isFx(program: string): boolean {
  return program.slice(program.lastIndexOf("/") + 1) === FX_PROGRAM;
}

/** The fx programs in what `ps -A -o pid=,comm=` printed. */
export function fxInTable(stdout: string): { pids: number[]; unparsed: number } {
  const pids: number[] = [];
  let unparsed = 0;
  for (const line of stdout.split("\n")) {
    const match = LINE.exec(line);
    if (match !== null) {
      if (!isFx(match[2])) continue;
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid)) pids.push(pid);
      else unparsed += 1;
    } else if (isFx(line.trim())) {
      unparsed += 1;
    }
  }
  return { pids, unparsed };
}

/** Whether an fx program runs, from an answer. */
export function programsOf(answer: FxProcessAnswer): FxPrograms {
  if (!answer.ok) return "unknown";
  return answer.pids.length === 0 && answer.unparsed === 0 ? "none" : "some";
}

export interface FxProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<FxProcessAnswer>;
}

export function createFxProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): FxProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(FX_TABLE_ARGS);
        return table.ok ? { ok: true, ...fxInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}

/**
 * Since when each fx program that runs is known to run, by `ps`, in memory
 * only: for each fx process ID, the time of an answer it was missing from,
 * when the answer before the one that first listed it was taken, or null when
 * there was none. A process missing from an answer was started after it.
 *
 * It is told only of answers `ps` gave, each at the time taken before `ps`
 * ran. An answer that could not be had changes nothing. When an answer's time
 * runs back from the last one's, as when the clock is set back, every time
 * kept is dropped, so nothing is believed from a clock that moved.
 */
export function createAbsenceTracker() {
  /** The last answer `ps` gave, at its time, and each fx process's time of absence. */
  let last: { at: number; absentAt: Map<number, number | null>; unparsed: number } | null = null;

  return {
    /** Takes note of an answer, asked at `at`. */
    note(answer: FxProcessAnswer, at: number) {
      if (!answer.ok) return;
      const steppedBack = last !== null && at < last.at;
      const absentAt = new Map<number, number | null>();
      for (const pid of answer.pids) {
        let since: number | null;
        if (last === null) since = null;
        else if (last.absentAt.has(pid))
          since = steppedBack ? null : (last.absentAt.get(pid) ?? null);
        else since = steppedBack ? null : last.at;
        absentAt.set(pid, since !== null && since > at ? null : since);
      }
      last = { at, absentAt, unparsed: answer.unparsed };
    },
    /**
     * Whether every fx program running, by the last answer, was missing from
     * an answer taken more than 2 seconds after `writtenAt`, so none of them
     * made that write.
     */
    writerGone(writtenAt: number): boolean {
      if (last === null || last.unparsed > 0 || last.absentAt.size === 0) return false;
      for (const since of last.absentAt.values()) {
        if (since === null || since <= writtenAt + WRITE_TIME_STEP_MS) return false;
      }
      return true;
    },
  };
}

export type AbsenceTracker = ReturnType<typeof createAbsenceTracker>;
