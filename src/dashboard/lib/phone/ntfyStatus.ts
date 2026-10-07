import type { NtfyStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readNtfyStatus } from "@dashboard/lib/api/readApi";
import {
  lastSendWords,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
  type SendNouns,
} from "@dashboard/lib/notifications/sendingWords";

/**
 * Whether the app pushes through ntfy, and for which events, as Settings says
 * it. The page only reads this, and asks for a test push: ntfy is set up in
 * the environment Agent Lookout starts with, and nothing on the page can turn
 * it on or off. The page is told the server's host, and never the topic or
 * the token.
 */

/** Asks the app whether ntfy is set up. Null when it did not answer, or answered with something else. */
export async function fetchNtfyStatus(): Promise<NtfyStatusResponse | null> {
  try {
    const response = await apiRequest("/api/ntfy", {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readNtfyStatus(await response.json());
  } catch {
    return null;
  }
}

/** What the ntfy and Pushover cards call what they send. */
export const PUSH_NOUNS: SendNouns = {
  plural: "pushes",
  failed: "The last push failed",
  held: "Pushes are held back",
  lastAt: "Last sent at",
};

/** What the ntfy card in Settings says: the lines the Webhook card has, and whether a token guards the topic. */
export function ntfyWords(status: NtfyStatusResponse, now: number): SendingWords {
  if (!status.on || status.host === null || status.events === null || status.afterMs === null) {
    return status.problem === null
      ? {
          state: "ntfy is off.",
          asking: null,
          title: null,
          detail: "Set AGENT_LOOKOUT_NTFY_URL to turn it on.",
        }
      : {
          state: "ntfy is off.",
          asking: null,
          title: "ntfy is not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  const said = {
    state: whereAndWhen("Pushes", status.host, status.events, status.afterMs),
    asking: status.asking
      ? "Pushes for a wait say what the session is asking."
      : "Pushes leave out what a waiting session is asking.",
    note: status.tokenSet
      ? "An access token is set."
      : "No access token is set, so the topic alone guards the pushes: keep it secret.",
  };
  return { ...said, ...lastSendWords(status, now, PUSH_NOUNS) };
}
