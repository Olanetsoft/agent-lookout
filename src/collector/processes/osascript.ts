import { execFile } from "node:child_process";

import { TERMINAL_JUMP_TIMEOUT_MS } from "../../core/api.ts";

import { childEnvironment } from "./childEnvironment.ts";

/**
 * The one way the collector runs `osascript`: to show a notification itself,
 * and to bring a Terminal or iTerm2 tab forward.
 */

/** Where macOS keeps `osascript`. It is never looked for on `PATH`. */
export const OSASCRIPT = "/usr/bin/osascript";

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

/** The answer when nothing was started: not macOS, turned off, or it could not be started. */
export const NOT_RUN: OsascriptResult = { ok: false, stderr: "", timedOut: false };

/**
 * Starts `/usr/bin/osascript` directly, with no shell between, stdin closed and
 * a timeout, by default the one a jump has. The arguments reach it as they are
 * given, one by one.
 */
export function runOsascript(
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OsascriptResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        OSASCRIPT,
        [...args],
        {
          env: childEnvironment(process.env),
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
