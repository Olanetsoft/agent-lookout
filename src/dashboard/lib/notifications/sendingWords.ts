import { SENDS_PER_HOUR, type SendResult } from "@core/api";
import type { NoticeEvent } from "@core/notices/sessionChanges";
import { clockAt, sentenceStart } from "@dashboard/lib/format";

export { clockAt };

/**
 * What the Email, Webhook, ntfy and Pushover cards in Settings share: how long
 * a read of the app's answer may take, and the words for where things go,
 * when, and at what time the last one did.
 */

/** A read is not left waiting on a server that has stopped answering. */
export const STATUS_TIMEOUT_MS = 4_000;

/**
 * What Settings says about email, the webhook, ntfy or Pushover: one line of
 * state, while it is on a line on whether what a waiting session is asking
 * goes too, and a line under those when there is more to say. When something
 * is wrong, a setting, the last send or the hourly limit, that last line has a
 * title, and the card shows the two as a note, as it shows that notifications
 * are blocked.
 */
export interface SendingWords {
  state: string;
  /** Whether a wait's email, post or push says what the session is asking. Null while it is off. */
  asking: string | null;
  /**
   * One more plain line under that, for what the person should know of how it
   * is set up: for ntfy, whether its topic has an access token. Left out by
   * the others.
   */
  note?: string | null;
  /** What is wrong, in a few words. Null while nothing is. */
  title: string | null;
  detail: string | null;
}

/** What one channel calls what it sends, for the line on how the last one went. */
export interface SendNouns {
  /** "emails", "posts", "pushes" */
  plural: string;
  /** The title when the last failed: "The last email could not be sent". */
  failed: string;
  /** The title while the hourly limit holds them: "Emails are held back". */
  held: string;
  /** How the line on the last one begins: "Last sent at", "Last posted at". */
  lastAt: string;
}

/**
 * The line under the others: how the last one went, or that the hourly limit
 * holds them back.
 */
export function lastSendWords(
  status: { last: SendResult | null; limitedUntil: number | null },
  now: number,
  nouns: SendNouns,
): Pick<SendingWords, "title" | "detail"> {
  const { last, limitedUntil } = status;
  if (limitedUntil !== null) {
    // Tries that failed count toward the limit, so a failure is said first:
    // otherwise a wrong password would read as twenty gone.
    const next = clockAt(limitedUntil, now);
    return last !== null && !last.sent
      ? {
          title: nouns.failed,
          detail: `${sentenceStart(last.reason)}. No more will be tried until ${next}, as ${SENDS_PER_HOUR} were tried in the last hour.`,
        }
      : {
          title: nouns.held,
          detail: `${SENDS_PER_HOUR} ${nouns.plural} were tried in the last hour, the most it tries. The next can go at ${next}.`,
        };
  }
  if (last === null) return { title: null, detail: null };
  return last.sent
    ? { title: null, detail: `${nouns.lastAt} ${clockAt(last.at, now)}.` }
    : { title: nouns.failed, detail: `${sentenceStart(last.reason)}.` };
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
 * Where emails, posts or pushes go and when, naming each event that sends
 * one: "Emails go to n…@example.com after a wait of 1 minute." `what` is
 * "Emails", "Posts" or "Pushes".
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
