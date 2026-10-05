import type { Session, WaitingReason } from "./session.ts";

// What is said about a session that waits for the person. The dashboard and the
// collector both say it, in the Needs you panel and in a notification, so the
// words are kept here and neither has a copy.

const WAITING_LABEL: Record<WaitingReason, string> = {
  permission: "Waiting for permission",
  question: "Asked you a question",
  other: "Waiting for you",
};

/** Why a session needs the person, in plain words. */
export function waitingLabel(session: Pick<Session, "waitingReason">): string {
  return WAITING_LABEL[session.waitingReason ?? "other"];
}

/** What a notification of a wait says. */
export interface WaitNotice {
  title: string;
  body: string;
}

/**
 * The notification for a session that started waiting: its name as the title,
 * and the reason as the text. It holds no folder path and none of the vendor's
 * own wording.
 *
 * A name made only of spaces is no name. The project folder stands in for it,
 * then the id, as everywhere a session is named.
 */
export function waitNotice(
  session: Pick<Session, "id" | "name" | "project" | "waitingReason">,
): WaitNotice {
  const title = session.name.trim() !== "" ? session.name : session.project || session.id;
  return { title, body: waitingLabel(session) };
}
