import { ACTION_HEADER, ANSWER_ACTION, type AnswerFailure, type AnswerRequest } from "@core/api";
import type { PressOutcome } from "@core/answers/askWords";
import type { AnswerDecision } from "@core/sessions/session";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * What a press of Allow or Deny came to: answered, or why not, or no answer
 * at all. The words for each are in `@core/answers/askWords`, which the Mac
 * app says them from too.
 */
export type AnswerOutcome = PressOutcome;

/** How long a press waits for the collector, which reads one small file before it answers. */
export const ANSWER_REQUEST_TIMEOUT_MS = 10_000;

const ANSWER_FAILURES: readonly AnswerFailure[] = [
  "no-ask",
  "not-allowable",
  "gone",
  "too-soon",
  "failed",
];

/**
 * Asks the collector to hand the person's answer to the request the page
 * shows. The request names the session, the request and the answer, and
 * nothing else. It never rejects: an answer this page does not know is a
 * failure, and none at all is `no-answer`, since the answer may have been
 * handed over all the same.
 */
export async function requestAnswer(
  sessionId: string,
  requestId: string,
  decision: AnswerDecision,
  timeoutMs: number = ANSWER_REQUEST_TIMEOUT_MS,
): Promise<AnswerOutcome> {
  try {
    const response = await apiRequest("/api/permission/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: ANSWER_ACTION },
      body: JSON.stringify({ sessionId, requestId, decision } satisfies AnswerRequest),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    if (response.status === 200) {
      if (answer.ok !== true) return "failed";
      return answer.decision === "deny"
        ? "denied"
        : answer.decision === "allow"
          ? "allowed"
          : "failed";
    }
    return ANSWER_FAILURES.find((failure) => failure === answer.reason) ?? "failed";
  } catch {
    return "no-answer";
  }
}
