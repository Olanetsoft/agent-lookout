import type { NoticeEvent } from "@core/notices/sessionChanges";
import { clockAt } from "@dashboard/lib/format";

export { clockAt };

/**
 * What the Email and Webhook cards in Settings share: how long a read of the
 * app's answer may take, and the words for where things go, when, and at what
 * time the last one did.
 */

/** A read is not left waiting on a server that has stopped answering. */
export const STATUS_TIMEOUT_MS = 4_000;

/**
 * What Settings says about email or the webhook: one line of state, and a line
 * under it when there is more to say. When something is wrong, a setting, the
 * last send or the hourly limit, the line under it has a title, and the card
 * shows the two as a note, as it shows that notifications are blocked.
 */
export interface SendingWords {
  state: string;
  /** What is wrong, in a few words. Null while nothing is. */
  title: string | null;
  detail: string | null;
}

/** The delay in words: "1 minute", "90 seconds", "2 hours". */
export function delayInWords(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  const counted = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return counted(seconds / 3_600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return counted(seconds / 60, "minute");
  return counted(seconds, "second");
}

/** "a, b or c". */
function eitherOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

/** What each event is, said of "a session": "finishes". A wait has its delay. */
function happens(event: NoticeEvent, afterMs: number): string {
  switch (event) {
    case "needs-you":
      return afterMs === 0 ? "starts waiting" : `has waited ${delayInWords(afterMs)}`;
    case "finished":
      return "finishes";
    case "failed":
      return "fails";
    case "ended":
      return "ends";
  }
}

/**
 * Where emails or posts go and when, naming each event that sends one:
 * "Emails go to n…@example.com after a wait of 1 minute." `what` is "Emails"
 * or "Posts".
 */
export function whereAndWhen(
  what: string,
  to: string,
  events: readonly NoticeEvent[],
  afterMs: number,
): string {
  if (events.length === 1 && events[0] === "needs-you") {
    return afterMs === 0
      ? `${what} go to ${to} as soon as a session waits.`
      : `${what} go to ${to} after a wait of ${delayInWords(afterMs)}.`;
  }
  return `${what} go to ${to} when a session ${eitherOf(events.map((event) => happens(event, afterMs)))}.`;
}
