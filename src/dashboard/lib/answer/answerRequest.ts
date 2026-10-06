import { ACTION_HEADER, ANSWER_ACTION, type AnswerFailure, type AnswerRequest } from "@core/api";
import type { AnswerDecision, DenyOnlyReason, PermissionAsk } from "@core/sessions/session";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/** What a press of Allow or Deny came to: answered, or why not, or no answer at all. */
export type AnswerOutcome = "allowed" | "denied" | AnswerFailure | "no-answer";

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

/** What is said once Allow or Deny has been answered. */
export function answerOutcomeWords(outcome: AnswerOutcome): string {
  switch (outcome) {
    case "allowed":
      return "Allowed from Agent Lookout.";
    case "denied":
      return "Denied from Agent Lookout. Claude carries on without it.";
    case "gone":
      return "It was answered in the session, or is no longer waiting, so nothing was sent.";
    case "no-ask":
      return "That request is no longer held, so nothing was sent.";
    case "not-allowable":
      return "Only Deny is offered for this request.";
    case "too-soon":
      return "That request is being answered.";
    case "failed":
      return "The answer could not be handed to the session.";
    case "no-answer":
      return "Agent Lookout did not answer in time. The session shows whether it went on.";
  }
}

/** Why only Deny is offered, in a line under what the request asks. */
export function denyOnlyWords(reason: DenyOnlyReason): string {
  switch (reason) {
    case "edit":
      return "Allow is not offered for a change to a file here, since the change itself is not shown. Answer in the session to allow it.";
    case "too-long":
      return "It is too long to show whole here, so only Deny is offered. Answer in the session to allow it.";
    case "hidden-characters":
      return "It holds characters that cannot be shown as they are, written here as their codes, so only Deny is offered.";
    case "not-yes-or-no":
      return "It is answered with more than yes or no, so only Deny is offered here.";
    case "right-to-left":
      return "It holds right-to-left letters, which can draw a command in another order than it runs, so only Deny is offered. Answer in the session to allow it.";
    case "blank-lines":
      return "It has blank lines in a row that could hide what follows them, so only Deny is offered. Answer in the session to allow it.";
  }
}

/**
 * What the request asks, as the line over it: "Asks to run", "A subagent asks
 * to use Write", and under what the last answer came to, "It now asks to run".
 */
export function askHeading(
  ask: Pick<PermissionAsk, "tool" | "command" | "subagent">,
  again = false,
): string {
  const who = ask.subagent
    ? again
      ? "A subagent now asks"
      : "A subagent asks"
    : again
      ? "It now asks"
      : "Asks";
  return ask.command !== undefined ? `${who} to run` : `${who} to use ${ask.tool}`;
}
