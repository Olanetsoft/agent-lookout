import type { IncomingMessage } from "node:http";

import {
  CLEAR_HISTORY_ACTION,
  type ClearHistoryFailure,
  type ClearHistoryRefusal,
  type ClearHistoryResponse,
} from "../../core/api.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "../handler.ts";
import type { HistoryKeeper } from "./historyKeeper.ts";

/** The most a request's body may hold. It holds `{}`. */
export const MAX_CLEAR_BODY_BYTES = 64;

export interface ClearRouteOptions {
  /** What keeps the history on disk, or null when it is kept in memory only. */
  keeper: Pick<HistoryKeeper, "clear"> | null;
  /** Empties the stores in memory, at the moment the files are gone. */
  forget: () => void;
}

/** Whether a body is an empty JSON object, `{}`, and nothing else. */
export function isEmptyObject(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

const failed = (status: number, reason: ClearHistoryFailure, error: string): ApiAnswer => ({
  status,
  body: { error, reason } satisfies ClearHistoryRefusal,
});

/**
 * Answers `POST /api/history/clear`: deletes the files the history is kept in
 * and empties the Events log and the history in memory, which then begin
 * again from that moment.
 *
 * It is the collector's second route that acts, so it makes the checks the
 * jump route makes, `actionRefusalFor` in `handler.ts`, with `clear-history`
 * as the action, and its body must be `{}`. Nothing in a request reaches a
 * command or names a file: the files are the ones in the history's own folder.
 */
export function createClearHistoryRoute(options: ClearRouteOptions) {
  const { keeper, forget } = options;

  return async function answerClear(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = actionRefusalFor(req, CLEAR_HISTORY_ACTION, MAX_CLEAR_BODY_BYTES);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_CLEAR_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_CLEAR_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    if (!isEmptyObject(body.text)) {
      return refusal(400, "The body must be an empty JSON object: {}.");
    }

    if (keeper === null) {
      return failed(
        409,
        "memory-only",
        "History is kept in memory only, with AGENT_LOOKOUT_HISTORY=off, so there are no files to clear.",
      );
    }
    const outcome = await keeper.clear(forget);
    if (outcome.ok) {
      return {
        status: 200,
        body: { ok: true, clearedAt: outcome.at } satisfies ClearHistoryResponse,
      };
    }
    return failed(outcome.reason === "not-writing" ? 409 : 500, outcome.reason, outcome.error);
  };
}
