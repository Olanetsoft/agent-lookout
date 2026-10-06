import type {
  NotificationContent,
  NotificationHost,
  ShownNotification,
} from "@dashboard/lib/notifications/notificationHost";

/**
 * The notification system the landing page's dashboard is given with
 * `setNotificationHost`. It says notifications are allowed, never asks the
 * browser, and shows nothing itself: each notification the dashboard would
 * show is handed to the page, which draws it beside the frame. The browser's
 * own Notifications API is never touched, so the landing page can never ask
 * a visitor for permission.
 */

export interface TourNotifications extends NotificationHost {
  /** What the page is told: each notification as it is shown, and when it goes. */
  onShown(listener: (content: NotificationContent) => void): void;
  onGone(listener: (tag: string) => void): void;
}

export function createTourNotifications(): TourNotifications {
  const shownListeners = new Set<(content: NotificationContent) => void>();
  const goneListeners = new Set<(tag: string) => void>();

  return {
    permission: () => "granted",
    requestPermission: () => Promise.resolve("granted"),
    show(content) {
      for (const listener of shownListeners) listener(content);
      const closed = new Set<() => void>();
      let open = true;
      const notification: ShownNotification = {
        close() {
          if (!open) return;
          open = false;
          for (const listener of goneListeners) listener(content.tag);
          for (const listener of closed) listener();
        },
        onClosed(listener) {
          closed.add(listener);
        },
      };
      return notification;
    },
    onShown(listener) {
      shownListeners.add(listener);
    },
    onGone(listener) {
      goneListeners.add(listener);
    },
  };
}
