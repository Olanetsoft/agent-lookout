import { NOT_RUN, runOsascript, type RunOsascript } from "../processes/osascript.ts";

// What drives a tab is `osascript`, run the one way the collector runs it.
export type { OsascriptResult, RunOsascript } from "../processes/osascript.ts";

/** The variable that, set to `off`, stops Agent Lookout looking for or driving terminal tabs. */
export const TERMINAL_JUMP_ENV = "AGENT_LOOKOUT_TERMINAL_JUMP";

/** Whether `AGENT_LOOKOUT_TERMINAL_JUMP` is `off` in this environment. */
export function terminalJumpOff(env: NodeJS.ProcessEnv): boolean {
  return env[TERMINAL_JUMP_ENV]?.trim().toLowerCase() === "off";
}

/**
 * What the collector brings a tab forward with: osascript on macOS, and
 * nothing anywhere else or while `AGENT_LOOKOUT_TERMINAL_JUMP` is `off`.
 */
export function createOsascriptRunner(options: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): RunOsascript {
  const platform = options.platform ?? process.platform;
  const off = terminalJumpOff(options.env) || platform !== "darwin";
  return async (args) => (off ? NOT_RUN : runOsascript(args));
}
