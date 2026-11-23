import path from "node:path";

import { pathsOf } from "../../files/paths.ts";

/**
 * Where Copilot CLI keeps its sessions. Built from GitHub's docs and
 * open-source readers, never checked on a computer running Copilot CLI.
 *
 * Copilot keeps its configuration, session history and logs in one folder,
 * `~/.copilot`, `%USERPROFILE%\.copilot` on Windows, and `COPILOT_HOME`
 * replaces that whole path (GitHub's config-directory reference). Its
 * sessions are in `session-state` there. Nothing else is read for where it
 * is: not `--config-dir`, which a running Copilot may have been given, not
 * any `XDG_*` variable, not `COPILOT_CACHE_HOME`, and nothing in Copilot's
 * `config.json` or `settings.json`.
 */

/** The variable that names Copilot CLI's folder, `~/.copilot`, for Agent Lookout alone. */
export const COPILOT_CLI_HOME_ENV = "AGENT_LOOKOUT_COPILOT_HOME";

/** Copilot CLI's own variable for its folder. */
export const COPILOT_HOME_ENV = "COPILOT_HOME";

/** Copilot CLI's folder in the home folder, on every system. */
export const COPILOT_DIR = ".copilot";

/** The folder of sessions in Copilot CLI's folder. */
export const SESSION_STATE_DIR = "session-state";

export interface CopilotCliHome {
  /** Copilot CLI's folder. */
  home: string;
  /** Its `session-state` folder, which is read. */
  sessionsDir: string;
  /** Whether `AGENT_LOOKOUT_COPILOT_HOME` named it, when its being missing is an answer. */
  named: boolean;
  /** Whether `COPILOT_HOME` named it. */
  fromCopilotHome: boolean;
  /** Whether `COPILOT_HOME` was set to a folder that is not a whole path, and so passed over. */
  passedOver: boolean;
}

/**
 * Copilot CLI's folder, the first rule that applies:
 *
 * 1. `AGENT_LOOKOUT_COPILOT_HOME`, trimmed, when it is not empty.
 * 2. `COPILOT_HOME` from Agent Lookout's own environment, as it is, when it
 *    is not empty and a whole path on this system's rules. One that is not
 *    is passed over: Copilot would read it from the folder it was started
 *    in, which nothing here can know.
 * 3. `.copilot` in the home folder.
 */
export function copilotCliHome(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): CopilotCliHome {
  const of = (home: string, named: boolean, fromCopilotHome: boolean, passedOver: boolean) => ({
    home,
    sessionsDir: path.join(home, SESSION_STATE_DIR),
    named,
    fromCopilotHome,
    passedOver,
  });
  const own = env[COPILOT_CLI_HOME_ENV]?.trim();
  if (own) return of(path.resolve(own), true, false, false);
  const set = env[COPILOT_HOME_ENV];
  const fallback = path.resolve(homeDir, COPILOT_DIR);
  if (set !== undefined && set !== "") {
    if (pathsOf(platform).isAbsolute(set)) return of(path.resolve(set), false, true, false);
    return of(fallback, false, false, true);
  }
  return of(fallback, false, false, false);
}

/** The sessions folder alone, for the fingerprint of what this copy of Agent Lookout reads. */
export function copilotCliSessionsDirFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return copilotCliHome(env, homeDir, platform).sessionsDir;
}
