import type { WebhookStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readWebhookStatus } from "@dashboard/lib/api/readApi";
import {
  lastSendWords,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
  type SendNouns,
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

const WEBHOOK_NOUNS: SendNouns = {
  plural: "posts",
  failed: "The last post failed",
  held: "Posts are held back",
  lastAt: "Last posted at",
};

/** What Settings says about the webhook: the same lines the Email card has. */
export function webhookWords(status: WebhookStatusResponse, now: number): SendingWords {
  if (!status.on || status.host === null || status.events === null || status.afterMs === null) {
    return status.problem === null
      ? {
          state: "The webhook is off.",
          asking: null,
          title: null,
          detail: "Set AGENT_LOOKOUT_WEBHOOK_URL to turn it on.",
        }
      : {
          state: "The webhook is off.",
          asking: null,
          title: "The webhook is not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  const said = {
    state: whereAndWhen("Posts", status.host, status.events, status.afterMs),
    asking: status.asking
      ? "Posts for a wait say what the session is asking."
      : "Posts leave out what a waiting session is asking.",
  };
  return { ...said, ...lastSendWords(status, now, WEBHOOK_NOUNS) };
}
