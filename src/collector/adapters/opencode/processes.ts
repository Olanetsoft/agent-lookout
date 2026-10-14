import { runPs, type PsAnswer } from "../../processes/ps.ts";

/**
 * Whether an OpenCode program runs, from `ps`, so its sessions can be shown as
 * finished once none does.
 *
 * The files beside the database cannot say it. OpenCode 1.19.0 closes its
 * database only when its runtime is disposed, which nothing does before the
 * program exits (`packages/core/src/database/sqlite.bun.ts`,
 * `packages/opencode/src/effect/app-runtime.ts`), and Bun's own close at exit
 * moves nothing into the database while a statement is still prepared. So a
 * quit leaves `opencode.db-wal` full, as a crash does.
 *
 * OpenCode's releases are one program built with Bun, named `opencode`
 * (`packages/opencode/script/build.ts`). A process whose program has exactly
 * that name is taken for it: on macOS `ps` prints a process's first argument,
 * such as `opencode` or a full path ending in `/opencode`, and on Linux the
 * name of the file it was started from, cut to 15 characters, which `opencode`
 * fits in. Not known, since OpenCode was not run where this was written:
 * whether every way of installing OpenCode starts it by that name. npm's
 * package keeps the program as `bin/opencode.exe` and puts `opencode` on
 * `PATH` as a link to it. OpenCode started by another name, such as that file
 * itself, from its source with `bun`, or through Node, is not seen, nor is
 * OpenCode's desktop app, which runs OpenCode inside its own program.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and
 * nothing else, as for Antigravity's hub (`../antigravity/app/hubProcess.ts`).
 * Each line is compared with the name and dropped. The rest of a process's
 * arguments are never asked for. It is run on macOS and Linux only.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const OPENCODE_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/** The name of OpenCode's program. */
export const OPENCODE_PROGRAM = "opencode";

/** Whether one line of what `ps -A -o comm=` printed is OpenCode's program: `opencode`, or a path ending in `/opencode`. */
export function opencodeInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return program.slice(program.lastIndexOf("/") + 1) === OPENCODE_PROGRAM;
  });
}

/** Whether an OpenCode program runs, or `ok: false` when that could not be told. */
export type ProcessAnswer = { ok: true; running: boolean } | { ok: false };

/** Runs `ps` with these arguments. Tests pass their own. */
export type RunPs = (args: readonly string[]) => Promise<PsAnswer>;

export interface OpencodeProcessReader {
  /** Asks `ps` now, on macOS and Linux. Elsewhere answers `ok: false` and runs nothing. Never throws. */
  read(): Promise<ProcessAnswer>;
}

export function createOpencodeProcessReader(
  options: { platform?: NodeJS.Platform; run?: RunPs } = {},
): OpencodeProcessReader {
  const run = options.run ?? runPs;
  const platform = options.platform ?? process.platform;
  return {
    async read() {
      if (platform !== "darwin" && platform !== "linux") return { ok: false };
      try {
        const table = await run(OPENCODE_TABLE_ARGS);
        return table.ok ? { ok: true, running: opencodeInTable(table.stdout) } : { ok: false };
      } catch {
        return { ok: false };
      }
    },
  };
}

/**
 * Whether OpenCode may have a session open: every session while an OpenCode
 * program runs, none once none does, and "unknown" when `ps` could not say.
 * A session written after `ps` said none runs is not held open for it: the
 * adapter asks `ps` again soon after such a write (`index.ts`), and only an
 * OpenCode it then sees opens it. So a session written by a program `ps` does
 * not take for OpenCode, such as its desktop app, stays finished.
 */
export function opencodeLiveness(answer: ProcessAnswer): boolean | "unknown" {
  if (!answer.ok) return "unknown";
  return answer.running;
}
