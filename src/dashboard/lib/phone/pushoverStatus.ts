import type { PushoverStatusResponse } from "@core/api";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readPushoverStatus } from "@dashboard/lib/api/readApi";
import {
  lastSendWords,
  STATUS_TIMEOUT_MS,
  whereAndWhen,
  type SendingWords,
} from "@dashboard/lib/notifications/sendingWords";
import { PUSH_NOUNS } from "@dashboard/lib/phone/ntfyStatus";

/**
 * Whether the app pushes through Pushover, and for which events, as Settings
 * says it. The page only reads this, and asks for a test push: Pushover is set
 * up in the environment Agent Lookout starts with. The page is never told the
 * application's token or the user key.
 */

/** Asks the app whether Pushover is set up. Null when it did not answer, or answered with something else. */
export async function fetchPushoverStatus(): Promise<PushoverStatusResponse | null> {
  try {
    const response = await apiRequest("/api/pushover", {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readPushoverStatus(await response.json());
  } catch {
    return null;
  }
}

/** What the Pushover card in Settings says: the lines the ntfy card has. */
export function pushoverWords(status: PushoverStatusResponse, now: number): SendingWords {
  if (!status.on || status.events === null || status.afterMs === null) {
    return status.problem === null
      ? {
          state: "Pushover is off.",
          asking: null,
          title: null,
          detail: "Set AGENT_LOOKOUT_PUSHOVER_TOKEN and AGENT_LOOKOUT_PUSHOVER_USER to turn it on.",
        }
      : {
          state: "Pushover is off.",
          asking: null,
          title: "Pushover is not set up correctly",
          detail: `${status.problem} Correct it and start Agent Lookout again.`,
        };
  }

  const said = {
    state: whereAndWhen("Pushes", "Pushover", status.events, status.afterMs),
    asking: status.asking
      ? "Pushes for a wait say what the session is asking."
      : "Pushes leave out what a waiting session is asking.",
  };
  return { ...said, ...lastSendWords(status, now, PUSH_NOUNS) };
}
