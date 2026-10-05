import { EMAILS_PER_HOUR, type EmailStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readEmailStatus } from "@dashboard/lib/api/readApi";
import {
  clockAt,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
} from "@dashboard/lib/notifications/sendingWords";

/**
 * Whether the app sends emails, and for which events, as Settings says it. The
 * page only reads this. Email is set up in the environment Agent Lookout starts
 * with, and nothing on the page can turn it on or off.
 */

/** Asks the app whether email is set up. Null when it did not answer, or answered with something else. */
export async function fetchEmailStatus(): Promise<EmailStatusResponse | null> {
  try {
    const response = await apiRequest("/api/email", {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readEmailStatus(await response.json());
  } catch {
    return null;
  }
}

/** What the Email card in Settings says. */
export function emailWords(status: EmailStatusResponse, now: number): SendingWords {
  if (!status.on || status.to === null || status.events === null || status.afterMs === null) {
    return {
      state: "Email is off.",
      detail:
        status.problem === null
          ? "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on."
          : `${status.problem} Correct it and start Agent Lookout again.`,
    };
  }

  const state = whereAndWhen("Emails", status.to, status.events, status.afterMs);
  const { last, limitedUntil } = status;
  if (limitedUntil !== null) {
    // Tries that failed count toward the limit, so a failure is said first:
    // otherwise a wrong password would read as twenty emails gone.
    const next = clockAt(limitedUntil, now);
    return {
      state,
      detail:
        last !== null && !last.sent
          ? `The last email could not be sent: ${last.reason}. No more will be tried until ${next}, as ${EMAILS_PER_HOUR} were tried in the last hour.`
          : `${EMAILS_PER_HOUR} emails were tried in the last hour, the most it tries. The next can go at ${next}.`,
    };
  }
  if (last === null) return { state, detail: null };
  return {
    state,
    detail: last.sent
      ? `Last sent at ${clockAt(last.at, now)}.`
      : `The last email could not be sent: ${last.reason}.`,
  };
}
