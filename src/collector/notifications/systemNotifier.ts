import type { Notice } from "../../core/notices/waiting.ts";
import { MAX_NOTICE_TEXT_LENGTH, oneLine } from "../../core/text.ts";
import { OSASCRIPT, runOsascript, type RunOsascript } from "../processes/osascript.ts";

export { OSASCRIPT };

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
  show(notice: Notice): void;
}

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

/**
 * The arguments `osascript` is given for one notification: the fixed script,
 * a `--`, then the title and the text.
 *
 * The `--` matters. Without it `osascript` reads an argument that begins with a
 * dash as one of its own options, and a session named `-e` would have the
 * argument after it run as a script.
 *
 * The title and the text are made to stand on one line, as every name Agent
 * Lookout shows or sends is: a line break, any other control character, a NUL,
 * which no argument can hold, and the marks that reorder text become spaces,
 * and a long name is cut. The text has room for the reason and what a waiting
 * session is asking after it.
 */
export function osascriptArgs(notice: Notice): string[] {
  return [
    ...SCRIPT.flatMap((line) => ["-e", line]),
    "--",
    oneLine(notice.title),
    oneLine(notice.body, MAX_NOTICE_TEXT_LENGTH),
  ];
}

/**
 * Whether the system's own notifications can be shown on this system: on
 * macOS alone. Showing them on Linux, with `notify-send` or the like, is left
 * out for now.
 */
export function systemNotificationsShownOn(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}

/** Runs `osascript` the one way the collector runs it, with a notification's own timeout. */
const runForNotification: RunOsascript = (args) =>
  runOsascript(args, { timeoutMs: OSASCRIPT_TIMEOUT_MS });

export interface SystemNotifierOptions {
  /** Defaults to this machine's. */
  platform?: NodeJS.Platform;
  /** Defaults to running `/usr/bin/osascript` for real. */
  run?: RunOsascript;
}

/**
 * The system's own notifications: `osascript` on macOS, and nothing anywhere
 * else. When `osascript` is missing, fails or runs out of time, nothing is
 * shown and nothing is reported, so a failure can never reach the poll that
 * asked.
 */
export function createSystemNotifier(options: SystemNotifierOptions = {}): SystemNotifier {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runForNotification;

  return {
    show(notice) {
      if (!systemNotificationsShownOn(platform)) return;
      try {
        run(osascriptArgs(notice)).catch(() => {
          // Not shown. There is nobody to tell.
        });
      } catch {
        // The program could not be started at all.
      }
    },
  };
}
