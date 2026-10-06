import { clockAt, durationInWords } from "../../core/duration.ts";
import { surfaceLabel, type Session } from "../../core/sessions/session.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { oneLine } from "../../core/text.ts";
import type { OverFacts, WaitFacts } from "../outbound/outboundChannel.ts";
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
  const app = surfaceLabel(session.surface);
  if (app) lines.push(`App: ${app}`);
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
    `It has waited ${durationInWords(now - begunAt)}, since ${clockAt(begunAt, now)}.`,
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
    `Agent Lookout saw this at ${clockAt(seenAt, now)}.`,
    session,
    facts.agent,
  );
}
