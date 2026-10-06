import {
  ACTION_HEADER,
  SETTINGS_PATH,
  TIME_RULES_ACTION,
  TIME_RULES_PATH,
  type SettingsResponse,
} from "@core/api";
import { readTimeRules, type TimeRules } from "@core/time-rules/timeRules";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readSettings } from "@dashboard/lib/api/readApi";

/**
 * The page's side of the time rules: reading them, as the app keeps them in
 * its settings file, and changing them, which the app saves before it puts
 * them in force. Like every other request, each goes through `apiRequest`.
 */

/** A read or a change is not left waiting on an app that has stopped answering. */
export const TIME_RULES_TIMEOUT_MS = 5_000;

/** The longest sentence of the app's that is shown. Its own are far shorter. */
const MAX_ERROR_LENGTH = 400;

/** Reads the settings the app keeps. Null when it did not answer with them. */
export async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const response = await apiRequest(SETTINGS_PATH, {
      signal: AbortSignal.timeout(TIME_RULES_TIMEOUT_MS),
    });
    return response.ok ? readSettings(await response.json()) : null;
  } catch {
    return null;
  }
}

/** What a change came to: the rules now in force, or the app's reason, or none when it did not answer. */
export type TimeRulesOutcome = { ok: true; rules: TimeRules } | { ok: false; error: string | null };

/** Asks the app to put these rules in force. It never rejects. */
export async function requestTimeRules(rules: TimeRules): Promise<TimeRulesOutcome> {
  try {
    const response = await apiRequest(TIME_RULES_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: TIME_RULES_ACTION },
      body: JSON.stringify(rules),
      signal: AbortSignal.timeout(TIME_RULES_TIMEOUT_MS),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (response.ok && answer.ok === true && answer.timeRules !== undefined) {
      return { ok: true, rules: readTimeRules(answer.timeRules).rules };
    }
    const error =
      typeof answer.error === "string" && answer.error.length <= MAX_ERROR_LENGTH
        ? answer.error
        : null;
    return { ok: false, error };
  } catch {
    return { ok: false, error: null };
  }
}
