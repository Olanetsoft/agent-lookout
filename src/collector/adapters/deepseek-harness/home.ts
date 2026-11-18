import path from "node:path";

import { pathsOf } from "../../files/paths.ts";

/**
 * Where DeepSeek Harness keeps its sessions. Built from DeepSeek Harness's
 * source at dsh-v0.2.2-rc.3 and not yet checked on a computer running it.
 *
 * DeepSeek Harness's home is the folder `DSH_HOME` names, else `.dsh` in the
 * home folder, on every system (util/home-paths/src/index.ts:12, :18,
 * :70-72, :101-110). Its sessions are in `sessions` there (bundle/base/
 * cordis.patch.yml:138-141). A root set in its settings or a patch layer is
 * not followed, since those files are never read.
 */

/** The variable that names DeepSeek Harness's home, for Agent Lookout alone. */
export const DEEPSEEK_HARNESS_HOME_ENV = "AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME";

/** DeepSeek Harness's own variable for its home. */
export const DSH_HOME_ENV = "DSH_HOME";

export interface DeepseekHarnessHome {
  /** The sessions folder read. */
  sessionsDir: string;
  /** Whether `AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME` named it, when its being missing is an answer. */
  named: boolean;
  /** Whether `DSH_HOME` was set to a folder that is not absolute, and so passed over. */
  relativeHome: boolean;
}

/**
 * The sessions folder, as DeepSeek Harness works out its home:
 *
 * 1. `AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME`, trimmed, when it is not empty.
 * 2. `DSH_HOME` from Agent Lookout's own environment, which counts only when
 *    it is not empty or spaces alone and is not trimmed. `~` alone is the home
 *    folder, and `~/` or `~\` at its start stands for it (:87-91). One that is
 *    still not absolute is passed over: DeepSeek Harness resolves it against
 *    the folder it was started in, which nothing here can know.
 * 3. `.dsh` in the home folder.
 */
export function deepseekHarnessHome(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): DeepseekHarnessHome {
  const own = env[DEEPSEEK_HARNESS_HOME_ENV]?.trim();
  if (own) return { sessionsDir: path.resolve(own, "sessions"), named: true, relativeHome: false };
  const set = env[DSH_HOME_ENV];
  if (set !== undefined && set.trim().length > 0) {
    // `~` stands for this computer's home folder, so what it makes is joined
    // and judged by this computer's rules, and any other value by the system's.
    const tilde = set === "~" || set.startsWith("~/") || set.startsWith("~\\");
    let home = set;
    if (set === "~") home = homeDir;
    else if (tilde) home = path.join(homeDir, set.slice(2));
    if ((tilde ? path : pathsOf(platform)).isAbsolute(home)) {
      return { sessionsDir: path.resolve(home, "sessions"), named: false, relativeHome: false };
    }
    return {
      sessionsDir: path.resolve(homeDir, ".dsh", "sessions"),
      named: false,
      relativeHome: true,
    };
  }
  return {
    sessionsDir: path.resolve(homeDir, ".dsh", "sessions"),
    named: false,
    relativeHome: false,
  };
}

/** The sessions folder alone, for the fingerprint of what this copy of Agent Lookout reads. */
export function deepseekHarnessSessionsDirFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return deepseekHarnessHome(env, homeDir, platform).sessionsDir;
}
