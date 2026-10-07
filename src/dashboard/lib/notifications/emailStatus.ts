import type { EmailStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readEmailStatus } from "@dashboard/lib/api/readApi";
import {
  lastSendWords,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
  type SendNouns,
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

const EMAIL_NOUNS: SendNouns = {
  plural: "emails",
  failed: "The last email could not be sent",
  held: "Emails are held back",
  lastAt: "Last sent at",
};

/** What the Email card in Settings says. */
export function emailWords(status: EmailStatusResponse, now: number): SendingWords {
  if (!status.on || status.to === null || status.events === null || status.afterMs === null) {
    return status.problem === null
      ? {
          state: "Email is off.",
          asking: null,
          title: null,
          detail: "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on.",
        }
      : {
          state: "Email is off.",
          asking: null,
          title: "Email is not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  const said = {
    state: whereAndWhen("Emails", status.to, status.events, status.afterMs),
    asking: status.asking
      ? "Emails for a wait say what the session is asking."
      : "Emails leave out what a waiting session is asking.",
  };
  return { ...said, ...lastSendWords(status, now, EMAIL_NOUNS) };
}
