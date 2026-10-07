import { clockAt, durationInWords } from "../../core/duration.ts";
import { surfaceLabel, type Session } from "../../core/sessions/session.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { oneLine, waitingText } from "../../core/text.ts";
import type { SummaryItem } from "../../core/time-rules/quietHold.ts";
import {
  reminderSentence,
  summaryItemPhrase,
  summaryLine,
  summaryWaitedPhrase,
  waitedInWords,
  WHILE_QUIET,
} from "../../core/time-rules/timeRulesWords.ts";
import type {
  OverFacts,
  ReminderFacts,
  SummaryFacts,
  WaitFacts,
} from "../outbound/outboundChannel.ts";
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
 *
 * The time rules add two more. A reminder of a long wait, and each repeat of
 * it, is the email of a wait, with a subject that says how long it has waited. A summary of quiet
 * hours names each session that waited, finished, failed or ended while they
 * held, with how long and when, and nothing else of them.
 */
export interface EmailContent {
  subject: string;
  text: string;
}

/** The line every email ends with. */
const SENT_BY = `Sent by Agent Lookout on your computer. To stop these emails, start it again without ${EMAIL_TO_ENV}.`;

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
  lines.push("", SENT_BY);
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
 * The email that reminds of a long wait: "checkout-flow has waited 10 minutes
 * for permission", and a repeat the same, with how long it has waited by
 * then. It says the rest as the email of a wait does.
 */
export function reminderEmail(facts: ReminderFacts): EmailContent {
  const { session, begunAt, now } = facts;
  const again =
    facts.everyMs === null
      ? ""
      : `, and again every ${waitedInWords(facts.everyMs)} while it goes on`;
  return emailOf(
    reminderSentence(session, now - begunAt),
    `It has waited since ${clockAt(begunAt, now)}. Agent Lookout reminds you once a wait lasts ${waitedInWords(facts.thresholdMs)}${again}, as Time rules in Settings says.`,
    session,
    facts.agent,
    facts.asking,
  );
}

/** The most items a summary's body lists one by one. The rest are counted. */
const MAX_SUMMARY_LINES = 50;

/**
 * One item as a line of the body: "checkout-flow waited 25 minutes, from
 * 23:10.", "billing-webhooks finished at 23:40.", and for a session that did
 * both, "checkout-flow waited 25 minutes, from 23:10, then ended at 23:40."
 */
function summaryItemLine(item: SummaryItem, now: number): string {
  if (item.event !== "needs-you") return `${summaryItemPhrase(item)} at ${clockAt(item.at, now)}.`;
  const waited = `${oneLine(sessionTitle(item.session))} ${summaryWaitedPhrase(item)}, from ${clockAt(item.at, now)}`;
  return item.then
    ? `${waited}, then ${overPhrase(item.then.event)} at ${clockAt(item.then.at, now)}.`
    : `${waited}.`;
}

/**
 * The email that sums up quiet hours once they end, with a subject that names
 * the first few: "While quiet: checkout-flow waited 25 minutes and
 * billing-webhooks finished". Its body gives each session its own line, with
 * how long it waited and from when, or when it finished, failed or ended.
 */
export function summaryEmail(facts: SummaryFacts): EmailContent {
  const { items, now } = facts;
  const lines = [
    `During quiet hours, from ${clockAt(facts.from, now)} to ${clockAt(facts.to, now)}:`,
    "",
    ...items.slice(0, MAX_SUMMARY_LINES).map((item) => summaryItemLine(item, now)),
  ];
  if (items.length > MAX_SUMMARY_LINES) lines.push(`And ${items.length - MAX_SUMMARY_LINES} more.`);
  lines.push(
    "",
    "Quiet hours are set under Time rules in Settings. A session still waiting when they ended has an email of its own.",
    "",
    SENT_BY,
  );
  return {
    subject: oneLine(`${WHILE_QUIET}: ${summaryLine(items, 3)}`, 160),
    text: `${lines.join("\n")}\n`,
  };
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
