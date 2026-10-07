import {
  ACTION_HEADER,
  PHONE_TEST_ACTION,
  PHONE_TEST_PATH,
  SENDS_PER_HOUR,
  type PhoneChannel,
  type PhoneTestFailure,
} from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { clockAt } from "@dashboard/lib/format";

/**
 * Send a test, on the ntfy and Pushover cards in Settings: the request that
 * asks the app to send one test push through that channel, and the words for
 * what it came to. The request names the channel and nothing else, and the
 * push holds nothing of any session.
 */

/**
 * A press is not left waiting on a server that has stopped answering. Longer
 * than the 10 seconds the app gives the push itself, so its own answer comes
 * first.
 */
export const TEST_TIMEOUT_MS = 15_000;

/** What pressing Send a test came to. */
export type TestSendOutcome =
  | { ok: true; at: number }
  | {
      ok: false;
      /** Why, as the app said, or `no-answer` when it did not answer with data. */
      reason: PhoneTestFailure | "no-answer";
      /** The app's own sentence, when it gave one. */
      error: string | null;
      /** With `limited`: when the next may go. */
      limitedUntil: number | null;
    };

const FAILURES: readonly PhoneTestFailure[] = ["off", "too-soon", "limited", "not-sent"];

/** The longest sentence of the app's that is shown. Its own are far shorter. */
const MAX_ERROR_LENGTH = 300;

/** Asks the app to send one test push through `channel`. It never rejects. */
export async function requestTestSend(
  channel: PhoneChannel,
  timeoutMs: number = TEST_TIMEOUT_MS,
): Promise<TestSendOutcome> {
  try {
    const response = await apiRequest(PHONE_TEST_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTION_HEADER]: PHONE_TEST_ACTION },
      body: JSON.stringify({ channel }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await response.json();
    const answer =
      typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    if (response.ok && answer.ok === true && typeof answer.sentAt === "number") {
      return { ok: true, at: answer.sentAt };
    }
    const error =
      typeof answer.error === "string" && answer.error.length <= MAX_ERROR_LENGTH
        ? answer.error
        : null;
    return {
      ok: false,
      reason: FAILURES.find((failure) => failure === answer.reason) ?? "not-sent",
      error,
      limitedUntil:
        typeof answer.limitedUntil === "number" && Number.isFinite(answer.limitedUntil)
          ? answer.limitedUntil
          : null,
    };
  } catch {
    return { ok: false, reason: "no-answer", error: null, limitedUntil: null };
  }
}

/** What the card says under Send a test when no test went, or it did not arrive. */
export function testFailureWords(
  outcome: Extract<TestSendOutcome, { ok: false }>,
  now: number,
): string {
  switch (outcome.reason) {
    case "no-answer":
      return "Agent Lookout did not answer. Try again in a moment.";
    case "too-soon":
      return "A test is already on its way. Try again in a moment.";
    case "limited":
      return outcome.limitedUntil === null
        ? `${SENDS_PER_HOUR} pushes were tried in the last hour, the most it tries. Try again later.`
        : `${SENDS_PER_HOUR} pushes were tried in the last hour, the most it tries. The next can go at ${clockAt(outcome.limitedUntil, now)}.`;
    case "off":
      return outcome.error ?? "It is not set up. Start Agent Lookout again with its settings.";
    case "not-sent":
      return outcome.error ?? "It could not be sent. Try again in a moment.";
  }
}
