import { ACTION_HEADER } from "@core/api";
import {
  APP_NOTIFICATIONS_PATH,
  APP_NOTIFICATIONS_TEST_ACTION,
  APP_NOTIFICATIONS_TEST_PATH,
  type AppNotificationsStatus,
  type NotificationTestOutcome,
} from "@core/notices/appNotifications";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of the Mac app's own notifications: a test notification,
 * which says what macOS made of it, and the reason macOS gave the last time it
 * would not show one. In the app the page's own `Notification` reads "granted"
 * whatever macOS decides, so only these say whether macOS shows them.
 *
 * Only the Mac app answers these addresses, so only a page in the app's window
 * asks them: the Notifications card and the Overview's one-time question do so
 * only there. Like every other request, each goes through `apiRequest`, on the
 * page's own origin.
 */

/**
 * A test is not left waiting on an app that has stopped answering. The app
 * waits a few seconds for macOS (`TEST_ANSWER_MS` in the app's notifier), so
 * this is longer.
 */
export const NOTIFICATION_TEST_TIMEOUT_MS = 10_000;

/** A read of the last refusal is not left waiting either. */
export const APP_NOTIFICATIONS_TIMEOUT_MS = 4_000;

/** Reads the app's answer to a test, or null when it is not one. */
export function readNotificationTestOutcome(value: unknown): NotificationTestOutcome | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { outcome, reason } = value as { outcome?: unknown; reason?: unknown };
  if (outcome === "shown" || outcome === "unsupported" || outcome === "no-answer") {
    return { outcome };
  }
  if (outcome === "refused" && typeof reason === "string") return { outcome, reason };
  return null;
}

/** Reads what the app says of the last refusal, or null when it is not that. */
export function readAppNotificationsStatus(value: unknown): AppNotificationsStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { lastRefusal } = value as { lastRefusal?: unknown };
  return lastRefusal === null || typeof lastRefusal === "string" ? { lastRefusal } : null;
}

/**
 * Asks the app for one test notification. Resolves with what macOS made of
 * it, or null when the app did not answer, or answered with something else.
 */
export async function requestNotificationTest(): Promise<NotificationTestOutcome | null> {
  try {
    const response = await apiRequest(APP_NOTIFICATIONS_TEST_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ACTION_HEADER]: APP_NOTIFICATIONS_TEST_ACTION,
      },
      body: "{}",
      signal: AbortSignal.timeout(NOTIFICATION_TEST_TIMEOUT_MS),
    });
    return response.ok ? readNotificationTestOutcome(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Asks the app for the reason macOS gave the last time it refused one. Null when it did not answer. */
export async function fetchAppNotificationsStatus(): Promise<AppNotificationsStatus | null> {
  try {
    const response = await apiRequest(APP_NOTIFICATIONS_PATH, {
      signal: AbortSignal.timeout(APP_NOTIFICATIONS_TIMEOUT_MS),
    });
    return response.ok ? readAppNotificationsStatus(await response.json()) : null;
  } catch {
    return null;
  }
}
