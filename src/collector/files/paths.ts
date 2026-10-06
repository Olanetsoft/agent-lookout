import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Paths, as more than one part of the collector needs them: where a program of
 * a name would be on `PATH`, whether a file can be run, and a path under the
 * home folder written short. The Claude Code adapter looks for `claude` with
 * them, and the tmux runner for `tmux`; every adapter says where it reads in
 * the short form.
 */

/** Whether a path is a file, not a directory, that this user may run. */
export async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where a program of this name would be in each `PATH` directory, in order. */
export function pathCandidates(env: NodeJS.ProcessEnv, program: string): string[] {
  return (
    (env.PATH ?? "")
      .split(path.delimiter)
      // A relative or empty entry means "the current directory". Running whatever
      // has that name there is not something a monitor should do.
      .filter((dir) => dir !== "" && path.isAbsolute(dir))
      .map((dir) => path.join(dir, program))
  );
}

/** Shortens a path under the home directory to `~/...` for display. */
export function tildify(target: string, homeDir: string): string {
  if (homeDir === "" || homeDir === path.sep) return target;
  if (target === homeDir) return "~";
  if (target.startsWith(homeDir + path.sep)) return `~${target.slice(homeDir.length)}`;
  return target;
}
