import { ACTION_HEADER } from "@core/api";
import {
  APP_MENU_BAR_ACTION,
  APP_MENU_BAR_PATH,
  APP_MENU_BAR_SETTING_PATH,
  type MenuBarSettingRequest,
  type MenuBarStatus,
} from "@core/appMenuBar";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of the switch Show in menu bar. Only the Mac app answers
 * these addresses, so only a page in the app's window asks them: Settings
 * draws the Menu bar card there and nowhere else. Like every other request,
 * each goes through `apiRequest`, on the page's own origin.
 */

/** A read or a press is not left waiting on an app that has stopped answering. */
export const MENU_BAR_TIMEOUT_MS = 4_000;

/** Reads the app's answer, or null when it is not one. */
export function readMenuBarStatus(value: unknown): MenuBarStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { show } = value as { show?: unknown };
  return typeof show === "boolean" ? { show } : null;
}

/** Asks the app whether its item is in the menu bar. Null when it did not answer, or answered with something else. */
export async function fetchMenuBarStatus(): Promise<MenuBarStatus | null> {
  try {
    const response = await apiRequest(APP_MENU_BAR_PATH, {
      signal: AbortSignal.timeout(MENU_BAR_TIMEOUT_MS),
    });
    return response.ok ? readMenuBarStatus(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Turns the item in the menu bar on or off. Resolves with the app's answer, or null. */
export async function requestMenuBarShown(show: boolean): Promise<MenuBarStatus | null> {
  try {
    const response = await apiRequest(APP_MENU_BAR_SETTING_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: APP_MENU_BAR_ACTION },
      body: JSON.stringify({ show } satisfies MenuBarSettingRequest),
      signal: AbortSignal.timeout(MENU_BAR_TIMEOUT_MS),
    });
    return response.ok ? readMenuBarStatus(await response.json()) : null;
  } catch {
    return null;
  }
}
