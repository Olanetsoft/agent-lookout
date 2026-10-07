import { execFile } from "node:child_process";

import { isExecutableFile, pathCandidates } from "../files/paths.ts";

/** The variable that, set to `off`, stops tmux being run at all. */
export const TMUX_ENV = "AGENT_LOOKOUT_TMUX";

/** How long one tmux command gets. It normally answers in a few milliseconds. */
export const TMUX_TIMEOUT_MS = 2_000;

/** Far more than a list of panes needs, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The places tmux is installed when it is not on `PATH`: Homebrew's two homes,
 * MacPorts and the system's own. An app launched from the Finder or the Dock
 * does not inherit the shell's `PATH`, so without these it would never find it.
 */
export const TMUX_LOCATIONS = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/opt/local/bin/tmux",
  "/usr/bin/tmux",
] as const;

/** The tmux binary: the first on `PATH`, then the fixed locations. Null when there is none. */
export async function findTmuxBinary(
  env: NodeJS.ProcessEnv,
  isExecutable?: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  isExecutable ??= (candidate) => isExecutableFile(candidate, platform);
  const candidates = [...new Set([...pathCandidates(env, "tmux", platform), ...TMUX_LOCATIONS])];
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export type TmuxResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      /** What tmux printed about the failure, or nothing when it said nothing or never ran. */
      stderr: string;
    };

/** Runs tmux with these arguments. It never rejects: a failure is an answer. */
export type RunTmux = (args: readonly string[]) => Promise<TmuxResult>;

/** The answer when no tmux was started: none is installed, or it is turned off. */
const NOT_RUN: TmuxResult = { ok: false, stderr: "" };

/**
 * Starts one tmux binary directly, with no shell between, stdin closed and a
 * timeout. The arguments reach tmux as they are given, one by one, so nothing
 * in them is read by a shell.
 */
export function runTmuxBinary(
  binary: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<TmuxResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        binary,
        [...args],
        {
          env: options.env,
          timeout: options.timeoutMs ?? TMUX_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) resolve({ ok: false, stderr: String(stderr ?? "").trim() });
          else resolve({ ok: true, stdout: String(stdout ?? "") });
        },
      );
      child.stdin?.end();
    } catch {
      resolve({ ok: false, stderr: "" });
    }
  });
}

export interface TmuxRunnerOptions {
  /**
   * The collector's environment. `PATH` is where tmux is looked for first, and
   * tmux itself is given this environment unchanged, so it reaches the server
   * the `tmux` command would reach from where Agent Lookout was started: the
   * default one, or the one named by `TMUX` when it was started inside tmux.
   */
  env: NodeJS.ProcessEnv;
  /** Replaced in tests. Resolves true when the path is a file this user can run. */
  isExecutable?: (candidate: string) => Promise<boolean>;
  timeoutMs?: number;
  /** The system the runner is on. On Windows, which has no tmux, nothing is run. Defaults to this one. */
  platform?: NodeJS.Platform;
}

/**
 * What the collector runs tmux with.
 *
 * The binary is looked for on each run, so tmux installed or removed while the
 * collector runs is noticed. When there is none, nothing is started. Nor is
 * anything started on Windows, or when `AGENT_LOOKOUT_TMUX` is `off`.
 */
export function createTmuxRunner(options: TmuxRunnerOptions): RunTmux {
  const { env } = options;
  const off = env[TMUX_ENV]?.trim().toLowerCase() === "off";
  const platform = options.platform ?? process.platform;

  return async (args) => {
    if (off || platform === "win32") return NOT_RUN;
    const binary = await findTmuxBinary(env, options.isExecutable, platform);
    if (binary === null) return NOT_RUN;
    return runTmuxBinary(binary, args, { env, timeoutMs: options.timeoutMs });
  };
}
