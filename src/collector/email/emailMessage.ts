import { clockAt, durationInWords } from "../../core/duration.ts";
import { surfaceLabel, type Session } from "../../core/sessions/session.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { oneLine, waitingText } from "../../core/text.ts";
import type { OverFacts, WaitFacts } from "../outbound/outboundChannel.ts";
import { EMAIL_TO_ENV } from "./emailSettings.ts";

/**
 * What one email says. It is plain text and short: a subject that names the
 * session and what happened, and a body with how long it has waited and since
 * when, or when it finished, failed or ended, then the project folder's name,
 * the app, the agent and how to stop these emails. With
 * `AGENT_LOOKOUT_EMAIL_ASKING=on`, the body for a wait also says what the
 * session is asking, as the dashboard shows it, which can hold a command, a web
 * address or a file's full path. It is never in the subject. Nothing else goes
 * in it: no folder path, no prompt, none of the agent's own words, no link of
 * Agent Lookout's own and no markup.
 */
export interface EmailContent {
  subject: string;
  text: string;
}

/**
 * The email: the sentence of what happened, a line on when, then the facts
 * every email ends with, led for a wait by what the session is asking when
 * that is to go.
 */
function emailOf(
  happened: string,
  when: string,
  session: Pick<Session, "project" | "surface">,
  agentName: string | null,
  asking: string | null = null,
): EmailContent {
  const lines = [`${happened}.`, "", when, ""];
  // The channel has cleaned and cut it already, by the rule the dashboard's
  // line is made by. It is put through that rule again, which leaves it as it
  // was, so no line break handed in can add a line of its own to the body.
  const said = waitingText(asking);
  if (said) lines.push(`Asking: ${said}`);
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
    facts.asking,
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
