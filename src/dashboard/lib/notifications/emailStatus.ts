import { SENDS_PER_HOUR, type EmailStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readEmailStatus } from "@dashboard/lib/api/readApi";
import { sentenceStart } from "@dashboard/lib/format";
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
    return status.problem === null
      ? {
          state: "Email is off.",
          title: null,
          detail: "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on.",
        }
      : {
          state: "Email is off.",
          title: "Email is not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  const state = whereAndWhen("Emails", status.to, status.events, status.afterMs);
  const { last, limitedUntil } = status;
  if (limitedUntil !== null) {
    // Tries that failed count toward the limit, so a failure is said first:
    // otherwise a wrong password would read as twenty emails gone.
    const next = clockAt(limitedUntil, now);
    return last !== null && !last.sent
      ? {
          state,
          title: "The last email could not be sent",
          detail: `${sentenceStart(last.reason)}. No more will be tried until ${next}, as ${SENDS_PER_HOUR} were tried in the last hour.`,
        }
      : {
          state,
          title: "Emails are held back",
          detail: `${SENDS_PER_HOUR} emails were tried in the last hour, the most it tries. The next can go at ${next}.`,
        };
  }
  if (last === null) return { state, title: null, detail: null };
  return last.sent
    ? { state, title: null, detail: `Last sent at ${clockAt(last.at, now)}.` }
    : {
        state,
        title: "The last email could not be sent",
        detail: `${sentenceStart(last.reason)}.`,
      };
}
