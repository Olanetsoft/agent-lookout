import { SURFACE_LABEL, type Session } from "../../core/sessions/session.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/sessions/waiting.ts";
import type { OverFacts, WaitFacts } from "../outbound/outboundChannel.ts";
import { oneLine } from "../outbound/outboundText.ts";
import { EMAIL_TO_ENV } from "./emailSettings.ts";

/**
 * What one email says. It is plain text and short: a subject that names the
 * session and what happened, and a body with how long it has waited and since
 * when, or when it finished, failed or ended, then the project folder's name,
 * the app, the agent and how to stop these emails. Nothing else goes in it: no
 * path, no prompt, none of the agent's own words, no link and no markup.
 */
export interface EmailContent {
  subject: string;
  text: string;
}

function counted(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** A length of time in words, to the second under an hour and to the minute after: "1 minute 5 seconds". */
export function waitedInWords(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return counted(seconds, "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0
      ? counted(minutes, "minute")
      : `${counted(minutes, "minute")} ${counted(rest, "second")}`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? counted(hours, "hour")
    : `${counted(hours, "hour")} ${counted(rest, "minute")}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (value: number) => String(value).padStart(2, "0");

/**
 * A moment on this computer's clock, 24-hour, as the dashboard writes one:
 * "14:01", with the day in front when it is not the day of `now`: "Oct 4, 23:59".
 */
export function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? time : `${MONTHS[date.getMonth()]} ${date.getDate()}, ${time}`;
}

/** The email: the sentence of what happened, a line on when, then the facts every email ends with. */
function emailOf(
  happened: string,
  when: string,
  session: Pick<Session, "project" | "surface">,
  agentName: string | null,
): EmailContent {
  const lines = [`${happened}.`, "", when, ""];
  const folder = session.project ? oneLine(session.project) : "";
  if (folder) lines.push(`Folder: ${folder}`);
  if (session.surface !== "unknown") lines.push(`App: ${SURFACE_LABEL[session.surface]}`);
  const agent = agentName ? oneLine(agentName) : "";
  if (agent) lines.push(`Agent: ${agent}`);
  lines.push(
    "",
    `Sent by Agent Lookout on your computer. To stop these emails, start it again without ${EMAIL_TO_ENV}.`,
  );
  return { subject: happened, text: `${lines.join("\n")}\n` };
}

/** The email for a wait that has lasted the delay and is still open. */
export function waitEmail(facts: WaitFacts): EmailContent {
  const { session, begunAt, now } = facts;
  return emailOf(
    `${oneLine(sessionTitle(session))} ${waitingPhrase(session)}`,
    `It has waited ${waitedInWords(now - begunAt)}, since ${clockTime(begunAt, now)}.`,
    session,
    facts.agent,
  );
}

/**
 * The email for a session that finished, failed or ended: "billing-webhooks
 * finished". It is sent as soon as that is seen, so it says when that was,
 * for an email the hourly limit held back.
 */
export function overEmail(facts: OverFacts): EmailContent {
  const { session, seenAt, now } = facts;
  return emailOf(
    `${oneLine(sessionTitle(session))} ${overPhrase(facts.event)}`,
    `Agent Lookout saw this at ${clockTime(seenAt, now)}.`,
    session,
    facts.agent,
  );
}
