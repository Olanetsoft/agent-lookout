import type { IncomingMessage } from "node:http";

import {
  TIME_RULES_ACTION,
  type TimeRulesFailure,
  type TimeRulesRefusal,
  type TimeRulesResponse,
} from "../../core/api.ts";
import { timeRulesIn } from "../../core/time-rules/timeRules.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import type { CollectorSettings } from "./collectorSettings.ts";

/** The most a request's body may hold. The three rules are a few hundred bytes. */
export const MAX_TIME_RULES_BODY_BYTES = 2_048;

const failed = (status: number, reason: TimeRulesFailure, error: string): ApiAnswer => ({
  status,
  body: { error, reason } satisfies TimeRulesRefusal,
});

/**
 * Why a request to the time rules' route is refused before its body is read,
 * or null when it may proceed: `actionRefusalFor` in `handler.ts`, with
 * `time-rules` as the action. This route changes what the collector holds back
 * and when, and writes a file, so it must be one only the dashboard's own page
 * can send.
 */
export function timeRulesRefusalFor(
  req: Pick<IncomingMessage, "method" | "headers">,
): ApiAnswer | null {
  return actionRefusalFor(req, TIME_RULES_ACTION, MAX_TIME_RULES_BODY_BYTES);
}

/**
 * Answers `POST /api/settings/time-rules`: puts the three time rules in force
 * and saves them in the settings file, as the Time rules card in Settings
 * does.
 *
 * The body is the three rules whole, exactly as `GET /api/settings` gives
 * them, and nothing else: `timeRulesIn` in the core reads it, and a body that
 * says more, or less, is refused whole. Nothing in it names a file: the file
 * is the one the collector was started with. The rules are in force only once
 * they are saved, so a change that cannot be written changes nothing.
 */
export function createTimeRulesRoute(options: {
  settings: Pick<CollectorSettings, "changeTimeRules">;
}) {
  const { settings } = options;

  return async function answerTimeRules(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = timeRulesRefusalFor(req);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_TIME_RULES_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_TIME_RULES_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }

    let value: unknown;
    try {
      value = JSON.parse(body.text);
    } catch {
      return failed(400, "invalid", "The body must be JSON: the three time rules.");
    }
    const asked = timeRulesIn(value);
    if (!asked.ok) return failed(400, "invalid", asked.problem);

    const saved = settings.changeTimeRules(asked.rules);
    if (!saved.ok) return failed(500, "not-saved", saved.problem);
    return {
      status: 200,
      body: { ok: true, timeRules: asked.rules } satisfies TimeRulesResponse,
    };
  };
}
