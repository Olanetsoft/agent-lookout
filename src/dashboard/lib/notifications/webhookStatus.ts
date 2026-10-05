import { SENDS_PER_HOUR, type WebhookStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readWebhookStatus } from "@dashboard/lib/api/readApi";
import {
  clockAt,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
} from "@dashboard/lib/notifications/sendingWords";

/**
 * Whether the app posts to a webhook, and for which events, as Settings says
 * it. The page only reads this. The webhook is set up in the environment Agent
 * Lookout starts with, and nothing on the page can turn it on or off. The page
 * is told the host and never the rest of the address.
 */

/** Asks the app whether a webhook is set up. Null when it did not answer, or answered with something else. */
export async function fetchWebhookStatus(): Promise<WebhookStatusResponse | null> {
  try {
    const response = await apiRequest("/api/webhook", {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readWebhookStatus(await response.json());
  } catch {
    return null;
  }
}

/** What Settings says about the webhook: the same two lines the Email card has. */
export function webhookWords(status: WebhookStatusResponse, now: number): SendingWords {
  if (!status.on || status.host === null || status.events === null || status.afterMs === null) {
    return {
      state: "The webhook is off.",
      detail:
        status.problem === null
          ? "Set AGENT_LOOKOUT_WEBHOOK_URL to turn it on."
          : `${status.problem} Correct it and start Agent Lookout again.`,
    };
  }

  const state = whereAndWhen("Posts", status.host, status.events, status.afterMs);
  const { last, limitedUntil } = status;
  if (limitedUntil !== null) {
    // Tries that failed count toward the limit, so a failure is said first.
    const next = clockAt(limitedUntil, now);
    return {
      state,
      detail:
        last !== null && !last.sent
          ? `The last post failed: ${last.reason}. No more will be tried until ${next}, as ${SENDS_PER_HOUR} were tried in the last hour.`
          : `${SENDS_PER_HOUR} posts were tried in the last hour, the most it tries. The next can go at ${next}.`,
    };
  }
  if (last === null) return { state, detail: null };
  return {
    state,
    detail: last.sent
      ? `Last posted at ${clockAt(last.at, now)}.`
      : `The last post failed: ${last.reason}.`,
  };
}
