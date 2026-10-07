import { clockAt, formatDuration } from "../../core/duration.ts";
import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { surfaceLabel, type Session } from "../../core/sessions/session.ts";
import { oneLine, waitingText } from "../../core/text.ts";
import {
  reminderSentence,
  summaryLine,
  WHILE_QUIET,
} from "../../core/time-rules/timeRulesWords.ts";
import type { OverFacts, ReminderFacts, SummaryFacts, WaitFacts } from "./outboundChannel.ts";

/**
 * What one push to a phone says, through ntfy or Pushover alike: a title and a
 * few lines under it, plain text, as the phone shows a notification. The
 * title names the session and what happened, in the words the dashboard uses:
 * "checkout-flow is waiting for permission", "checkout-flow has waited 10
 * minutes for permission" or "billing-webhooks finished", and for the summary
 * of quiet hours, "While quiet". The lines say how long it has waited, or
 * since when, or when it was seen, then the project folder's name, the app
 * and the agent, leaving out any that is not known.
 *
 * With the channel's ASKING setting on, the push for a wait, and for a
 * reminder of one, says first what the session is asking: "Asking: Run: npm
 * test". It is handed over by `outboundChannel.ts`, which alone lets it
 * through. It is never in the title, and never in a push for anything else.
 *
 * Nothing else goes in it: no folder path, no prompt, none of the agent's own
 * words, no link and no markup. The dashboard's address is not in it either:
 * it opens only on this computer.
 */
export interface PhoneMessage {
  /** What it is for, which says how loud the push is. */
  kind: PhoneKind;
  /** At most `MAX_PHONE_TITLE` characters. */
  title: string;
  /** At most `MAX_PHONE_MESSAGE` characters, never empty. */
  message: string;
}

/**
 * needs-you              a wait that has lasted the delay
 * reminder               a reminder of a long wait, or a repeat of one
 * finished/failed/ended  a session that is over
 * quiet-summary          what quiet hours held
 * test                   the push Send a test sends, which says nothing of any session
 */
export type PhoneKind = NoticeEvent | "reminder" | "quiet-summary" | "test";

/** The most a title holds: Pushover's limit, and well inside ntfy's. */
export const MAX_PHONE_TITLE = 250;

/**
 * The most a message holds: Pushover's limit, in characters. Four bytes at
 * most each, it is never more than ntfy's 4,096 bytes, past which ntfy would
 * make it an attachment.
 */
export const MAX_PHONE_MESSAGE = 1_024;

/** Whether a push of this kind is for a session that waits on the person. */
export function isWaitKind(kind: PhoneKind): boolean {
  return kind === "needs-you" || kind === "reminder" || kind === "test";
}

/** Text cut to `max` characters, between code points, with an ellipsis. */
function cutTo(text: string, max: number): string {
  const characters = Array.from(text);
  if (characters.length <= max) return text;
  return `${characters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

function phoneMessage(kind: PhoneKind, title: string, lines: readonly string[]): PhoneMessage {
  const said = lines.filter((line) => line !== "");
  return {
    kind,
    title: cutTo(title, MAX_PHONE_TITLE),
    message: cutTo(said.length > 0 ? said.join("\n") : title, MAX_PHONE_MESSAGE),
  };
}

/** "4m 12s · storefront · VS Code · Claude Code": the first fact, then those of the session that are known. */
function factsLine(
  first: string,
  session: Pick<Session, "project" | "surface">,
  agent: string | null,
): string {
  const facts = [
    first,
    session.project ? oneLine(session.project) : "",
    surfaceLabel(session.surface) ?? "",
    agent ? oneLine(agent) : "",
  ];
  return facts.filter((fact) => fact !== "").join(" · ");
}

/** "Asking: Run: npm test", or nothing when it is not to go. */
function askingLine(asking: string | null): string {
  // The channel has cleaned and cut it already, by the rule the dashboard's
  // line is made by. It is put through that rule again, which leaves it as it
  // was, so no line break handed in can add a line of its own.
  const said = waitingText(asking);
  return said ? `Asking: ${said}` : "";
}

/** The push for a wait that has lasted the delay and is still open. */
export function waitMessage(facts: WaitFacts): PhoneMessage {
  const { session, begunAt, now } = facts;
  return phoneMessage("needs-you", `${oneLine(sessionTitle(session))} ${waitingPhrase(session)}`, [
    askingLine(facts.asking),
    factsLine(formatDuration(Math.max(0, now - begunAt)), session, facts.agent),
  ]);
}

/**
 * The push that reminds of a long wait, and each repeat of it: "checkout-flow
 * has waited 10 minutes for permission". The title says how long already, so
 * the lines say since when.
 */
export function reminderMessage(facts: ReminderFacts): PhoneMessage {
  const { session, begunAt, now } = facts;
  return phoneMessage("reminder", reminderSentence(session, now - begunAt), [
    askingLine(facts.asking),
    factsLine(`Since ${clockAt(begunAt, now)}`, session, facts.agent),
  ]);
}

/**
 * The push that sums up quiet hours once they end: "While quiet", over the
 * line of what they held, "checkout-flow waited 25 minutes and
 * billing-webhooks finished", the first few by name and the rest counted.
 */
export function summaryMessage(facts: SummaryFacts): PhoneMessage {
  return phoneMessage("quiet-summary", WHILE_QUIET, [summaryLine(facts.items)]);
}

/** The push for a session that finished, failed or ended: "billing-webhooks finished". */
export function overMessage(facts: OverFacts): PhoneMessage {
  const { session, seenAt, now } = facts;
  return phoneMessage(facts.event, `${oneLine(sessionTitle(session))} ${overPhrase(facts.event)}`, [
    factsLine(`Seen at ${clockAt(seenAt, now)}`, session, facts.agent),
  ]);
}

/** The push Send a test sends. It holds nothing of any session. */
export function testMessage(): PhoneMessage {
  return phoneMessage("test", "Agent Lookout test", [
    "Pushes from Agent Lookout reach this device.",
  ]);
}
