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
 * OpenCode's releases are one program built with Bun. A process whose program
 * has exactly one of the names below is taken for it: on macOS `ps` prints a
 * process's first argument, such as `opencode` or a full path ending in
 * `/opencode`, and on Linux the name of the file it was started from, cut to
 * 15 characters, which each name fits in. Not known, since OpenCode was not
 * run where this was written: whether every way of installing OpenCode starts
 * it by one of them. OpenCode started from its source with `bun` or through
 * Node is not seen, nor is OpenCode 1.x's desktop app, which runs OpenCode
 * inside its own program.
 *
 * OpenCode 2's background service owns every session, and keeps running once
 * the window that started it closes, until something stops it, such as
 * `opencode service stop` or a restart of the computer. Each client starts it
 * from its own file, and it sets no `process.title` (`selfCommand` in
 * `packages/cli/src/util/process.ts` at v2.2.5, `ensure` in
 * `packages/client/src/effect/service.ts`). So it shows under that file's name,
 * which for npm's package is not the `opencode` on `PATH`.
 *
 * One run, direct, never through a shell, from `/usr/bin` or `/bin`, in the C
 * locale: `ps -A -o comm=`, the name each process gives its program and
 * nothing else, as for Antigravity's hub (`../antigravity/app/hubProcess.ts`).
 * Each line is compared with the names and dropped. The rest of a process's
 * arguments are never asked for. It is run on macOS and Linux only.
 */

/** The name each process gives its program, and nothing else about any of them. */
export const OPENCODE_TABLE_ARGS = ["-A", "-o", "comm="] as const;

/**
 * The names of OpenCode's program:
 *
 * opencode      what the install script, Homebrew and `PATH` call it, and 1.x's name
 * opencode.exe  the file npm's package keeps it in, which OpenCode 2 starts its
 *               service from, on macOS and Linux as well
 * opencode2     npm's second link to that file, for OpenCode 2
 * opencode-cli  the copy OpenCode 2's desktop app keeps and starts its service from
 */
export const OPENCODE_PROGRAMS: ReadonlySet<string> = new Set([
  "opencode",
  "opencode.exe",
  "opencode2",
  "opencode-cli",
]);

/** Whether one line of what `ps -A -o comm=` printed is OpenCode's program: one of its names, or a path ending in one. */
export function opencodeInTable(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    const program = line.trim();
    return OPENCODE_PROGRAMS.has(program.slice(program.lastIndexOf("/") + 1));
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
 * not take for OpenCode, such as OpenCode 1.x's desktop app, stays finished.
 */
export function opencodeLiveness(answer: ProcessAnswer): boolean | "unknown" {
  if (!answer.ok) return "unknown";
  return answer.running;
}
