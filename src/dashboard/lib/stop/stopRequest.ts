import {
  ACTION_HEADER,
  CLEAN_UP_ACTION,
  CLEAN_UP_OUTCOMES,
  STOP_ACTION,
  STOP_WAIT_MS,
  type CleanUpEntry,
  type CleanUpOutcome,
  type CleanUpRequest,
  type StopFailure,
  type StopRequest,
} from "@core/api";
import type { StopWay } from "@core/sessions/session";
import { STALE_THRESHOLD_MS, staleAfterInWords } from "@core/sessions/staleness";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/** What a press of Stop session came to: stopped, or why not, or no answer at all. */
export type StopOutcome = "stopped" | StopFailure | "no-answer";

/**
 * How long a press of Stop session waits for the answer. The collector waits
 * up to 10 seconds for the process to end, or runs `claude stop`, and then
 * reads the sessions again, so the page waits well past that.
 */
export const STOP_REQUEST_TIMEOUT_MS = STOP_WAIT_MS + 20_000;

const STOP_FAILURES: readonly StopFailure[] = [
  "gone",
  "unsupported",
  "cannot-confirm",
  "not-allowed",
  "still-running",
  "too-soon",
  "failed",
];

/** The body of an answer, whatever it held, or an empty one. */
async function answerOf(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/**
 * Asks the collector to stop a session, once the person has confirmed it. The
 * request names the session and nothing else: the collector decides what that
 * comes to from what it found itself, and checks it all again first. It never
 * rejects. An answer this page does not know is a failure, and none at all is
 * `no-answer`, since the session may have stopped all the same.
 */
export async function requestStop(
  sessionId: string,
  timeoutMs: number = STOP_REQUEST_TIMEOUT_MS,
): Promise<StopOutcome> {
  try {
    const response = await apiRequest("/api/sessions/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: STOP_ACTION },
      body: JSON.stringify({ sessionId } satisfies StopRequest),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await answerOf(response);
    if (response.status === 200) return answer.ok === true ? "stopped" : "failed";
    return STOP_FAILURES.find((failure) => failure === answer.reason) ?? "failed";
  } catch {
    return "no-answer";
  }
}

/** What a press of End came to: what became of each session, or why none was tried. */
export type CleanUpAnswer =
  | { ok: true; results: Map<string, CleanUpOutcome> }
  | { ok: false; reason: "too-soon" | "failed" | "no-answer" };

/** How long a clean-up waits: the 10 seconds every process gets, and 11 more for each background job. */
export function cleanUpTimeoutMs(backgroundJobs: number): number {
  return STOP_WAIT_MS + 20_000 + backgroundJobs * 11_000;
}

/**
 * Asks the collector to end the sessions left running that the person chose,
 * each with the moment its idle began as the page showed it, so one that has
 * done anything since is left running. It never rejects.
 */
export async function requestCleanUp(
  entries: readonly CleanUpEntry[],
  timeoutMs: number = cleanUpTimeoutMs(0),
): Promise<CleanUpAnswer> {
  try {
    const response = await apiRequest("/api/sessions/clean-up", {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: CLEAN_UP_ACTION },
      body: JSON.stringify({ sessions: [...entries] } satisfies CleanUpRequest),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = await answerOf(response);
    if (response.status === 429) return { ok: false, reason: "too-soon" };
    if (response.status !== 200 || !Array.isArray(answer.results)) {
      return { ok: false, reason: "failed" };
    }
    const results = new Map<string, CleanUpOutcome>();
    for (const item of answer.results as unknown[]) {
      if (typeof item !== "object" || item === null) continue;
      const { sessionId, outcome } = item as Record<string, unknown>;
      if (typeof sessionId !== "string") continue;
      results.set(sessionId, CLEAN_UP_OUTCOMES.find((known) => known === outcome) ?? "failed");
    }
    return { ok: true, results };
  } catch {
    return { ok: false, reason: "no-answer" };
  }
}

/** What the details say once Stop session has been answered. */
export function stopOutcomeWords(outcome: StopOutcome, how: StopWay): string {
  switch (outcome) {
    case "stopped":
      return how === "background"
        ? "Stopped. Claude Code stopped the background job, and its conversation is kept."
        : "Stopped. Its process has ended, and its conversation is kept.";
    case "gone":
      return "That session has already ended.";
    case "unsupported":
      return "Agent Lookout does not stop this session.";
    case "cannot-confirm":
      return "Agent Lookout cannot confirm this process is that session, so it did not stop it.";
    case "not-allowed":
      return "Agent Lookout is not allowed to stop this process.";
    case "still-running":
      return "Asked to stop, still running. It had not ended 10 seconds later.";
    case "too-soon":
      return "Another session is being stopped. Try again in a moment.";
    case "failed":
      return how === "background"
        ? "Claude Code did not stop the background job."
        : "The session could not be stopped.";
    case "no-answer":
      return "Agent Lookout did not answer in time. The list shows whether it stopped.";
  }
}

/**
 * The words for what became of one session in a clean-up, beside its name,
 * with a day as how long a session is idle before it is stale.
 */
export const CLEAN_UP_OUTCOME_WORDS: Record<CleanUpOutcome, string> = {
  ended: "Ended",
  "became-active": "Became active",
  "not-stale": "Idle less than a day",
  gone: "Had already ended",
  unsupported: "Not stopped from here",
  "cannot-confirm": "Could not confirm",
  "not-allowed": "Not allowed",
  "still-running": "Still running",
  failed: "Did not stop",
};

/** The same, with how long a session is idle before it is stale as the idle rule says. */
export function cleanUpOutcomeWords(
  outcome: CleanUpOutcome,
  staleAfterMs: number = STALE_THRESHOLD_MS,
): string {
  return outcome === "not-stale"
    ? `Idle less than ${staleAfterInWords(staleAfterMs)}`
    : CLEAN_UP_OUTCOME_WORDS[outcome];
}
