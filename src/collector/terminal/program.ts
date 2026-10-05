import { execFile } from "node:child_process";

import { TERMINAL_JUMP_TIMEOUT_MS } from "../../core/api.ts";
import { OSASCRIPT } from "../notifications/systemNotifier.ts";

/** The variable that, set to `off`, stops Agent Lookout looking for or driving terminal tabs. */
export const TERMINAL_JUMP_ENV = "AGENT_LOOKOUT_TERMINAL_JUMP";

/** Whether `AGENT_LOOKOUT_TERMINAL_JUMP` is `off` in this environment. */
export function terminalJumpOff(env: NodeJS.ProcessEnv): boolean {
  return env[TERMINAL_JUMP_ENV]?.trim().toLowerCase() === "off";
}

/** Far more than a script's answer needs, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export type OsascriptResult =
  | { ok: true; stdout: string }
  | {
      ok: false;
      /** What osascript printed about the failure, or nothing when it said nothing or never ran. */
      stderr: string;
      /** True when it was stopped for taking longer than its time. */
      timedOut: boolean;
    };

/** Runs `/usr/bin/osascript` with these arguments. It never rejects: a failure is an answer. */
export type RunOsascript = (args: readonly string[]) => Promise<OsascriptResult>;

/** The answer when nothing was started: not macOS, or turned off. */
const NOT_RUN: OsascriptResult = { ok: false, stderr: "", timedOut: false };

/**
 * Starts `/usr/bin/osascript` directly, with no shell between, stdin closed and
 * a timeout. The arguments reach it as they are given, one by one.
 */
export function runOsascriptBinary(
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OsascriptResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        OSASCRIPT,
        [...args],
        {
          timeout: options.timeoutMs ?? TERMINAL_JUMP_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, stdout: String(stdout ?? "") });
            return;
          }
          const timedOut = (error as { killed?: boolean }).killed === true;
          resolve({ ok: false, stderr: String(stderr ?? "").trim(), timedOut });
        },
      );
      child.stdin?.end();
    } catch {
      resolve(NOT_RUN);
    }
  });
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
  return async (args) => (off ? NOT_RUN : runOsascriptBinary(args));
}
