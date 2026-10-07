import { nameOnMachine, type Session, type WaitingReason } from "../sessions/session.ts";
import type { NoticeEvent } from "./sessionChanges.ts";

// What is said about a session that waits for the person, or that finished,
// failed or ended. The dashboard and the collector both say it, in the Needs
// you panel, in a notification and in an email, so the words are kept here and
// none of them has a copy.

const WAITING_LABEL: Record<WaitingReason, string> = {
  permission: "Waiting for permission",
  question: "Asked you a question",
  other: "Waiting for you",
};

/** The same reasons, said of a session by its name: "checkout-flow is waiting for permission". */
const WAITING_PHRASE: Record<WaitingReason, string> = {
  permission: "is waiting for permission",
  question: "asked you a question",
  other: "is waiting for you",
};

/** Why a session needs the person, in plain words. */
export function waitingLabel(session: Pick<Session, "waitingReason">): string {
  return WAITING_LABEL[session.waitingReason ?? "other"];
}

/** Why a session needs the person, as the words that follow its name. */
export function waitingPhrase(session: Pick<Session, "waitingReason">): string {
  return WAITING_PHRASE[session.waitingReason ?? "other"];
}

/**
 * What a session is called wherever it is named. A name made only of spaces is
 * no name, so the project folder stands in for it, then the id.
 */
export function sessionTitle(session: Pick<Session, "id" | "name" | "project">): string {
  return session.name.trim() !== "" ? session.name : session.project || session.id;
}

/**
 * What a notification calls a session: its name, and the other machine it runs
 * on when it runs on one, "checkout-flow on devbox".
 */
export function noticeTitle(session: Pick<Session, "id" | "name" | "project" | "machine">): string {
  return nameOnMachine(sessionTitle(session), session.machine);
}

/** What a notification says. */
export interface Notice {
  title: string;
  body: string;
}

/**
 * The notification for a session that started waiting: its name as the title,
 * with the other machine it runs on when it runs on one, and the reason as the text, followed by what the session is asking when that
 * is known: "Waiting for permission: Run: npm test". It holds none of the
 * vendor's own wording, and not the session's folder, but what the session is
 * asking can hold a command, a web address, or a file's full path when the
 * file is outside the session's folder.
 *
 * It is shown on this machine alone, by the page or by the collector. An
 * email, a webhook post and a push, which leave the machine, are written
 * elsewhere, and hold what the session is asking only for a wait, and only
 * with that channel's own setting on: `AGENT_LOOKOUT_EMAIL_ASKING=on`,
 * `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, `AGENT_LOOKOUT_NTFY_ASKING=on` or
 * `AGENT_LOOKOUT_PUSHOVER_ASKING=on`. `outboundChannel.ts` is the one place it
 * is let through to them.
 */
export function waitNotice(
  session: Pick<Session, "id" | "name" | "project" | "machine" | "waitingReason" | "waitingText">,
): Notice {
  const reason = waitingLabel(session);
  const asking = session.waitingText?.trim();
  return { title: noticeTitle(session), body: asking ? `${reason}: ${asking}` : reason };
}

/** Each event as Settings lists it, and as a notification of any but a wait says it. */
export const NOTICE_EVENT_LABEL: Record<NoticeEvent, string> = {
  "needs-you": "Needs you",
  finished: "Finished",
  failed: "Failed",
  ended: "Ended",
};

/** The same events, said of a session by its name: "billing-webhooks finished". */
const OVER_PHRASE: Record<Exclude<NoticeEvent, "needs-you">, string> = {
  finished: "finished",
  failed: "failed",
  ended: "ended",
};

/** What happened to a session that is over, as the words that follow its name. */
export function overPhrase(event: Exclude<NoticeEvent, "needs-you">): string {
  return OVER_PHRASE[event];
}

/**
 * The notification for one change: the session's name as the title, as
 * `noticeTitle` gives it, and what happened as the text. A wait gives its reason and what it is asking, as
 * `waitNotice` does, and the others say Finished, Failed or Ended.
 */
export function changeNotice(change: {
  event: NoticeEvent;
  session: Pick<Session, "id" | "name" | "project" | "machine" | "waitingReason" | "waitingText">;
}): Notice {
  if (change.event === "needs-you") return waitNotice(change.session);
  return { title: noticeTitle(change.session), body: NOTICE_EVENT_LABEL[change.event] };
}
