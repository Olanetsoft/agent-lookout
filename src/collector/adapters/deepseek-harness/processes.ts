import type { DeepseekHarnessWriter } from "../../../core/mapping/deepseek-harness/deepseekHarnessMapping.ts";
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
 * program that could write it started after its last write, or the computer
 * started after it.
 *
 * Its command `dsh` is a Node.js script that names no title, so `ps` shows
 * it as `node` (apps/cli/src/bin.ts). Its desktop app, and the host that app
 * starts from the same program, show as `DeepSeek Harness`
 * (apps/desktop/scripts/electron-builder-config.mjs:119, apps/desktop/src/
 * main.ts:209, host-process.ts:211-224). On Linux the desktop app's program
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

/** A line of the table: pid, `lstart` (five words) and the program, which can hold spaces. */
const TABLE_LINE =
  /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

/** One program that could write a session. */
export interface DshProgram {
  /** When it started, or null when that cannot be read. */
  start: number | null;
  /** Whether it is the desktop app. */
  desktop: boolean;
}

/** What `ps` said: the programs that could write a session, and whether Agent Lookout's own process was among the lines. */
export type DshPrograms = { ok: false } | { ok: true; ownListed: boolean; programs: DshProgram[] };

/** Every program of these names in what `ps -A -o pid=,lstart=,comm=` printed, but Agent Lookout's own. */
export function dshInTable(stdout: string, ownPid: number): DshPrograms {
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
    const desktop = DESKTOP_PROGRAMS.has(name);
    if (!desktop && !NODE_PROGRAMS.has(name)) continue;
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
}): DshProcessReader {
  const { platform, run, ownPid } = options;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(DSH_TABLE_ARGS, { utc: true });
        return table.ok ? dshInTable(table.stdout, ownPid) : { ok: false };
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
  /** When the session or a subagent's log was last written, or null when that cannot be right. */
  writtenAt: number | null;
  /** When the computer started, or null when not known. */
  bootAt: number | null;
  /** What `ps` last said, and when it was asked. */
  answer: DshPrograms | null;
  answerAt: number;
}

/**
 * Whether a program that could write a session may still run, on macOS and
 * Linux:
 *
 * - None could when its last write was more than a minute before the
 *   computer started, or when `ps`, asked at or after that write, shows no
 *   such program that started before it, or within a minute after, as Linux
 *   can move a start by that much. A start that cannot be read counts as
 *   before.
 * - The desktop app backs it when such a program of its names runs.
 * - Otherwise one may. So it is on Windows, with no time that can be right,
 *   when `ps` could not say, and when its table did not list Agent Lookout's
 *   own process.
 */
export function dshWriter(input: WriterInput): DeepseekHarnessWriter {
  const { platform, writtenAt, bootAt, answer, answerAt } = input;
  if ((platform !== "darwin" && platform !== "linux") || writtenAt === null) return "maybe";
  if (bootAt !== null && writtenAt < bootAt - SAME_START_WITHIN_MS) return "gone";
  if (!usable(answer)) return "maybe";
  const before = answer.programs.filter(
    ({ start }) => start === null || start <= writtenAt + SAME_START_WITHIN_MS,
  );
  if (answerAt >= writtenAt && before.length === 0) return "gone";
  return before.some(({ desktop }) => desktop) ? "backed" : "maybe";
}
