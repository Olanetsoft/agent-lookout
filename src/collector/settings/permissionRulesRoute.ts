import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  PERMISSION_RULES_ACTION,
  type PermissionRulesFailure,
  type PermissionRulesRefusal,
  type PermissionRulesResponse,
} from "../../core/api.ts";
import { applyRulesChange, rulesChangeIn } from "../../core/permission-rules/rulesChange.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import type { CollectorSettings } from "./collectorSettings.ts";

/** The most a request's body may hold. One rule is a few hundred bytes at most. */
export const MAX_PERMISSION_RULES_BODY_BYTES = 1_024;

const failed = (status: number, reason: PermissionRulesFailure, error: string): ApiAnswer => ({
  status,
  body: { error, reason } satisfies PermissionRulesRefusal,
});

/** What each refusal of a change is answered with. */
const STATUS_OF = { "no-rule": 404, full: 409, duplicate: 409 } as const;

/**
 * Why a request to the permission rules' route is refused before its body is
 * read, or null when it may proceed: `actionRefusalFor` in `handler.ts`, with
 * `permission-rules` as the action. This route changes what Agent Lookout
 * answers without asking, and writes a file, so it must be one only the
 * dashboard's own page can send.
 */
export function permissionRulesRefusalFor(
  req: Pick<IncomingMessage, "method" | "headers">,
): ApiAnswer | null {
  return actionRefusalFor(req, PERMISSION_RULES_ACTION, MAX_PERMISSION_RULES_BODY_BYTES);
}

/** Agent Lookout's own name for a new rule: twelve hexadecimal digits. */
const newRuleId = () => randomBytes(6).toString("hex");

/**
 * Answers `POST /api/settings/permission-rules`: makes one change to the
 * permission rules, adding, editing, moving or removing one rule, and saves
 * the list in the settings file, as the Permission rules card in Settings
 * does.
 *
 * The body is one change, exactly as `rulesChangeIn` in the core reads it,
 * and nothing else, and the rule it adds or edits must be one the rules take
 * (`ruleProblem`): the checks the page makes are only there to help. Nothing
 * in it names a file: the file is the one the collector was started with.
 * The rules are in force only once they are saved, so a change that cannot
 * be written changes nothing.
 */
export function createPermissionRulesRoute(options: {
  settings: Pick<CollectorSettings, "permissionRules" | "changePermissionRules">;
  /** Makes a new rule's id. Defaults to 48 random bits. */
  newId?: () => string;
}) {
  const { settings } = options;
  const newId = options.newId ?? newRuleId;

  return async function answerPermissionRules(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = permissionRulesRefusalFor(req);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_PERMISSION_RULES_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_PERMISSION_RULES_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }

    let value: unknown;
    try {
      value = JSON.parse(body.text);
    } catch {
      return failed(400, "invalid", "The body must be JSON: one change to the permission rules.");
    }
    const asked = rulesChangeIn(value);
    if (!asked.ok) return failed(400, "invalid", asked.problem);

    const made = applyRulesChange(settings.permissionRules(), asked.change, newId);
    if (!made.ok) return failed(STATUS_OF[made.reason], made.reason, made.problem);
    if (made.changed) {
      const saved = settings.changePermissionRules(made.rules);
      if (!saved.ok) return failed(500, "not-saved", saved.problem);
    }
    return {
      status: 200,
      body: { ok: true, permissionRules: made.rules } satisfies PermissionRulesResponse,
    };
  };
}
