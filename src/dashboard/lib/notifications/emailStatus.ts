import { EMAILS_PER_HOUR, type EmailStatusResponse } from "@core/api";
import type { NoticeEvent } from "@core/sessions/waitChanges";
import { apiRequest } from "@dashboard/lib/api/apiHost";
import { readEmailStatus } from "@dashboard/lib/api/readApi";
import { formatClockMinutes, formatDay, startOfDay } from "@dashboard/lib/format";

/**
 * Whether the app sends emails, and for which events, as Settings says it. The
 * page only reads this. Email is set up in the environment Agent Lookout starts
 * with, and nothing on the page can turn it on or off.
 */

/** A read is not left waiting on a server that has stopped answering. */
export const EMAIL_STATUS_TIMEOUT_MS = 4_000;

/** Asks the app whether email is set up. Null when it did not answer, or answered with something else. */
export async function fetchEmailStatus(): Promise<EmailStatusResponse | null> {
  try {
    const response = await apiRequest("/api/email", {
      signal: AbortSignal.timeout(EMAIL_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return readEmailStatus(await response.json());
  } catch {
    return null;
  }
}

/** The delay in words: "1 minute", "90 seconds", "2 hours". */
export function delayInWords(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  const counted = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"}`;
  if (seconds >= 3_600 && seconds % 3_600 === 0) return counted(seconds / 3_600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return counted(seconds / 60, "minute");
  return counted(seconds, "second");
}

/** A time on the clock, with the day when it is not today: "14:02", or "14:02 on Oct 4". */
function clockAt(at: number, now: number): string {
  const time = formatClockMinutes(at);
  return startOfDay(at) === startOfDay(now) ? time : `${time} on ${formatDay(at, now)}`;
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

/** Where emails go and when, naming each event that sends one. */
function whereAndWhen(to: string, events: readonly NoticeEvent[], afterMs: number): string {
  if (events.length === 1 && events[0] === "needs-you") {
    return afterMs === 0
      ? `Emails go to ${to} as soon as a session waits.`
      : `Emails go to ${to} after a wait of ${delayInWords(afterMs)}.`;
  }
  return `Emails go to ${to} when a session ${eitherOf(events.map((event) => happens(event, afterMs)))}.`;
}

/** What Settings says about email: one line of state, and a line under it when there is more to say. */
export interface EmailWords {
  state: string;
  detail: string | null;
}

export function emailWords(status: EmailStatusResponse, now: number): EmailWords {
  if (!status.on || status.to === null || status.events === null || status.afterMs === null) {
    return {
      state: "Email is off.",
      detail:
        status.problem === null
          ? "Set AGENT_LOOKOUT_EMAIL_TO and AGENT_LOOKOUT_SMTP_URL to turn it on."
          : `${status.problem} Correct it and start Agent Lookout again.`,
    };
  }

  const state = whereAndWhen(status.to, status.events, status.afterMs);
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
