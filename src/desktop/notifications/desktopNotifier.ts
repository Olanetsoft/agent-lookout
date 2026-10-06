// The notifications the collector shows itself while no window of the app is
// open, shown by macOS as coming from Agent Lookout. The standalone server
// shows them by running `osascript`, which macOS files under Script Editor;
// the app shows them with its own.

import { Notification } from "electron";

import type { SystemNotifier } from "../../collector/notifications/systemNotifier.ts";
import { MAX_NOTICE_TEXT_LENGTH, oneLine } from "../../core/text.ts";

/** How many notifications are held on to, so a click on one can still be heard. */
const KEPT = 20;

export interface DesktopNotifierOptions {
  /** Called when the person clicks a notification: the app brings its window forward. */
  onClick: () => void;
  /**
   * Told, once, when macOS would not show a notification, with its reason. It
   * goes where the collector's own warnings go.
   */
  warn?: (line: string) => void;
}

/**
 * The app's own notifications. Like the system notifier it stands in for, it
 * never throws, and a notification that cannot be shown is dropped, with one
 * line the first time to say why. The title and the text are made to stand on
 * one line, as everywhere else a session's name is shown.
 */
export function createDesktopNotifier(options: DesktopNotifierOptions): SystemNotifier {
  // A notification nothing refers to may be collected, and its click lost.
  const kept: Notification[] = [];
  let warned = false;

  return {
    show(notice) {
      try {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
          title: oneLine(notice.title),
          body: oneLine(notice.body, MAX_NOTICE_TEXT_LENGTH),
        });
        notification.on("click", () => options.onClick());
        notification.on("failed", (_event, error) => {
          if (warned) return;
          warned = true;
          options.warn?.(`macOS did not show a notification from Agent Lookout: ${error}`);
        });
        kept.push(notification);
        if (kept.length > KEPT) kept.shift();
        notification.show();
      } catch {
        // Not shown. There is nobody to tell.
      }
    },
  };
}
