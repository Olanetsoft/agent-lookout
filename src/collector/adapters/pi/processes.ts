import { runPs } from "../../processes/ps.ts";
import type { ProcessAnswer, RunPs } from "../opencode/processes.ts";

/**
 * Whether a `pi` program runs, from `ps`, so its sessions can be shown as
 * finished once none does.
 *
 * That is as near as anyone outside Pi can come. A session file names no process,
 * and Pi writes no lock or pid file for a session. One process can move from one
 * session to the next, with `/new`, `/resume` or `/fork`, and the rest of a
 * process's arguments are never read here. So this says whether any `pi` runs,
 * never which session it has.
 *
 * Pi is a Node program, or one built with Bun, and it sets `process.title` as it
 * starts (`packages/coding-agent/src/cli/setup.ts`, `src/bun/runtime-setup.ts`
 * and `src/rpc-entry.ts`). So `ps` shows the name below, not `node`: on macOS it
 * prints the title Node writes over a process's first argument, and on Linux the
 * name Node gives the process. A process whose program has exactly one of the
 * names is taken for Pi. Anything else that happens to be called `pi` counts too,
 * and only keeps a session from showing as finished.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and nothing
 * else, as for OpenCode (`../opencode/processes.ts`). Each line is compared with
 * the names and dropped. It is run on macOS and Linux only.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const PI_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/**
 * The names of Pi's program:
 *
 * pi      the command, in each of its modes
 * pi-rpc  the entry point another program can start for RPC
 */
export const PI_PROGRAMS: ReadonlySet<string> = new Set(["pi", "pi-rpc"]);

/** Whether one line of what `ps -A -o comm=` printed is Pi's program: one of its names, or a path ending in one. */
export function piInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return PI_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
  });
}

export interface PiProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<ProcessAnswer>;
}

export function createPiProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): PiProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(PI_TABLE_ARGS);
        return table.ok ? { ok: true, running: piInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}
