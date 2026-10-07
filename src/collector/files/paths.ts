import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Paths, as more than one part of the collector needs them: where a program of
 * a name would be on `PATH`, whether a file can be run, and a path under the
 * home folder written short. The Claude Code adapter looks for `claude` with
 * them, and the tmux runner for `tmux`; every adapter says where it reads in
 * the short form.
 *
 * Each takes the system it works for, this one's unless a test says another,
 * and uses that system's own rules for paths: Windows', with drive letters,
 * backslashes, `;` between the folders of `PATH` and no regard to case, or
 * those of macOS and Linux.
 */

/** The path rules of a system: Windows', or those of macOS and Linux. */
export function pathsOf(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

/**
 * The endings of a program Windows starts by itself, with no shell. A `.cmd`
 * or `.bat` is a script that only `cmd.exe` runs, and Agent Lookout never runs
 * a shell, so neither is ever taken for a program.
 */
const WINDOWS_PROGRAM_ENDINGS = [".com", ".exe"];

/** Whether a file's name ends as a program Windows starts by itself: `.exe` or `.com`. */
export function isWindowsProgram(file: string): boolean {
  return WINDOWS_PROGRAM_ENDINGS.includes(path.win32.extname(file).toLowerCase());
}

/**
 * Whether a path is a file, not a directory, that this user may run. Windows
 * has no execute bit, so there it is a `.exe` or a `.com` that is there.
 */
export async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform === "win32" && !isWindowsProgram(candidate)) return false;
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The value of a variable such as `PATH`. Windows keeps it under any case,
 * most often `Path`, and a copy of the environment, unlike `process.env`
 * there, is not read without regard to case.
 */
export function variable(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32" || env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((each) => each.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The endings Windows tries a bare program name with, in the order `PATHEXT`
 * gives them, of those it starts with no shell: `.com` and `.exe`.
 */
function programEndings(env: NodeJS.ProcessEnv): string[] {
  const listed = (variable(env, "PATHEXT", "win32") ?? "")
    .split(";")
    .map((ending) => ending.trim().toLowerCase())
    .filter((ending) => WINDOWS_PROGRAM_ENDINGS.includes(ending));
  return listed.length > 0 ? [...new Set(listed)] : WINDOWS_PROGRAM_ENDINGS;
}

/** The absolute folders on `PATH`, in order. */
export function pathFolders(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths = pathsOf(platform);
  return (
    (variable(env, "PATH", platform) ?? "")
      .split(paths.delimiter)
      // Windows allows a folder in quotes, for one with a `;` in its name.
      .map((dir) => (platform === "win32" ? dir.trim().replace(/^"(.*)"$/, "$1") : dir))
      // A relative or empty entry means "the current directory". Running whatever
      // has that name there is not something a monitor should do.
      .filter((dir) => dir !== "" && paths.isAbsolute(dir))
  );
}

/**
 * The names a program is looked for by in a folder of `PATH`. On Windows a
 * bare name is tried with each ending of `PATHEXT` that Windows starts with no
 * shell, `.com` and `.exe`, as a shell there would try it.
 */
export function programNames(
  env: NodeJS.ProcessEnv,
  program: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || isWindowsProgram(program)) return [program];
  return programEndings(env).map((ending) => `${program}${ending}`);
}

/** Where a program of this name would be in each `PATH` directory, in order. */
export function pathCandidates(
  env: NodeJS.ProcessEnv,
  program: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths = pathsOf(platform);
  const names = programNames(env, program, platform);
  return pathFolders(env, platform).flatMap((dir) => names.map((name) => paths.join(dir, name)));
}

/**
 * Shortens a path under the home directory to `~/...` for display. On Windows
 * the rest of the path is written with `/` too, so a folder reads the same on
 * every system, `~/.claude/sessions`, and a path is under the home folder
 * whatever the case of its letters. A path anywhere else is shown as it is.
 */
export function tildify(
  target: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (homeDir === "") return target;
  if (platform !== "win32") {
    if (homeDir === "/") return target;
    if (target === homeDir) return "~";
    if (target.startsWith(`${homeDir}/`)) return `~${target.slice(homeDir.length)}`;
    return target;
  }
  const home = path.win32.resolve(homeDir);
  // A home folder that is a drive's root would make every path on it short.
  if (path.win32.parse(home).root === home) return target;
  const inside = path.win32.relative(home, path.win32.resolve(target));
  if (inside === "") return "~";
  if (inside === ".." || inside.startsWith("..\\") || path.win32.isAbsolute(inside)) return target;
  return `~/${inside.replaceAll("\\", "/")}`;
}
