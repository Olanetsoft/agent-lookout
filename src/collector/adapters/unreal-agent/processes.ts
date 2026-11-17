import type { UnrealAgentPrograms } from "../../../core/mapping/unreal-agent/unrealAgentLiveness.ts";
import { processStartTime } from "../../processes/processStart.ts";
import { runPs } from "../../processes/ps.ts";
import type { RunPs } from "../antigravity/cli/agyProcesses.ts";

/**
 * When each Unreal Agent program started, from `ps`, so a session can be
 * shown as finished once no program that could hold it runs.
 *
 * Unreal Agent writes no lock or pid file, and a session's file names no
 * process. Its terminal app and its runner each hold one session at most
 * (TUI run.go:202-203, runner run.go:291), and write to it only after they
 * started. So what is asked is when each one started, never which session it
 * has, as for the Antigravity CLI (`../antigravity/cli/agyProcesses.ts`).
 *
 * Unreal Agent is two programs built from Go, `unreal-agent-tui` and
 * `unreal-agent-runner` (.goreleaser.yaml:10, 18). Homebrew also links the
 * first as `unreal-agent` and `uat` (68-70). Linux keeps the first 15
 * characters of a program's name, `unreal-agent-tu` and `unreal-agent-ru`. A
 * process whose program has one of these names, or a path ending in one, is
 * taken for Unreal Agent. Anything else with one of the names, such as another
 * program called `uat`, counts too: it can keep a session from showing as
 * finished, and nothing more.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale and in UTC: `ps -A -o lstart=,comm=`, when each process started and
 * the name it gives its program, and nothing else. Each line is compared with
 * the names, and only the start times of Unreal Agent's programs are kept.
 * Every other line is dropped. The rest of a process's arguments, its owner
 * and its environment are never asked for. It is run on macOS and Linux only.
 */

/** When each process started and the name it gives its program, and nothing else about any of them. */
export const UNREAL_TABLE_ARGS = ["-A", "-o", "lstart=,comm="] as const;

/**
 * The names of Unreal Agent's programs:
 *
 * unreal-agent-tui     the terminal app
 * unreal-agent-runner  the runner, which answers one request and ends
 * unreal-agent, uat    Homebrew's links to the terminal app
 * unreal-agent-tu      the terminal app, as Linux cuts its name
 * unreal-agent-ru      the runner, as Linux cuts its name
 */
export const UNREAL_PROGRAMS: ReadonlySet<string> = new Set([
  "unreal-agent-tui",
  "unreal-agent-runner",
  "unreal-agent",
  "uat",
  "unreal-agent-tu",
  "unreal-agent-ru",
]);

/** A line of the table: `lstart` (five words) and the program, which can hold spaces (agyProcesses.ts). */
const TABLE_LINE =
  /^\s*([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S.*?)\s*$/;

function isUnreal(program: string): boolean {
  return UNREAL_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
}

/**
 * When each Unreal Agent program in what `ps -A -o lstart=,comm=` printed
 * started. A line that names one but whose start cannot be read, or that is
 * not in the table's shape, makes the start unknown.
 */
export function unrealInTable(stdout: string): { starts: number[]; unknownStart: boolean } {
  const starts: number[] = [];
  let unknownStart = false;
  for (const line of stdout.split("\n")) {
    const match = TABLE_LINE.exec(line);
    if (match !== null) {
      if (!isUnreal(match[2] as string)) continue;
      const start = processStartTime(match[1] as string);
      if (start === null) unknownStart = true;
      else starts.push(start);
    } else if (isUnreal(line.trim())) {
      unknownStart = true;
    }
  }
  return { starts, unknownStart };
}

/** Whether `ps` showed no Unreal Agent program at all. */
export function noUnrealIn(answer: UnrealAgentPrograms): boolean {
  return answer.ok && answer.starts.length === 0 && !answer.unknownStart;
}

export interface UnrealProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<UnrealAgentPrograms>;
}

export function createUnrealProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): UnrealProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(UNREAL_TABLE_ARGS, { utc: true });
        return table.ok ? { ok: true, ...unrealInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}
