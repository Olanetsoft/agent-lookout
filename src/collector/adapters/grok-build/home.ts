import path from "node:path";

import { pathsOf } from "../../files/paths.ts";

/**
 * Where Grok Build keeps its files. Built from Grok Build's source at 1.0.45
 * (commit 2bdd1d6) and not yet checked on a machine running it.
 *
 * Grok Build's home is the folder `GROK_HOME` names, used as it is when it is
 * not empty, else `.grok` in the home folder, `%USERPROFILE%\.grok` on Windows
 * (`xai-dirs/src/lib.rs:33-59`). Its list of open sessions and its `sessions`
 * folder are in it. Grok Build itself is never looked for or run.
 */

/** The variable that names Grok Build's home, for Agent Lookout alone. */
export const GROK_BUILD_HOME_ENV = "AGENT_LOOKOUT_GROK_HOME";

/** Grok Build's own variable for its home. */
export const GROK_HOME_ENV = "GROK_HOME";

/** Grok Build's home in the home folder, on every system. */
export const GROK_DIR = ".grok";

export interface GrokBuildHome {
  /** The folder read. */
  home: string;
  /** Whether `AGENT_LOOKOUT_GROK_HOME` named it, when its being empty is an answer. */
  named: boolean;
  /** Whether `GROK_HOME` named it. */
  fromGrokHome: boolean;
  /** Whether `GROK_HOME` was set to a folder that is not a whole path, and so passed over. */
  passedOver: boolean;
}

/**
 * The folder read, as Grok Build works out its home:
 *
 * 1. `AGENT_LOOKOUT_GROK_HOME`, trimmed, when it is not empty.
 * 2. `GROK_HOME` from Agent Lookout's own environment, as it is, when it is
 *    not empty. Grok Build takes it as it is, with no `~` and no trimming, so
 *    one that is not a whole path on this system's rules, `~` among them, is
 *    passed over: Grok Build reads it from the folder it was started in,
 *    which nothing here can know.
 * 3. `.grok` in the home folder.
 *
 * The value of `GROK_HOME` is judged by the system's rules as it is, before
 * anything is joined to it.
 */
export function grokBuildHome(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): GrokBuildHome {
  const own = env[GROK_BUILD_HOME_ENV]?.trim();
  if (own) {
    return { home: path.resolve(own), named: true, fromGrokHome: false, passedOver: false };
  }
  const set = env[GROK_HOME_ENV];
  const fallback = path.resolve(homeDir, GROK_DIR);
  if (set !== undefined && set !== "") {
    if (pathsOf(platform).isAbsolute(set)) {
      return { home: path.resolve(set), named: false, fromGrokHome: true, passedOver: false };
    }
    return { home: fallback, named: false, fromGrokHome: false, passedOver: true };
  }
  return { home: fallback, named: false, fromGrokHome: false, passedOver: false };
}

/** The folder read alone, for the fingerprint of what this copy of Agent Lookout reads. */
export function grokBuildHomeFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return grokBuildHome(env, homeDir, platform).home;
}
