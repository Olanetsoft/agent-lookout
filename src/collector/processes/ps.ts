import { execFile } from "node:child_process";

/**
 * The one way the collector runs `ps`, for the three things it asks: when a
 * session's process started, every process's parent for tmux, and every
 * process's parent, terminal and program for Terminal and iTerm2.
 */

/** How long `ps` gets. It normally answers in a few milliseconds. */
const PS_TIMEOUT_MS = 2_000;

/** Far more than a table of every process needs, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface PsAnswer {
  /** False when `ps` failed, could not be started or was not run. */
  ok: boolean;
  /** What it printed, which can be something even when it failed. */
  stdout: string;
}

const NOT_RUN: PsAnswer = { ok: false, stdout: "" };

/**
 * Runs `ps` once with these arguments. It is run directly, never through a
 * shell, found on a fixed `PATH`, in the C locale, and, with `utc`, in UTC, as
 * Claude Code itself runs it. It is never run on Windows. It never rejects: a
 * failure is an answer.
 */
export function runPs(args: readonly string[], options: { utc?: boolean } = {}): Promise<PsAnswer> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      resolve(NOT_RUN);
      return;
    }
    try {
      execFile(
        "ps",
        [...args],
        {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C", ...(options.utc ? { TZ: "UTC" } : {}) },
          timeout: PS_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }),
      );
    } catch {
      resolve(NOT_RUN);
    }
  });
}
