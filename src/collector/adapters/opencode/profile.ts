import path from "node:path";

import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";
import type { V1Extras, V1Tools } from "./sessionRows.ts";

/**
 * What tells one agent whose database is laid out as OpenCode's from another,
 * so the modules of this folder read them all: OpenCode, and Kilo Code and
 * MiMo Code, which are built from OpenCode's source and keep the same tables
 * in files of their own (`../kilo-code/index.ts`, `../mimo-code/index.ts`).
 * Everything else, the questions, the address the database is opened at, the
 * `sqlite3` arguments, the mapping and the timings, is shared, so a change to
 * these modules changes Kilo Code and MiMo Code too.
 */
export interface OpencodeProfile {
  /** The source its sessions are listed under: `opencode`, `kilo-code` or `mimo-code`. */
  sourceId: SourceId;
  /** Its name, as every sentence of its card says it. */
  label: string;
  /** Agent Lookout's own variable for its data folder, which wins over everything else. */
  homeEnv: string;
  /** The agent's own variable for its database: a path, one in its data folder, or `:memory:`. */
  dbEnv: string;
  /**
   * The agent's own variable for a folder of its that holds its data folder,
   * and that data folder's name in it, as MiMo Code's `MIMOCODE_HOME` holds
   * `data`. Taken only when it is an absolute path. Left out, there is none.
   */
  ownHome?: { env: string; folder: string };
  /** Its data folder's name, in `XDG_DATA_HOME` or `~/.local/share`. */
  folder: string;
  /** The file it keeps its sessions in, in that folder. */
  databaseFile: string;
  /** The names of its program, as `ps -A -o comm=` prints them, each compared exactly. */
  programs: ReadonlySet<string>;
  /** Whether OpenCode 2's `session_v2` is read. False, a database with one is a version that is not read. */
  readsV2: boolean;
  /** Its tools that ask the person, and those whose call leaves a session idle. */
  tools: V1Tools;
  /** What its 1.x layout has beyond OpenCode's, as MiMo Code's does. Left out, none. */
  v1Extras?: V1Extras;
  /** The error names, besides `MessageAbortedError`, that end a reply as failed. Left out, OpenCode's. */
  failedErrors?: readonly string[];
  /** What its sessions can show. */
  capabilities: SourceCapabilities;
  /** What its card says. None names another agent. */
  notes: {
    /** Said whenever it is watched: which waits show as needing you. */
    needsYou: string;
    /** Said whenever it is watched, until the adapter has been checked on a computer running it. */
    unchecked: string;
    /** Said when a session's newest message, or how its turn ended, is one this adapter does not know. */
    unknownMessage: string;
    /** Said on Windows, where nothing of it is read. */
    windows: string;
    /** Added when its data folder has no database yet, if anything is. */
    noDatabase?: string;
  };
  /**
   * What Sources says of the read of a session's last message while it is on,
   * or null when the adapter reads none: then it has no `lastMessage`, and its
   * card says nothing of one.
   */
  lastMessageRead: string | null;
}

/** Where such an agent keeps its data, under the home folder, when `XDG_DATA_HOME` names no other place. */
export const DEFAULT_DATA_HOME = [".local", "share"] as const;

/** The parts of a profile that say where its files are. */
export type ProfilePaths = Pick<
  OpencodeProfile,
  "homeEnv" | "dbEnv" | "ownHome" | "folder" | "databaseFile"
>;

/**
 * The agent's data folder: the one its `homeEnv` names, else the data folder
 * in the folder its `ownHome` names when that is an absolute path, else its
 * `folder` in `XDG_DATA_HOME` when that is an absolute path, else in
 * `~/.local/share`, on macOS as on Linux.
 */
export function dataFolderFor(
  profile: ProfilePaths,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const override = env[profile.homeEnv]?.trim() || undefined;
  if (override !== undefined) return path.resolve(override);
  if (profile.ownHome !== undefined) {
    // As the agent takes it: not trimmed, and refused unless it is absolute.
    const own = env[profile.ownHome.env];
    if (own && path.isAbsolute(own)) return path.resolve(own, profile.ownHome.folder);
  }
  const xdg = env.XDG_DATA_HOME;
  const data = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDir, ...DEFAULT_DATA_HOME);
  return path.resolve(data, profile.folder);
}

/**
 * The database the adapter reads, or null when the agent keeps its sessions
 * in memory. With its `homeEnv`, its `databaseFile` in that folder. Otherwise
 * its own `dbEnv`, as OpenCode, Kilo Code and MiMo Code all take it:
 * `:memory:`, an absolute path as it is, or a path in the data folder. Without
 * it, or with it empty, its `databaseFile` in the data folder.
 */
export function databaseFor(
  profile: ProfilePaths,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string | null {
  const home = dataFolderFor(profile, env, homeDir);
  if (env[profile.homeEnv]?.trim()) return path.join(home, profile.databaseFile);
  const own = env[profile.dbEnv];
  if (!own) return path.join(home, profile.databaseFile);
  if (own === ":memory:") return null;
  return path.isAbsolute(own) ? own : path.join(home, own);
}
