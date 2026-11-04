import { runPs } from "../../processes/ps.ts";
import type { ProcessAnswer, RunPs } from "../opencode/processes.ts";

/**
 * Whether a Crush program runs, from `ps`, so its sessions can be shown as
 * finished once none does.
 *
 * That is as near as anyone outside Crush can come. A session's row names no
 * process, and in its usual mode Crush writes no lock or pid file. The name of a
 * program does not say which project it works in, and nothing else about a
 * process is read here. So this says whether any Crush runs, never which session
 * it has.
 *
 * A process whose program is exactly `crush` is taken for it: on macOS `ps`
 * prints a process's first argument, such as `crush` or a full path ending in
 * `/crush`, and on Linux the name of the file it was started from, cut to 15
 * characters, which the name fits in. `crush run` and `crush server` have the
 * same name. Anything else that happens to be called `crush` counts too, and only
 * keeps a session from showing as finished.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and nothing
 * else, as for OpenCode (`../opencode/processes.ts`). Each line is compared with
 * the name and dropped. It is run on macOS and Linux only.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const CRUSH_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/** The name of Crush's program, in every way it is installed. */
export const CRUSH_PROGRAM = "crush";

/** Whether one line of what `ps -A -o comm=` printed is Crush's program: its name, or a path ending in it. */
export function crushInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return program.slice(program.lastIndexOf("/") + 1) === CRUSH_PROGRAM;
  });
}

export interface CrushProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<ProcessAnswer>;
}

export function createCrushProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): CrushProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(CRUSH_TABLE_ARGS);
        return table.ok ? { ok: true, running: crushInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}
