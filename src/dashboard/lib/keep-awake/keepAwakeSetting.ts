import { ACTION_HEADER } from "@core/api";
import {
  APP_KEEP_AWAKE_ACTION,
  APP_KEEP_AWAKE_PATH,
  APP_KEEP_AWAKE_SETTING_PATH,
  type KeepAwakeSettingRequest,
  type KeepAwakeStatus,
} from "@core/keep-awake/appKeepAwake";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of the switch Keep the Mac awake. Only the Mac app answers
 * these addresses, so only a page in the app's window asks them: Settings
 * draws the Keep awake card there and nowhere else. Like every other request,
 * each goes through `apiRequest`, on the page's own origin.
 */

/** A read or a press is not left waiting on an app that has stopped answering. */
export const KEEP_AWAKE_TIMEOUT_MS = 4_000;

/** Reads the app's answer, or null when it is not one. */
export function readKeepAwakeStatus(value: unknown): KeepAwakeStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { on, holding, failed } = value as { on?: unknown; holding?: unknown; failed?: unknown };
  if (typeof on !== "boolean" || typeof holding !== "boolean" || typeof failed !== "boolean") {
    return null;
  }
  return { on, holding, failed };
}

/** Asks the app whether the switch is on and the Mac is kept awake now. Null when it did not answer, or answered with something else. */
export async function fetchKeepAwakeStatus(): Promise<KeepAwakeStatus | null> {
  try {
    const response = await apiRequest(APP_KEEP_AWAKE_PATH, {
      signal: AbortSignal.timeout(KEEP_AWAKE_TIMEOUT_MS),
    });
    return response.ok ? readKeepAwakeStatus(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Turns the switch on or off. Resolves with the app's answer, or null. */
export async function requestKeepAwake(on: boolean): Promise<KeepAwakeStatus | null> {
  try {
    const response = await apiRequest(APP_KEEP_AWAKE_SETTING_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: APP_KEEP_AWAKE_ACTION },
      body: JSON.stringify({ on } satisfies KeepAwakeSettingRequest),
      signal: AbortSignal.timeout(KEEP_AWAKE_TIMEOUT_MS),
    });
    return response.ok ? readKeepAwakeStatus(await response.json()) : null;
  } catch {
    return null;
  }
}
