import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";

/** The variable that names the binary outright. */
export const CLAUDE_BIN_ENV = "AGENT_LOOKOUT_CLAUDE_BIN";

export type BinarySearch =
  | { found: true; path: string }
  | {
      found: false;
      /** Plain-language account of where it looked, ready to drop into a sentence. */
      looked: string;
    };

export interface FindBinaryOptions {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  /** Replaced in tests. Resolves true when the path is a file this user can run. */
  isExecutable?: (candidate: string) => Promise<boolean>;
}

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

/**
 * The places a `claude` binary is installed when it is not on `PATH`. An app
 * launched from the Finder or the Dock does not inherit the shell's `PATH`, so
 * without these a desktop build would never find it.
 */
export function fixedLocations(homeDir: string): string[] {
  return [
    path.join(homeDir, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

/** Where a program of this name would be in each `PATH` directory, in order. */
export function pathCandidates(env: NodeJS.ProcessEnv, program = "claude"): string[] {
  return (
    (env.PATH ?? "")
      .split(path.delimiter)
      // A relative or empty entry means "the current directory". Running whatever
      // has that name there is not something a monitor should do.
      .filter((dir) => dir !== "" && path.isAbsolute(dir))
      .map((dir) => path.join(dir, program))
  );
}

/**
 * Finds the `claude` binary: `AGENT_LOOKOUT_CLAUDE_BIN` if set, then `PATH`, then
 * the fixed locations.
 *
 * When the variable is set it is the only place looked. Someone who names a
 * binary means that binary; quietly running a different one would hide their
 * mistake and defeat the use of the variable to point the adapter away from the
 * real installation.
 */
export async function findClaudeBinary(options: FindBinaryOptions): Promise<BinarySearch> {
  const isExecutable = options.isExecutable ?? isExecutableFile;

  const named = options.env[CLAUDE_BIN_ENV]?.trim();
  if (named) {
    // The person chose this path themselves, so a relative one is taken as given.
    const resolved = path.resolve(named);
    if (await isExecutable(resolved)) return { found: true, path: resolved };
    return {
      found: false,
      looked: `${CLAUDE_BIN_ENV} is set to ${named}, which is not a program this user can run`,
    };
  }

  const fixed = fixedLocations(options.homeDir);
  const candidates = [...new Set([...pathCandidates(options.env), ...fixed])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { found: true, path: candidate };
  }

  const fixedDirs = fixed.map((candidate) => tildify(path.dirname(candidate), options.homeDir));
  return {
    found: false,
    looked: `The claude command was not found on PATH or in ${listWithOr(fixedDirs)}`,
  };
}

/** Shortens a path under the home directory to `~/...` for display. */
export function tildify(target: string, homeDir: string): string {
  if (homeDir === "" || homeDir === path.sep) return target;
  if (target === homeDir) return "~";
  if (target.startsWith(homeDir + path.sep)) return `~${target.slice(homeDir.length)}`;
  return target;
}

function listWithOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
