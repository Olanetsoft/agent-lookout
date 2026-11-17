import path from "node:path";

import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";

/**
 * What tells one agent whose sessions are kept as Pi keeps them from another,
 * so the modules of this folder read them all: Pi, and Kimchi, which runs Pi's
 * coding agent and keeps its session files in a folder of its own
 * (`../kimchi/index.ts`). Everything else, the folders' layout, the bytes
 * read, the `ps` arguments, the mapping and the timings, is shared, so a
 * change to these modules changes Kimchi too.
 */
export interface PiProfile {
  /** The source its sessions are listed under: `pi` or `kimchi`. */
  sourceId: SourceId;
  /** Its name, as every sentence of its card says it. */
  label: string;
  /** Its program's name, as a sentence of its card says it: `pi` or `kimchi`. */
  program: string;
  /** The names of its program, as `ps -A -o comm=` prints them, each compared exactly. */
  programs: ReadonlySet<string>;
  /** Agent Lookout's own variable for its agent folder, which wins over everything else. */
  homeEnv: string;
  /** The agent's own variable for its sessions folder, which holds the files directly. */
  sessionsEnv: string;
  /**
   * The agent's own variable for its agent folder. Left out when the agent
   * sets that variable itself as it starts, so no setting of the person's can
   * move the folder, as Kimchi does.
   */
  agentDirEnv?: string;
  /** Its agent folder, in the home folder, when nothing names another. */
  agentDir: readonly string[];
  /**
   * Whether the name on a `session_info` line is read. False when the agent
   * writes one of its own from the person's words, so a session takes its
   * folder's name and no such line is turned into text.
   */
  readsNames: boolean;
  /**
   * The `customType` of a `custom` entry that, as a file's second line,
   * marks a session the agent made for itself, such as a subagent's. Such a
   * session is left out. Empty, none is.
   */
  hiddenMarkers: readonly string[];
  /** What its sessions can show. */
  capabilities: SourceCapabilities;
  /** What its card says. None names another agent. */
  notes: {
    /** Said whenever it is watched: what a status rests on. */
    status: string;
    /** Said whenever it is watched, until the adapter has been checked on a computer running it. */
    unchecked: string;
    /** Said when a file is of a newer format than this reads. */
    newerFormat: string;
  };
}

/** The parts of a profile that say where its files are. */
export type ProfilePaths = Pick<PiProfile, "homeEnv" | "sessionsEnv" | "agentDirEnv" | "agentDir">;

/** One of the agent's own settings as a folder: `~` is the home folder, and a relative one cannot be followed. */
function ownFolder(value: string | undefined, homeDir: string): string | undefined {
  const folder = value?.trim();
  if (!folder) return undefined;
  if (folder === "~") return homeDir;
  if (folder.startsWith("~/") || folder.startsWith("~\\")) {
    return path.join(homeDir, folder.slice(2));
  }
  return path.isAbsolute(folder) ? folder : undefined;
}

/**
 * The folder the adapter reads: `sessions` in the folder its `homeEnv` names,
 * for Agent Lookout alone. Otherwise it is worked out as Pi does (`config.ts`,
 * and `main.ts` for the order): the folder its `sessionsEnv` names, else
 * `sessions` in the folder its `agentDirEnv` names, else in its `agentDir` in
 * the home folder, on every system. Neither `--session-dir` nor the
 * `sessionDir` setting is followed: the settings file is never read, and a
 * process's arguments are not either.
 */
export function sessionsDirFor(
  profile: ProfilePaths,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const own = env[profile.homeEnv]?.trim();
  if (own) return path.resolve(own, "sessions");
  const sessions = ownFolder(env[profile.sessionsEnv], homeDir);
  if (sessions !== undefined) return path.resolve(sessions);
  const named =
    profile.agentDirEnv === undefined ? undefined : ownFolder(env[profile.agentDirEnv], homeDir);
  return path.resolve(named ?? path.join(homeDir, ...profile.agentDir), "sessions");
}
