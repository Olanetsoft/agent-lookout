import {
  ACTION_HEADER,
  TERMINAL_JUMP_TIMEOUT_MS,
  type JumpFailure,
  type JumpRequest,
} from "@core/api";
import type { TerminalApp } from "@core/sessions/session";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/** What a press of Jump came to: the place was selected, or why it was not. */
export type JumpOutcome = "selected" | JumpFailure;

/** A press is not left waiting on a server that has stopped answering. */
export const JUMP_TIMEOUT_MS = 4_000;

/**
 * How long a press of a terminal tab's Jump waits. The collector waits for the
 * app, and the first time for the person to answer macOS, so the page waits a
 * little longer than the collector does.
 */
export const TERMINAL_JUMP_WAIT_MS = TERMINAL_JUMP_TIMEOUT_MS + 5_000;

const FAILURES: readonly JumpFailure[] = [
  "no-pane",
  "pane-gone",
  "tmux-stopped",
  "tab-gone",
  "not-allowed",
  "too-soon",
  "failed",
];

/** What the dashboard says of each outcome, in a few calm words beside the session's name. */
export const JUMP_OUTCOME_WORDS: Record<JumpOutcome, string> = {
  selected: "Selected in tmux",
  "no-pane": "No tmux pane found",
  "pane-gone": "That pane has closed",
  "tmux-stopped": "tmux has stopped",
  "tab-gone": "That tab has closed",
  "not-allowed": "macOS did not allow it",
  "too-soon": "Try again in a moment",
  failed: "Jump did not work",
};

/**
 * The words for an outcome. A press of a terminal tab's Jump says where it
 * went, "Switched to Terminal", and that it found no tab rather than no pane.
 */
export function jumpOutcomeWords(outcome: JumpOutcome, app: TerminalApp | null = null): string {
  if (app !== null && outcome === "selected") return `Switched to ${app}`;
  if (app !== null && outcome === "no-pane") return "No tab found";
  return JUMP_OUTCOME_WORDS[outcome];
}

/**
 * The line said the first time a terminal tab's Jump is pressed on this
 * browser, while macOS asks the person whether the collector may drive the app.
 * macOS's question names the program Agent Lookout was started from, not
 * Agent Lookout, so the line does too.
 */
export function automationAskLine(app: TerminalApp): string {
  return `macOS will ask once whether the app you started Agent Lookout from may control ${app}. Allow it to let Jump switch tabs.`;
}

/** The line said when macOS did not allow it, with where to change that. */
export const AUTOMATION_REFUSED_LINE =
  "To let Jump switch tabs, allow it in System Settings, Privacy & Security, Automation.";

/**
 * Asks the collector to take the person to a session: to select the tmux pane
 * it runs in, or to bring forward its tab of Terminal or iTerm2.
 *
 * The request names the session and nothing else: the collector decides what
 * that comes to from what it found itself. It never rejects. No answer, an
 * answer that is not data and an answer this page does not know all come out
 * as "failed".
 */
export async function requestJump(
  sessionId: string,
  timeoutMs: number = JUMP_TIMEOUT_MS,
): Promise<JumpOutcome> {
  try {
    const response = await apiRequest("/api/jump", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: "jump" },
      body: JSON.stringify({ sessionId } satisfies JumpRequest),
      signal: AbortSignal.timeout(timeoutMs),
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
