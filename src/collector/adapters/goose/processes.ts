import { runPs } from "../../processes/ps.ts";
import type { ProcessAnswer, RunPs } from "../opencode/processes.ts";

/**
 * Whether a Goose program runs, from `ps`, so its sessions can be shown as
 * finished once none does.
 *
 * That is as near as anyone outside Goose can come. A session's row names no
 * process, and Goose writes no lock or pid file for a session. The same program
 * serves the terminal and the desktop app, one process can hold many sessions,
 * as `goose serve` does for the desktop app, and the rest of a process's
 * arguments are never read here. So this says whether any Goose runs, never which
 * session it has.
 *
 * A process whose program has exactly one of the names below is taken for it: on
 * macOS `ps` prints a process's first argument, such as `goose` or a full path
 * ending in `/goose`, and on Linux the name of the file it was started from, cut
 * to 15 characters, which each name fits in. The desktop app's window has a
 * program of its own, `Goose`, which is not one of them: what counts is the
 * server it starts. Anything else that happens to be called `goose` counts too,
 * and only keeps a session from showing as finished.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and nothing
 * else, as for OpenCode (`../opencode/processes.ts`). Each line is compared with
 * the names and dropped. It is run on macOS and Linux only.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const GOOSE_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/**
 * The names of Goose's programs:
 *
 * goose      the command, and the server the desktop app starts, `goose serve`
 * goosed     the desktop app's server up to Goose v1.41.0
 * goose-acp  the server built on its own for ACP clients
 */
export const GOOSE_PROGRAMS: ReadonlySet<string> = new Set(["goose", "goosed", "goose-acp"]);

/** Whether one line of what `ps -A -o comm=` printed is Goose's program: one of its names, or a path ending in one. */
export function gooseInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return GOOSE_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
  });
}

export interface GooseProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<ProcessAnswer>;
}

export function createGooseProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): GooseProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(GOOSE_TABLE_ARGS);
        return table.ok ? { ok: true, running: gooseInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}
