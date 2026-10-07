import path from "node:path";

import {
  isExecutableFile,
  pathCandidates,
  pathFolders,
  pathsOf,
  programNames,
  tildify,
  variable,
} from "../../files/paths.ts";

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
  /** The system to look on, which says where. Defaults to this one. */
  platform?: NodeJS.Platform;
}

/**
 * Where npm keeps Claude Code's own program, under the folder it puts the
 * command `claude.cmd` in: from Claude Code 2.1.113 on, the package's command
 * is `bin/claude.exe`, and `claude.cmd` is a script that runs it. Agent
 * Lookout runs no script, so it runs the program the script would.
 */
export const NPM_PROGRAM = ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"];

/** npm's folder for commands on Windows: `%APPDATA%\npm`. */
function npmFolder(env: NodeJS.ProcessEnv, homeDir: string): string {
  const appData = variable(env, "APPDATA", "win32")?.trim();
  return appData && path.win32.isAbsolute(appData)
    ? path.win32.join(appData, "npm")
    : path.win32.join(homeDir, "AppData", "Roaming", "npm");
}

/**
 * The places a `claude` binary is installed when it is not on `PATH`. An app
 * launched from the Finder or the Dock does not inherit the shell's `PATH`, so
 * without these a desktop build would never find it.
 *
 * `~/.local/bin` is the native installer's, on a Mac and on Linux. Homebrew's
 * and npm's usual folder follow. The last two are for Linux: `~/.npm-global/bin`
 * is where npm installs after the setup its own guide gives for installing
 * without root, and `/usr/bin` where it installs when Node itself is there. The
 * Mac's three come first, in the order they always had.
 *
 * On Windows they are the native installer's `%USERPROFILE%\.local\bin\claude.exe`,
 * then the program an npm install keeps under `%APPDATA%\npm`.
 */
export function fixedLocations(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = {},
): string[] {
  if (platform === "win32") {
    return [
      path.win32.join(homeDir, ".local", "bin", "claude.exe"),
      path.win32.join(npmFolder(env, homeDir), ...NPM_PROGRAM),
    ];
  }
  return [
    path.posix.join(homeDir, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.posix.join(homeDir, ".npm-global", "bin", "claude"),
    "/usr/bin/claude",
  ];
}

/**
 * Where `claude` would be in each `PATH` folder, in order. On Windows that is
 * `claude.com` or `claude.exe`, and then `NPM_PROGRAM` under the folder, the
 * program that the `claude.cmd` npm puts in its folder runs. Each folder is
 * looked in for it whether a `claude.cmd` is there or not.
 */
function onPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return pathCandidates(env, "claude", platform);
  const names = programNames(env, "claude", platform);
  return pathFolders(env, platform).flatMap((dir) => [
    ...names.map((name) => path.win32.join(dir, name)),
    path.win32.join(dir, ...NPM_PROGRAM),
  ]);
}

/** A script that only a shell runs, which Agent Lookout never starts. */
const WINDOWS_SCRIPT = /\.(bat|cmd|ps1)$/i;

/**
 * Finds the `claude` binary: `AGENT_LOOKOUT_CLAUDE_BIN` if set, then `PATH`, then
 * the fixed locations.
 *
 * When the variable is set it is the only place looked. Someone who names a
 * binary means that binary; quietly running a different one would hide their
 * mistake and defeat the use of the variable to point the adapter away from the
 * real installation.
 *
 * On Windows only a program is run, a `.exe` or a `.com`, and never a `.cmd`
 * or a `.bat`, which would need a shell between Agent Lookout and it. Since
 * the 2024 fix for running those safely, Node refuses to start one without a
 * shell anyway.
 */
export async function findClaudeBinary(options: FindBinaryOptions): Promise<BinarySearch> {
  const platform = options.platform ?? process.platform;
  const paths = pathsOf(platform);
  const isExecutable =
    options.isExecutable ?? ((candidate: string) => isExecutableFile(candidate, platform));

  const named = options.env[CLAUDE_BIN_ENV]?.trim();
  if (named) {
    // The person chose this path themselves, so a relative one is taken as given.
    const resolved = paths.resolve(named);
    if (await isExecutable(resolved)) return { found: true, path: resolved };
    const why =
      platform === "win32" && WINDOWS_SCRIPT.test(resolved)
        ? "a script that needs a shell to run, and Agent Lookout runs no shell"
        : "not a program this user can run";
    return { found: false, looked: `${CLAUDE_BIN_ENV} is set to ${named}, which is ${why}` };
  }

  const fixed = fixedLocations(options.homeDir, platform, options.env);
  const candidates = [...new Set([...onPath(options.env, platform), ...fixed])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return { found: true, path: candidate };
  }

  if (platform === "win32") {
    const places = [paths.dirname(fixed[0] as string), npmFolder(options.env, options.homeDir)].map(
      (place) => tildify(place, options.homeDir, platform),
    );
    return {
      found: false,
      looked: `The claude command, claude.exe, was not found on PATH or in ${listWithOr(places)}`,
    };
  }
  const fixedDirs = fixed.map((candidate) =>
    tildify(paths.dirname(candidate), options.homeDir, platform),
  );
  return {
    found: false,
    looked: `The claude command was not found on PATH or in ${listWithOr(fixedDirs)}`,
  };
}

function listWithOr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
