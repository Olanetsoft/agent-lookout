import { ACTION_HEADER, type JumpFailure, type JumpRequest } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/** What a press of Jump came to: the place was selected, or why it was not. */
export type JumpOutcome = "selected" | JumpFailure;

/** A press is not left waiting on a server that has stopped answering. */
export const JUMP_TIMEOUT_MS = 4_000;

const FAILURES: readonly JumpFailure[] = [
  "no-pane",
  "pane-gone",
  "tmux-stopped",
  "too-soon",
  "failed",
];

/** What the dashboard says of each outcome, in a few calm words beside the session's name. */
export const JUMP_OUTCOME_WORDS: Record<JumpOutcome, string> = {
  selected: "Selected in tmux",
  "no-pane": "No tmux pane found",
  "pane-gone": "That pane has closed",
  "tmux-stopped": "tmux has stopped",
  "too-soon": "Try again in a moment",
  failed: "Jump did not work",
};

/**
 * Asks the collector to take the person to a session, which today means
 * selecting the tmux pane it runs in.
 *
 * The request names the session and nothing else: the collector decides what
 * that comes to from what it found itself. It never rejects. No answer, an
 * answer that is not data and an answer this page does not know all come out
 * as "failed".
 */
export async function requestJump(sessionId: string): Promise<JumpOutcome> {
  try {
    const response = await apiRequest("/api/jump", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: "jump" },
      body: JSON.stringify({ sessionId } satisfies JumpRequest),
      signal: AbortSignal.timeout(JUMP_TIMEOUT_MS),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (response.ok) return answer.ok === true ? "selected" : "failed";
    return FAILURES.find((failure) => failure === answer.reason) ?? "failed";
  } catch {
    return "failed";
  }
}
