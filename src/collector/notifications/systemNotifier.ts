import { execFile } from "node:child_process";

import type { WaitNotice } from "../../core/sessions/waiting.ts";

/**
 * The one seam between the collector and the system's notifications.
 *
 * The collector shows a notification itself only when no dashboard page is
 * going to. On macOS it does so by running `osascript`, the system's own
 * program for AppleScript, so macOS shows the notification as coming from
 * Script Editor. Nothing is sent anywhere. On any other system nothing is
 * shown. A later desktop host passes its own notifier to `createCollector`,
 * and tests pass one that shows nothing.
 */
export interface SystemNotifier {
  /**
   * Shows a notification on this machine. It never throws, and a notification
   * that could not be shown is dropped without a word.
   */
  show(notice: WaitNotice): void;
}

/** Where macOS keeps `osascript`. It is never looked for on `PATH`. */
export const OSASCRIPT = "/usr/bin/osascript";

/** How long `osascript` gets. It normally answers in well under a second. */
const OSASCRIPT_TIMEOUT_MS = 5_000;

/**
 * The whole script, and it never changes. The title and the text reach it as
 * arguments, `argv`, so nothing a session is named can be read as AppleScript.
 */
const SCRIPT = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
];

/** An argument cannot hold a NUL, and a program given one is not started. */
function withoutNul(text: string): string {
  return text.replaceAll("\0", "");
}

/**
 * The arguments `osascript` is given for one notification: the fixed script,
 * a `--`, then the title and the text.
 *
 * The `--` matters. Without it `osascript` reads an argument that begins with a
 * dash as one of its own options, and a session named `-e` would have the
 * argument after it run as a script.
 */
export function osascriptArgs(notice: WaitNotice): string[] {
  return [
    ...SCRIPT.flatMap((line) => ["-e", line]),
    "--",
    withoutNul(notice.title),
    withoutNul(notice.body),
  ];
}

/** Runs a program with these arguments. Resolves when it ends and rejects when it failed. */
export type RunProgram = (file: string, args: readonly string[]) => Promise<void>;

/** Starts the program directly, with no shell between, stdin closed and a timeout. */
export const runDirectly: RunProgram = (file, args) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { timeout: OSASCRIPT_TIMEOUT_MS, windowsHide: true },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
    child.stdin?.end();
  });

export interface SystemNotifierOptions {
  /** Defaults to this machine's. */
  platform?: NodeJS.Platform;
  /** Defaults to starting the program for real. */
  run?: RunProgram;
}

/**
 * The system's own notifications: `osascript` on macOS, and nothing anywhere
 * else. When `osascript` is missing, fails or runs out of time, nothing is
 * shown and nothing is reported, so a failure can never reach the poll that
 * asked.
 */
export function createSystemNotifier(options: SystemNotifierOptions = {}): SystemNotifier {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runDirectly;

  return {
    show(notice) {
      if (platform !== "darwin") return;
      try {
        run(OSASCRIPT, osascriptArgs(notice)).catch(() => {
          // Not shown. There is nobody to tell.
        });
      } catch {
        // The program could not be started at all.
      }
    },
  };
}
