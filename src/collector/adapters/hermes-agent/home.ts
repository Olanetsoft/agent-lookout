import path from "node:path";

import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { DATABASE_FILE } from "./sessionRows.ts";

/**
 * Where Hermes Agent keeps its databases: its root folder, and in it the
 * default profile's `state.db` and each named profile's
 * `profiles/<name>/state.db` (`hermes_cli/profiles.py`,
 * `hermes_state_sessions.py`). Agent Lookout reads every profile, so it never
 * needs `active_profile`, the file that names the one Hermes Agent starts in.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** The variable that names Hermes Agent's root folder, for Agent Lookout alone. */
export const HERMES_HOME_ENV = "AGENT_LOOKOUT_HERMES_HOME";

/** Hermes Agent's own variable for its home: the root, or one profile's folder in it. */
export const HERMES_OWN_HOME_ENV = "HERMES_HOME";

/** Hermes Agent's root folder in the home folder, when nothing names another. */
export const DEFAULT_ROOT = ".hermes";

/** The folder in the root that holds the named profiles. */
export const PROFILES_FOLDER = "profiles";

/** The name Agent Lookout gives the profile kept in the root itself, which no named profile can have. */
export const DEFAULT_PROFILE = "default";

/**
 * A named profile, as Hermes Agent allows one (`hermes_state_sessions.py`). Its
 * tombstones, in `profiles/.deleted`, never match.
 */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The most named profiles read. Their names are taken in order. */
export const MAX_PROFILES = 16;

/** How long the list of named profiles stands before `profiles/` is listed again. */
export const PROFILES_LIST_MS = 60_000;

/** The value of a variable, or undefined when it is not set or only spaces. */
function setValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

/** A path with a leading `~` made the home folder, as Hermes Agent's own expansion does. */
function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

/**
 * Hermes Agent's root folder:
 *
 * - `AGENT_LOOKOUT_HERMES_HOME` when it is set, and then Hermes Agent's own
 *   variable is not read.
 * - Else `HERMES_HOME` by Hermes Agent's own rule (`hermes_constants.py`),
 *   taken only when it is an absolute path once a leading `~` is the home
 *   folder: a folder in `~/.hermes`, or `~/.hermes` itself, has `~/.hermes` as
 *   its root; `<x>/profiles/<name>` has `<x>`; any other folder is its own root.
 *   Links in it are not followed, where Hermes Agent follows them.
 * - Else `~/.hermes`.
 */
export function hermesRootFor(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = setValue(env, HERMES_HOME_ENV);
  if (override !== undefined) return path.resolve(override);
  const native = path.join(homeDir, DEFAULT_ROOT);
  const own = setValue(env, HERMES_OWN_HOME_ENV);
  if (own === undefined) return native;
  const expanded = expandHome(own, homeDir);
  if (!path.isAbsolute(expanded)) return native;
  const named = path.resolve(expanded);
  const inside = path.relative(path.resolve(native), named);
  const outside = inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside);
  if (!outside) return native;
  if (path.basename(path.dirname(named)) === PROFILES_FOLDER) {
    return path.dirname(path.dirname(named));
  }
  return named;
}

/** The database of a profile: `state.db` in the root for the default one, else in `profiles/<name>`. */
export function profileDatabase(root: string, profile: string): string {
  return profile === DEFAULT_PROFILE
    ? path.join(root, DATABASE_FILE)
    : path.join(root, PROFILES_FOLDER, profile, DATABASE_FILE);
}

/**
 * The named profiles in a root: each name in `profiles/` that Hermes Agent
 * allows and that is a folder itself, not a link, looked at with `lstat`.
 * Sorted, and at most `MAX_PROFILES`. None when `profiles/` is not there or
 * cannot be listed.
 */
export async function listProfiles(io: ReadOnlyIo, root: string): Promise<string[]> {
  const folder = path.join(root, PROFILES_FOLDER);
  let names: string[];
  try {
    names = await io.readdir(folder);
  } catch {
    return [];
  }
  const allowed = names
    .filter((name) => name !== DEFAULT_PROFILE && PROFILE_NAME.test(name))
    .sort();
  const profiles: string[] = [];
  for (const name of allowed) {
    if (profiles.length >= MAX_PROFILES) break;
    try {
      if ((await io.lstat(path.join(folder, name))).kind === "directory") profiles.push(name);
    } catch {
      // Gone since the listing, or not to be looked at: not read.
    }
  }
  return profiles;
}

export interface ProfileLister {
  /** The named profiles, listed again only once `PROFILES_LIST_MS` has passed. Never throws. */
  list(at: number): Promise<readonly string[]>;
  /** Makes the next `list` look again, as after the root went missing. */
  forget(): void;
}

/** Lists a root's named profiles at most once a minute. A clock set back counts as time enough. */
export function createProfileLister(options: {
  io: ReadOnlyIo;
  root: string;
  everyMs?: number;
}): ProfileLister {
  const { io, root } = options;
  const everyMs = options.everyMs ?? PROFILES_LIST_MS;
  let last: { names: readonly string[]; at: number } | null = null;
  return {
    async list(at) {
      if (last !== null && at - last.at >= 0 && at - last.at < everyMs) return last.names;
      let names: string[];
      try {
        names = await listProfiles(io, root);
      } catch {
        names = [];
      }
      last = { names, at };
      return names;
    },
    forget() {
      last = null;
    },
  };
}
