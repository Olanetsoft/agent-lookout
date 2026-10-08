// What the Mac app's page and its main process say to each other about the
// app's own notifications: a test notification, which reports what macOS
// answered, and the reason macOS gave the last time it would not show one.
//
// In the app, the page's own `Notification` reads "granted" whatever macOS
// decides, because the app allows its page to ask. Only the main process hears
// macOS's answer, so the page asks it here.
//
// The app answers these under its own scheme, `agent-lookout://app/`, beside
// its routes for updates and the menu bar. The standalone server and the dev
// server never do: there, the GET is the collector's 404 and the POST its 405.

/** `GET`: the reason macOS gave the last time it would not show a notification, an `AppNotificationsStatus`. */
export const APP_NOTIFICATIONS_PATH = "/api/app/notifications";

/** `POST`, with the body `{}`: shows one test notification, and answers with what macOS said. */
export const APP_NOTIFICATIONS_TEST_PATH = "/api/app/notifications/test";

/**
 * What `ACTION_HEADER` says on the POST. A page at another origin cannot send
 * a header of this kind without asking first, and is never told yes.
 */
export const APP_NOTIFICATIONS_TEST_ACTION = "notification-test";

/** Whether an address belongs to the notifications' routes. */
export function isNotificationsPath(pathname: string): boolean {
  return pathname === APP_NOTIFICATIONS_PATH || pathname.startsWith(`${APP_NOTIFICATIONS_PATH}/`);
}

/**
 * What macOS made of a test notification:
 *
 * shown        macOS took it. It may still hide its banner, as while the
 *              display is shared or mirrored
 * refused      macOS would not show it, with the reason it gave
 * unsupported  this Mac gives the app no way to show one, or Electron could
 *              not make or show it
 * no-answer    macOS said nothing within a few seconds, as while it asks the
 *              person whether the app may show notifications
 */
export type NotificationTestOutcome =
  | { outcome: "shown" }
  | { outcome: "refused"; reason: string }
  | { outcome: "unsupported" }
  | { outcome: "no-answer" };

/** `GET /api/app/notifications`. */
export interface AppNotificationsStatus {
  /**
   * The reason macOS gave the last time it would not show a notification the
   * app's main process made, a test or any other, or null when it has not
   * refused one since one was last shown, or since the app started. The page's
   * own notifications are not heard.
   */
  lastRefusal: string | null;
}
