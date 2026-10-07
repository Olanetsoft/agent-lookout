import os from "node:os";

import { CLAUDE_HOME_ENV } from "../adapters/claude-code/index.ts";
import { pathsOf } from "../files/paths.ts";

/**
 * The settings for answering permission prompts from the dashboard, read once
 * when the collector starts.
 *
 * - `AGENT_LOOKOUT_ANSWER=off` turns it off altogether: no socket is opened,
 *   no request is held and there is no answer route.
 * - `AGENT_LOOKOUT_ANSWER_SOCKET` names the socket the plugin's hook sends its
 *   requests to, `~/.agent-lookout/answer.sock` by default. The hook reads the
 *   same variable, so a test can point both at a folder of its own. With
 *   Agent Lookout makes its own folder, `~/.agent-lookout`, private when it
 *   is not; a folder it did not make, named by this variable, it never
 *   changes, and answering is off when others can open it. With
 *   `AGENT_LOOKOUT_CLAUDE_HOME` set, sessions are read from another folder
 *   than the one Claude Code's hooks run for, so nothing is answered unless
 *   this is set too.
 * - `AGENT_LOOKOUT_ANSWER_WAIT` is how long a request is held, in seconds,
 *   before the session's own prompt is left to decide: 300 by default, from 5
 *   to 540, which stays under the time the hook gives curl and the time
 *   Claude Code gives the hook.
 */

export const ANSWER_ENV = "AGENT_LOOKOUT_ANSWER";
export const ANSWER_SOCKET_ENV = "AGENT_LOOKOUT_ANSWER_SOCKET";
export const ANSWER_WAIT_ENV = "AGENT_LOOKOUT_ANSWER_WAIT";

/** How long a request is held when nothing says otherwise. */
export const DEFAULT_HOLD_MS = 300_000;

/** The shortest and longest hold that may be set. */
export const MIN_HOLD_MS = 5_000;
export const MAX_HOLD_MS = 540_000;

/**
 * The longest path a Unix socket can have, in bytes: macOS keeps 104 bytes
 * for it, ending in a zero. Node cuts a longer path short without a word and
 * would listen somewhere else, so a longer one is refused.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

export type AnswerSetup =
  | {
      on: true;
      socketPath: string;
      holdMs: number;
      problem: null;
      /** Whether the socket's folder is Agent Lookout's own, `~/.agent-lookout`. */
      ownFolder: boolean;
    }
  | {
      on: false;
      socketPath: null;
      holdMs: number;
      problem: string | null;
      /** True when the problem is not worth a line at start: it follows from another setting. */
      quiet?: true;
    };

/**
 * Why nothing is answered on Windows: the plugin's hook is a POSIX sh script,
 * and the socket it sends to is a Unix socket.
 */
export const WINDOWS_PROBLEM =
  "Permission prompts are not answered from Agent Lookout on Windows: the plugin's hook is a POSIX sh script, and it reaches Agent Lookout through a Unix socket.";

/** Whether `AGENT_LOOKOUT_ANSWER` is `off`. */
export function answerOff(env: NodeJS.ProcessEnv): boolean {
  return env[ANSWER_ENV]?.trim().toLowerCase() === "off";
}

/** The hold in milliseconds, from `AGENT_LOOKOUT_ANSWER_WAIT` in whole seconds, or the default. */
export function holdMsFrom(value: string | undefined): number | null {
  const text = value?.trim();
  if (text === undefined || text === "") return DEFAULT_HOLD_MS;
  if (!/^\d{1,4}$/.test(text)) return null;
  const ms = Number(text) * 1000;
  return ms < MIN_HOLD_MS || ms > MAX_HOLD_MS ? null : ms;
}

/** Where the socket goes, and how long a request is held, or why answering is off. */
export function readAnswerSetup(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): AnswerSetup {
  const holdMs = holdMsFrom(env[ANSWER_WAIT_ENV]);
  if (answerOff(env)) {
    return { on: false, socketPath: null, holdMs: holdMs ?? DEFAULT_HOLD_MS, problem: null };
  }
  // Said in the Sources view and the guide, so not again at every start.
  if (platform === "win32") {
    return {
      on: false,
      socketPath: null,
      holdMs: holdMs ?? DEFAULT_HOLD_MS,
      problem: WINDOWS_PROBLEM,
      quiet: true,
    };
  }
  if (holdMs === null) {
    return {
      on: false,
      socketPath: null,
      holdMs: DEFAULT_HOLD_MS,
      problem: `${ANSWER_WAIT_ENV} must be a number of seconds from ${MIN_HOLD_MS / 1000} to ${MAX_HOLD_MS / 1000}, so answering is off.`,
    };
  }
  const named = env[ANSWER_SOCKET_ENV]?.trim();
  if (!named && env[CLAUDE_HOME_ENV]?.trim()) {
    return {
      on: false,
      socketPath: null,
      holdMs,
      problem: `${CLAUDE_HOME_ENV} is set, so permission prompts are not answered. Set ${ANSWER_SOCKET_ENV} as well to answer them.`,
      quiet: true,
    };
  }
  // A Unix socket's path, by the rules of the system's paths.
  const paths = pathsOf(platform);
  const ownDir = paths.resolve(homeDir, ".agent-lookout");
  const socketPath = paths.resolve(named || paths.join(ownDir, "answer.sock"));
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    return {
      on: false,
      socketPath: null,
      holdMs,
      problem: `The path of the answer socket is longer than ${MAX_SOCKET_PATH_BYTES} bytes, which a socket cannot have, so answering is off. Set ${ANSWER_SOCKET_ENV} to a shorter path.`,
    };
  }
  return {
    on: true,
    socketPath,
    holdMs,
    problem: null,
    ownFolder: paths.dirname(socketPath) === ownDir,
  };
}
