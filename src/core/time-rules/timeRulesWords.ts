import { durationParts, partsInWords } from "../duration.ts";
import { noticeTitle, overPhrase, sessionTitle, type Notice } from "../notices/waiting.ts";
import type { Session, WaitingReason } from "../sessions/session.ts";
import { oneLine } from "../text.ts";
import type { SummaryItem } from "./quietHold.ts";

// What a reminder and a summary say, wherever they go: a notification on this
// computer, an email and a webhook post all take their words from here.

const MINUTE_MS = 60_000;

/**
 * How long, in words, to the minute: "25 minutes", "1 hour 4 minutes", "2 days
 * 3 hours", and "under a minute" for less. A reminder and a summary are read
 * later, so the seconds would be noise.
 */
export function waitedInWords(ms: number): string {
  if (ms < MINUTE_MS) return "under a minute";
  return partsInWords(durationParts(ms).filter((part) => part.unit !== "s"));
}

/** What a session waits for, as the words after how long it has. */
const WAITED_FOR: Record<WaitingReason, string> = {
  permission: "for permission",
  question: "for an answer",
  other: "for you",
};

/** "has waited 10 minutes for permission". */
export function reminderPhrase(session: Pick<Session, "waitingReason">, waitedMs: number): string {
  return `has waited ${waitedInWords(waitedMs)} ${WAITED_FOR[session.waitingReason ?? "other"]}`;
}

/** "checkout-flow has waited 10 minutes for permission". */
export function reminderSentence(
  session: Pick<Session, "id" | "name" | "project" | "waitingReason">,
  waitedMs: number,
): string {
  return `${oneLine(sessionTitle(session))} ${reminderPhrase(session, waitedMs)}`;
}

/**
 * The notification that reminds of a long wait: the session's name as the
 * title, with the other machine it runs on when it runs on one, as a wait's own
 * notification has it, and as the text how long it has waited and for what,
 * followed by what it is asking when that is known: "Has waited 10 minutes for
 * permission: Run: npm test". Like a wait's own notification, it is shown on
 * this computer alone.
 */
export function reminderNotice(
  session: Pick<Session, "id" | "name" | "project" | "machine" | "waitingReason" | "waitingText">,
  waitedMs: number,
): Notice {
  const phrase = reminderPhrase(session, waitedMs);
  const said = `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
  const asking = session.waitingText?.trim();
  return { title: noticeTitle(session), body: asking ? `${said}: ${asking}` : said };
}

/** What a summary is headed with, and what its line begins with. */
export const WHILE_QUIET = "While quiet";

/**
 * How long a session waited in a summary, after its name: "waited 25
 * minutes", or "waited 1 hour 5 minutes over 2 waits". No comma, so a line of
 * items still reads as a list.
 */
export function summaryWaitedPhrase(item: { waitedMs: number; times: number }): string {
  const waited = waitedInWords(item.waitedMs);
  return item.times === 1 ? `waited ${waited}` : `waited ${waited} over ${item.times} waits`;
}

/** What a summary calls a session: its name alone, as an email and a post do. */
type SummaryName = (session: Session) => string;

/**
 * One item of a summary: "checkout-flow waited 25 minutes", "billing-webhooks
 * finished", and for a session that did both, "checkout-flow waited 25
 * minutes then ended". A notification names the other machine too, by
 * `noticeTitle`: "docs-site on devbox waited 25 minutes".
 */
export function summaryItemPhrase(item: SummaryItem, title: SummaryName = sessionTitle): string {
  const name = oneLine(title(item.session));
  if (item.event !== "needs-you") return `${name} ${overPhrase(item.event)}`;
  const waited = `${name} ${summaryWaitedPhrase(item)}`;
  return item.then ? `${waited} then ${overPhrase(item.then.event)}` : waited;
}

/**
 * The items of a summary on one line, the first few by name and the rest
 * counted: "checkout-flow waited 25 minutes, billing-webhooks finished and 3
 * more".
 */
export function summaryLine(
  items: readonly SummaryItem[],
  named = 4,
  title: SummaryName = sessionTitle,
): string {
  const shown = items.slice(0, named).map((item) => summaryItemPhrase(item, title));
  const rest = items.length - shown.length;
  if (rest === 0) {
    return shown.length <= 1
      ? (shown[0] ?? "")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  }
  return `${shown.join(", ")} and ${rest} more`;
}

/**
 * The notification that sums up the quiet hours: "While quiet" over the line
 * of what happened, with the other machine a session runs on, as a wait's own
 * notification names it.
 */
export function summaryNotice(items: readonly SummaryItem[]): Notice {
  return { title: WHILE_QUIET, body: summaryLine(items, undefined, noticeTitle) };
}
