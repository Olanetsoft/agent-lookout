/**
 * The one seam between the dashboard and the notification system.
 *
 * In a browser a notification is made by this page, through the browser's own
 * Notifications API, and shown by the operating system. Nothing is sent to a
 * server and no service worker is registered, so a notification can only be
 * made while the page is open. A later desktop host installs its own, native
 * notifications with `setNotificationHost` before React renders, and nothing
 * else in the dashboard changes.
 */

/** Whether notifications may be shown. "unsupported" means the host has no way to show one. */
export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported";

export interface NotificationContent {
  title: string;
  body: string;
  /** One notification per tag: a second with the same tag takes the place of the first. */
  tag: string;
}

/** A notification that is on show. */
export interface ShownNotification {
  /** Takes it down. Calling it again does nothing. */
  close(): void;
  /** Hears it go, whether the person dismissed it or it was taken down. */
  onClosed(listener: () => void): void;
}

export interface NotificationHost {
  /** The permission as it stands now. It never asks the person anything. */
  permission(): NotificationPermissionState;
  /**
   * Asks the person whether notifications may be shown, and answers with the
   * permission afterwards. Browsers only ask from inside a click, so this is
   * called from one and nowhere else.
   */
  requestPermission(): Promise<NotificationPermissionState>;
  /** Shows a notification. Null when it could not be shown. It never throws. */
  show(content: NotificationContent): ShownNotification | null;
}

/** The browser's Notifications API, or null where there is none. */
function browserApi(): typeof Notification | null {
  if (typeof window === "undefined") return null;
  const api: typeof Notification | undefined = window.Notification;
  return api ?? null;
}

const browserHost: NotificationHost = {
  permission() {
    const api = browserApi();
    if (!api) return "unsupported";
    const { permission } = api;
    return permission === "granted" || permission === "denied" ? permission : "default";
  },

  requestPermission() {
    const api = browserApi();
    if (!api) return Promise.resolve<NotificationPermissionState>("unsupported");
    return new Promise((resolve) => {
      // Whatever the answer, the permission is read back from the browser.
      const answered = () => resolve(browserHost.permission());
      try {
        // Current browsers return a promise. Older ones take a callback and return nothing.
        const asked: Promise<unknown> | undefined = api.requestPermission(answered);
        asked?.then(answered, answered);
      } catch {
        answered();
      }
    });
  },

  show({ title, body, tag }) {
    const api = browserApi();
    if (!api) return null;
    try {
      // No icon: the browser and the system put their own beside it.
      const notification = new api(title, { body, tag });
      // A click brings the dashboard forward. It does not open the session's own app.
      notification.addEventListener("click", () => window.focus());
      return {
        close() {
          try {
            notification.close();
          } catch {
            // Already gone.
          }
        },
        onClosed(listener) {
          notification.addEventListener("close", listener);
        },
      };
    } catch {
      // Some browsers have the API and still refuse to make one from a page.
      return null;
    }
  },
};

let currentHost: NotificationHost = browserHost;

/** Replaces the notification system. Call with no argument to restore the browser's own. */
export function setNotificationHost(host: NotificationHost = browserHost): void {
  currentHost = host;
}

/** The notification system in use now. */
export function notificationHost(): NotificationHost {
  return currentHost;
}
