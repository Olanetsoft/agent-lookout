import {
  ACTION_HEADER,
  PERMISSION_RULES_ACTION,
  PERMISSION_RULES_PATH,
  type PermissionRulesFailure,
} from "@core/api";
import {
  readPermissionRules,
  type PermissionRule,
  type RuleWords,
} from "@core/permission-rules/permissionRules";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of a change to the permission rules: one change at a time,
 * which the app makes, saves and then answers with the rules in force. Like
 * every other request, it goes through `apiRequest`. The page reads the rules
 * themselves with the other settings, through `fetchSettings`.
 */

/** A change is not left waiting on an app that has stopped answering. */
export const PERMISSION_RULES_TIMEOUT_MS = 5_000;

/** The longest sentence of the app's that is shown. Its own are far shorter. */
const MAX_ERROR_LENGTH = 400;

/** One change, as the page asks for it. */
export type RulesChangeAsked =
  | { add: RuleWords }
  | { edit: RuleWords & { id: string } }
  | { move: { id: string; to: "up" | "down" } }
  | { remove: { id: string } };

/** What a change came to: the rules now in force, or the app's reason, or none when it did not answer. */
export type RulesChangeOutcome =
  | { ok: true; rules: PermissionRule[] }
  | { ok: false; error: string | null; reason: PermissionRulesFailure | null };

const REASONS: readonly PermissionRulesFailure[] = [
  "invalid",
  "no-rule",
  "full",
  "duplicate",
  "not-saved",
];

/** Asks the app to make one change to the permission rules. It never rejects. */
export async function requestRulesChange(change: RulesChangeAsked): Promise<RulesChangeOutcome> {
  try {
    const response = await apiRequest(PERMISSION_RULES_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: PERMISSION_RULES_ACTION },
      body: JSON.stringify(change),
      signal: AbortSignal.timeout(PERMISSION_RULES_TIMEOUT_MS),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (response.ok && answer.ok === true) {
      const read = readPermissionRules(answer.permissionRules);
      if (read.ok) return { ok: true, rules: read.rules };
      return { ok: false, error: null, reason: null };
    }
    const error =
      typeof answer.error === "string" && answer.error.length <= MAX_ERROR_LENGTH
        ? answer.error
        : null;
    const reason = REASONS.find((known) => known === answer.reason) ?? null;
    return { ok: false, error, reason };
  } catch {
    return { ok: false, error: null, reason: null };
  }
}
