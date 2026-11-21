import path from "node:path";

/**
 * Where Muse Code keeps its sessions. Built from Meta's documentation and not
 * yet checked on a computer running Muse Code.
 *
 * Muse Code's data folder is `muse` in `XDG_DATA_HOME`, else
 * `~/.local/share/muse`, and its sessions are in `sessions` there (Meta's
 * host-operations guide at 1.4, and its cookbook's replay recipe). Meta
 * documents no other folder for Windows, so there `%USERPROFILE%\.local\share\muse`
 * is assumed. `MUSE_DATA_DIR`, `MUSE_HOME` and `MUSE_SESSIONS_DIR` are in no
 * Meta source and are not read, nor is anything in Muse Code's settings,
 * `~/.config/muse`, nor any process's arguments or environment.
 *
 * Every folder is joined with `node:path`, on this computer's rules.
 */

/** The variable that names Muse Code's data folder, `~/.local/share/muse`, for Agent Lookout alone. */
export const MUSE_CODE_HOME_ENV = "AGENT_LOOKOUT_MUSE_CODE_HOME";

/** The XDG variable that moves Muse Code's data folder. */
export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";

export interface MuseCodeHome {
  /** The sessions folder read. */
  sessionsDir: string;
  /** Whether `AGENT_LOOKOUT_MUSE_CODE_HOME` named it, when its being missing is an answer. */
  named: boolean;
  /** Whether a setting gave it, so the default folder's note on Windows is not said. */
  set: boolean;
  /** Whether `XDG_DATA_HOME` was set to a folder that is not absolute, and so passed over. */
  xdgRelative: boolean;
}

/**
 * The sessions folder, the first rule that applies:
 *
 * 1. `AGENT_LOOKOUT_MUSE_CODE_HOME`, trimmed, when it is not empty: the data
 *    folder, which holds `sessions`.
 * 2. `XDG_DATA_HOME` from Agent Lookout's own environment, not trimmed, when
 *    it is set, not empty and absolute: `muse` in it. One that is not
 *    absolute is passed over, as the XDG Base Directory rules say such a value
 *    is not valid.
 * 3. `.local/share/muse` in the home folder.
 */
export function museCodeHome(env: NodeJS.ProcessEnv, homeDir: string): MuseCodeHome {
  const own = env[MUSE_CODE_HOME_ENV]?.trim();
  if (own) {
    return {
      sessionsDir: path.join(path.resolve(own), "sessions"),
      named: true,
      set: true,
      xdgRelative: false,
    };
  }
  const xdg = env[XDG_DATA_HOME_ENV];
  if (xdg !== undefined && xdg !== "" && path.isAbsolute(xdg)) {
    return {
      sessionsDir: path.join(path.resolve(xdg, "muse"), "sessions"),
      named: false,
      set: true,
      xdgRelative: false,
    };
  }
  return {
    sessionsDir: path.resolve(homeDir, ".local", "share", "muse", "sessions"),
    named: false,
    set: false,
    xdgRelative: xdg !== undefined && xdg !== "",
  };
}

/** The sessions folder alone, for the fingerprint of what this copy of Agent Lookout reads. */
export function museCodeSessionsDirFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  return museCodeHome(env, homeDir).sessionsDir;
}
