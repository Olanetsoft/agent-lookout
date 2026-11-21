import path from "node:path";

import { KIMCHI_AGENT_DIR_ENV } from "../pi/profile.ts";

/**
 * Where Oh My Pi keeps its sessions. Built from Oh My Pi's source at v19.0.0
 * and not yet checked on a computer running it.
 *
 * Oh My Pi's agent folder is `agent` in its folder, `~/.omp`, or in
 * `~/.omp/profiles/<name>` for a named profile, and its sessions are in
 * `sessions` there (packages/utils/src/dirs.ts:29, :116-123, :361-367,
 * :1031-1033). `PI_CONFIG_DIR` renames `.omp`, always under the home folder
 * (:332-334). `PI_CODING_AGENT_DIR` names the agent folder of the default
 * profile (:470-506). `PI_CODING_AGENT_SESSION_DIR` names a folder that holds
 * the session files themselves, with no project folders, for every profile
 * (packages/coding-agent/src/cli/args.ts:263). On macOS and Linux, with
 * `XDG_DATA_HOME` set, a session folder of the default agent folder is in
 * `$XDG_DATA_HOME/omp` once that folder is there, and a named profile's in
 * `$XDG_DATA_HOME/omp/profiles/<name>` once that one is (dirs.ts:368-404).
 *
 * Only Agent Lookout's own environment is read. `--session-dir`,
 * `--profile`, `--session`, the `.env` files Oh My Pi loads and the session
 * stores an SDK program can name are never followed.
 *
 * Every folder is joined with `node:path`, on this computer's rules: Oh My Pi
 * joins them so. The system named decides only whether `XDG_DATA_HOME`
 * counts.
 */

/** The variable that names Oh My Pi's agent folder, `~/.omp/agent`, for Agent Lookout alone. */
export const OMP_HOME_ENV = "AGENT_LOOKOUT_OMP_HOME";

/** Oh My Pi's own variables, the same names as Pi's for the first two. */
export const OMP_SESSIONS_ENV = "PI_CODING_AGENT_SESSION_DIR";
export const OMP_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const OMP_CONFIG_DIR_ENV = "PI_CONFIG_DIR";
export const OMP_PROFILE_ENV = "OMP_PROFILE";
export const PI_PROFILE_ENV = "PI_PROFILE";
export const XDG_DATA_HOME_ENV = "XDG_DATA_HOME";

/** Oh My Pi's folder in the home folder, unless `PI_CONFIG_DIR` names another. */
export const OMP_DIR = ".omp";

/** Oh My Pi's name, under which its folder is kept in `XDG_DATA_HOME`. */
const APP_NAME = "omp";

/** A profile's name as Oh My Pi allows one (dirs.ts:43). */
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Names Windows keeps for devices, which Oh My Pi refuses as a profile's on every system (dirs.ts:54). */
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/** What a setting that is not followed was, for the card. */
export type OmpPassedOver = "session-dir" | "agent-dir";

export interface OmpFolders {
  /** The sessions folder read. */
  sessionsDir: string;
  /** Whether the session files sit in it with no project folders, as with `PI_CODING_AGENT_SESSION_DIR`. */
  flat: boolean;
  /** Whether `AGENT_LOOKOUT_OMP_HOME` named it, when its being missing is an answer. */
  named: boolean;
  /** Oh My Pi's settings that are set but not followed, as they are not absolute. */
  passedOver: OmpPassedOver[];
}

/**
 * A profile's name as Oh My Pi reads it: `OMP_PROFILE` when it is set, even
 * to nothing, else `PI_PROFILE`, trimmed (dirs.ts:64-92). Null for the default
 * profile: none, a blank one, `default`, or a name Oh My Pi refuses, as it
 * then does not start.
 */
export function ompProfileOf(value: string | undefined): string | null {
  const name = value?.trim();
  if (!name || name === "default") return null;
  if (name === "." || name === ".." || name.endsWith(".")) return null;
  if (!PROFILE_NAME.test(name) || RESERVED_NAME.test(name)) return null;
  return name;
}

/** The profile in force: `OMP_PROFILE` when set, else `PI_PROFILE`. */
function activeProfile(env: NodeJS.ProcessEnv): string | null {
  const omp = env[OMP_PROFILE_ENV];
  return ompProfileOf(omp !== undefined ? omp : env[PI_PROFILE_ENV]);
}

/** Oh My Pi's folder, `~/.omp` or `~/<PI_CONFIG_DIR>`, joined under the home folder whatever it is. */
function configRoot(env: NodeJS.ProcessEnv, homeDir: string): string {
  return path.join(homeDir, env[OMP_CONFIG_DIR_ENV] || OMP_DIR);
}

/**
 * The folder whose being there decides where the sessions are, or null when
 * none does. On macOS and Linux, with `XDG_DATA_HOME` a whole path and no
 * setting that names another folder first, it is `$XDG_DATA_HOME/omp`, or
 * `$XDG_DATA_HOME/omp/profiles/<name>` for a named profile. A relative
 * `XDG_DATA_HOME` is not followed: Oh My Pi would look for it in the folder
 * it was started in, which nothing here can know.
 */
export function ompXdgProbe(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): string | null {
  return plan(env, homeDir, platform).probe;
}

interface Plan {
  /** The answer when the probe is not there, or when there is none. */
  plain: OmpFolders;
  /** The folder whose being there gives `xdg`, or null. */
  probe: string | null;
  /** The answer when it is. */
  xdg: OmpFolders | null;
}

function plan(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform): Plan {
  const own = env[OMP_HOME_ENV]?.trim();
  if (own) {
    const named = { sessionsDir: path.resolve(own, "sessions"), flat: false, named: true };
    return { plain: { ...named, passedOver: [] }, probe: null, xdg: null };
  }
  const passedOver: OmpPassedOver[] = [];
  const sessionDir = env[OMP_SESSIONS_ENV];
  if (sessionDir) {
    if (path.isAbsolute(sessionDir)) {
      const flat = { sessionsDir: path.resolve(sessionDir), flat: true, named: false, passedOver };
      return { plain: flat, probe: null, xdg: null };
    }
    // Oh My Pi resolves it against the folder it was started in (session-manager.ts:1081-1083).
    passedOver.push("session-dir");
  }
  const xdgHome = env[XDG_DATA_HOME_ENV];
  const xdgRoot =
    (platform === "darwin" || platform === "linux") && xdgHome && path.isAbsolute(xdgHome)
      ? path.resolve(xdgHome, APP_NAME)
      : null;
  // As Oh My Pi joins it, to compare with a setting as it does; each folder kept is resolved.
  const root = configRoot(env, homeDir);
  const folders = (sessionsDir: string): OmpFolders => ({
    sessionsDir: path.resolve(sessionsDir),
    flat: false,
    named: false,
    passedOver,
  });

  const profile = activeProfile(env);
  if (profile !== null) {
    // A named profile's own agent folder: `PI_CODING_AGENT_DIR` is not read.
    const plain = folders(path.join(root, "profiles", profile, "agent", "sessions"));
    if (xdgRoot === null) return { plain, probe: null, xdg: null };
    const probe = path.join(xdgRoot, "profiles", profile);
    return { plain, probe, xdg: folders(path.join(probe, "sessions")) };
  }

  const defaultAgent = path.join(root, "agent");
  const agentDir = env[OMP_AGENT_DIR_ENV];
  if (agentDir) {
    const piProfile = ompProfileOf(env[PI_PROFILE_ENV]);
    // One a parent's profile set is that profile's, and not followed (dirs.ts:470-486).
    const profiles =
      piProfile !== null && agentDir === path.join(root, "profiles", piProfile, "agent");
    // Kimchi writes its own folder into both as it starts, for the programs it starts.
    const kimchi = env[KIMCHI_AGENT_DIR_ENV];
    const setByKimchi =
      kimchi !== undefined &&
      path.isAbsolute(kimchi) &&
      path.isAbsolute(agentDir) &&
      path.resolve(kimchi) === path.resolve(agentDir);
    if (!profiles && !setByKimchi) {
      if (!path.isAbsolute(agentDir)) passedOver.push("agent-dir");
      else if (path.resolve(agentDir) !== path.resolve(defaultAgent)) {
        return {
          plain: folders(path.join(path.resolve(agentDir), "sessions")),
          probe: null,
          xdg: null,
        };
      }
    }
  }
  const plain = folders(path.join(defaultAgent, "sessions"));
  if (xdgRoot === null) return { plain, probe: null, xdg: null };
  return { plain, probe: xdgRoot, xdg: folders(path.join(xdgRoot, "sessions")) };
}

/**
 * The sessions folder, as Oh My Pi works it out, the first rule that applies
 * winning:
 *
 * 1. `AGENT_LOOKOUT_OMP_HOME`, trimmed, names the agent folder: `sessions` in it.
 * 2. `PI_CODING_AGENT_SESSION_DIR`, when it is a whole path: the files in it, flat.
 * 3. A named profile: `$XDG_DATA_HOME/omp/profiles/<name>/sessions` when that
 *    profile's folder is there, else `~/.omp/profiles/<name>/agent/sessions`.
 * 4. `PI_CODING_AGENT_DIR`, when it is a whole path, is not the agent folder
 *    of the profile `PI_PROFILE` names, is not the folder `KIMCHI_CODING_AGENT_DIR`
 *    names, as Kimchi sets both for the programs it starts, and is not
 *    `~/.omp/agent`: `sessions` in it.
 * 5. `$XDG_DATA_HOME/omp/sessions` when `$XDG_DATA_HOME/omp` is there, else
 *    `~/.omp/agent/sessions`.
 *
 * `exists` says whether the folder `ompXdgProbe` names is there. A relative
 * `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR` is passed over, and
 * said so.
 */
export function ompFoldersFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
  exists: (dir: string) => boolean,
): OmpFolders {
  const { plain, probe, xdg } = plan(env, homeDir, platform);
  return probe !== null && xdg !== null && exists(probe) ? xdg : plain;
}

/**
 * The sessions folders the rules can give, with no look at the disk: the one
 * for when the `XDG_DATA_HOME` folder is there, and the one for when it is
 * not, which are the same when it does not count. For the fingerprint of
 * what this copy of Agent Lookout reads.
 */
export function ompSessionsDirsFor(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ompFoldersFor(env, homeDir, platform, () => false).sessionsDir,
    ompFoldersFor(env, homeDir, platform, () => true).sessionsDir,
  ];
}
