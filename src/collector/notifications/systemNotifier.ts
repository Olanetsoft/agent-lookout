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
 * shown. The Mac app passes its own notifier to `createCollector`, and tests
 * pass one that shows nothing.
 */
export interface SystemNotifier {
  /**
   * Whether the dashboard pages the collector serves show notifications of
   * their own beside this notifier's. Left out, they do, as a page in a
   * browser does, and each notification is held back a moment for an open
   * page to show (`heldWait.ts`). The Mac app's notifier says false: the page
   * in its window shows none, so that notifier shows every one, at once, with
   * the window open or closed. The pages still say which events are on.
   */
  readonly pagesNotify?: boolean;
  /**
   * Shows a notification on this machine. It never throws, and a notification
   * that could not be shown is dropped without a word. `about` says what it is
   * about, for a host that can do more with that than show it. The Mac app
   * has a later one of a session take the place of the earlier, and a new
   * summary the place of the last, as the page's tags do, apart from what
   * `desktopNotifier.ts` says, opens a session's details on a click on its
   * wait's, and offers Deny and Allow for a permission request Agent Lookout
   * holds. `osascript` takes no notice of it.
   */
  show(notice: Notice, about?: NoticeAbout): void;
  /**
   * Told that a session's wait has ended, by the rule the page takes down its
   * own notification of a wait by (`sessionChanges` in the core). A host that
   * can take a notification down again, as the Mac app can, takes down the
   * one of that wait, or of a reminder of it. `osascript` cannot, so the
   * system's own notifier has none.
   */
  waitEnded?(sessionId: string): void;
  /**
   * Told that the notifications of waits were switched off, as notifications
   * or Needs you being turned off in Settings is. A host that can take a
   * notification down again takes down every one of a wait, as the page does
   * its own, and leaves one that says a session finished, failed or ended.
   */
  waitsOff?(): void;
}

/** What a notification is about, beyond its words. */
export type NoticeAbout =
  /** A session that waits, or a reminder of its wait. */
  | {
      kind: "wait";
      sessionId: string;
      /** For a reminder, how long the session has waited, in milliseconds. */
      waitedMs?: number;
    }
  /** A session that finished, failed or ended. */
  | { kind: "over"; sessionId: string }
  /** The one summary of quiet hours, "While quiet". */
  | { kind: "summary" };

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
