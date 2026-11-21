import path from "node:path";

import type { SourceCapabilities, SourceId } from "../../../core/sessions/session.ts";

/**
 * What tells one agent whose sessions are kept as Pi keeps them from another,
 * so the modules of this folder read them all: Pi, Kimchi, which runs Pi's
 * coding agent and keeps its session files in a folder of its own
 * (`../kimchi/index.ts`), and Prime Agent, whose session files are in Pi's
 * format, in one flat folder, and which says what a session does in files of
 * its own (`../prime-agent/index.ts`). Everything else, the bytes read,
 * the `ps` arguments, the mapping and the timings, is shared, so a change to
 * these modules changes Kimchi and Prime Agent too. What Prime Agent asks
 * for beyond Pi, `layout`, `legacySessionsEnv` and a status of its own, is
 * left out by Pi and Kimchi, which then read exactly as before.
 */
export interface PiProfile {
  /** The source its sessions are listed under: `pi`, `kimchi` or `prime-agent`. */
  sourceId: SourceId;
  /** Its name, as every sentence of its card says it. */
  label: string;
  /** Its program's name, as a sentence of its card says it: `pi`, `kimchi` or `prime-agent`. */
  program: string;
  /** The names of its program, as `ps -A -o comm=` prints them, each compared exactly. */
  programs: ReadonlySet<string>;
  /** Agent Lookout's own variable for its agent folder, which wins over everything else. */
  homeEnv: string;
  /** The agent's own variable for its sessions folder, which holds the files directly. */
  sessionsEnv: string;
  /**
   * An older name of that variable the agent still reads, after it, as Prime
   * Agent reads `PRIME_AGENT_CODING_AGENT_SESSION_DIR`. Left out by Pi and Kimchi.
   */
  legacySessionsEnv?: string;
  /**
   * The agent's own variable for its agent folder. Left out when the agent
   * sets that variable itself as it starts, so no setting of the person's can
   * move the folder, as Kimchi does.
   */
  agentDirEnv?: string;
  /**
   * Other agents' variables for their own agent folders, which those agents
   * also write into `agentDirEnv` as they start, as Kimchi does. When one of
   * them names the same folder, Agent Lookout was started from inside that
   * agent, and `agentDirEnv` is not followed.
   */
  agentDirSetBy?: readonly string[];
  /** Its agent folder, in the home folder, when nothing names another. */
  agentDir: readonly string[];
  /**
   * `flat` when every session file sits in the sessions folder itself, with no
   * folder for each project, as Prime Agent keeps them. Then no project folder
   * is looked for, and the sessions folder is listed again only when its
   * modified time moves, and at each sweep. Left out by Pi and Kimchi, whose
   * sessions folder is listed on every poll.
   */
  layout?: "flat";
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
export type ProfilePaths = Pick<
  PiProfile,
  "homeEnv" | "sessionsEnv" | "legacySessionsEnv" | "agentDirEnv" | "agentDirSetBy" | "agentDir"
>;

/** One of the agent's own settings as a folder: `~` is the home folder, and a relative one cannot be followed. */
/** Kimchi's own variable for its agent folder, which it writes into `PI_CODING_AGENT_DIR` too as it starts. */
export const KIMCHI_AGENT_DIR_ENV = "KIMCHI_CODING_AGENT_DIR";

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
 * and `main.ts` for the order): the folder its `sessionsEnv` names, else the
 * one its `legacySessionsEnv` names, when it has one, else `sessions` in the
 * folder its `agentDirEnv` names, else in its `agentDir` in the home folder,
 * on every system. Neither `--session-dir` nor the `sessionDir` setting is
 * followed: the settings file is never read, and a process's arguments are
 * not either.
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
  const legacy =
    profile.legacySessionsEnv === undefined
      ? undefined
      : ownFolder(env[profile.legacySessionsEnv], homeDir);
  if (legacy !== undefined) return path.resolve(legacy);
  const named = namedAgentDir(profile, env, homeDir);
  return path.resolve(named ?? path.join(homeDir, ...profile.agentDir), "sessions");
}

/**
 * The folder a profile's `agentDirEnv` names, unless one of its `agentDirSetBy`
 * names the same folder, as another agent sets for the programs it starts.
 */
function namedAgentDir(
  profile: ProfilePaths,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string | undefined {
  if (profile.agentDirEnv === undefined) return undefined;
  const named = ownFolder(env[profile.agentDirEnv], homeDir);
  if (named === undefined) return undefined;
  const setByAnother = (profile.agentDirSetBy ?? []).some((name) => {
    const other = ownFolder(env[name], homeDir);
    return other !== undefined && path.resolve(other) === path.resolve(named);
  });
  return setByAnother ? undefined : named;
}

/**
 * The agent folder itself, for an agent that keeps more than its sessions
 * there, as Prime Agent keeps its leases and its workers' journals: the folder
 * its `homeEnv` names, else the one its `agentDirEnv` names, else its
 * `agentDir` in the home folder. Its own variable for the sessions folder does
 * not move it.
 */
export function agentDirFor(
  profile: ProfilePaths,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  const own = env[profile.homeEnv]?.trim();
  if (own) return path.resolve(own);
  const named = namedAgentDir(profile, env, homeDir);
  return path.resolve(named ?? path.join(homeDir, ...profile.agentDir));
}
