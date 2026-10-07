import { formatDuration } from "../../core/duration.ts";
import { surfaceLabel, type Session, type WaitingReason } from "../../core/sessions/session.ts";
import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { oneLine, waitingText } from "../../core/text.ts";
import {
  reminderSentence,
  summaryLine,
  WHILE_QUIET,
} from "../../core/time-rules/timeRulesWords.ts";
import type {
  OverFacts,
  ReminderFacts,
  SummaryFacts,
  WaitFacts,
} from "../outbound/outboundChannel.ts";

/**
 * What one post to the webhook holds, as JSON. `text` is one line for a
 * person, which is what Slack shows, so a Slack incoming webhook takes the
 * post as it is. The rest says the same for a program: the event, the reason
 * for a wait, the session's name, agent, project folder and app, when it
 * happened, and how long a wait had lasted when it was posted. With
 * `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, the post for a wait also says what the
 * session is asking, as the dashboard shows it, in `text` after the reason and
 * in `asking`. That can hold a command, a web address or a file's full path.
 *
 * Nothing else goes in it: no folder path, no prompt, none of the agent's own words.
 *
 * A reminder of a long wait is the post of a wait with `reminder: true`, and a
 * line that says how long it has waited. A repeat of it says which it is, in
 * `repeat`. When quiet hours end, the post that
 * sums them up is a `WebhookSummaryPost`, with `event: "quiet-summary"`.
 */
export type WebhookPost = WebhookEventPost | WebhookSummaryPost;

/** The post for one event: a wait, a reminder of one, or a session that finished, failed or ended. */
export interface WebhookEventPost {
  text: string;
  event: NoticeEvent;
  /** Why the session waits. A wait only. */
  reason?: WaitingReason;
  /**
   * What the session is asking, as the dashboard shows it: "Run: npm test". A
   * wait only, with `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, and only when its agent says.
   */
  asking?: string;
  session: {
    name: string;
    /** The agent, such as "Claude Code". Null when not known. */
    agent: string | null;
    /** The project folder's name, the last part of its path, never the path. Null when not known. */
    folder: string | null;
    /** The app it runs in, such as "VS Code". Null when not known. */
    app: string | null;
  };
  /** When it happened, in ISO 8601: when the wait began, or when the collector saw the session finish, fail or end. */
  at: string;
  /** How long the wait had lasted when it was posted, in whole seconds. A wait only. */
  waitedSeconds?: number;
  /** Present, and true, on a reminder of a long wait. */
  reminder?: true;
  /**
   * On a repeat of a reminder, which it is, by how long the wait has lasted: 1
   * once the repeat's minutes have passed after the first reminder, 2 after
   * twice that, and so on. Left out on the first.
   */
  repeat?: number;
}

/** The session as a post names it. */
export type WebhookSession = WebhookEventPost["session"];

/** One item of a summary. */
export interface WebhookSummaryItem {
  /** What happened: `needs-you` for a session that waited and was answered. */
  event: NoticeEvent;
  session: WebhookSession;
  /** When it happened, in ISO 8601: when its first wait began, or when it finished, failed or ended. */
  at: string;
  /** For waits: how long they lasted, in all, in whole seconds. */
  waitedSeconds?: number;
  /** For waits: how many times it waited. */
  times?: number;
  /**
   * For waits: what the session did after its last wait began, when it
   * finished, failed or ended in the quiet hours, and when, in ISO 8601.
   * Such a session is one item. Left out otherwise.
   */
  then?: { event: Exclude<NoticeEvent, "needs-you">; at: string };
}

/**
 * The post that sums up quiet hours once they end: what was held, oldest
 * first, as one line in `text` and each item in `items`. A wait still open
 * when they ended has a post of its own, and is not in it.
 */
export interface WebhookSummaryPost {
  text: string;
  event: "quiet-summary";
  /** When the quiet hours began and ended, as Agent Lookout saw them, in ISO 8601. */
  from: string;
  to: string;
  /** At most `MAX_SUMMARY_ITEMS`, oldest first. */
  items: WebhookSummaryItem[];
  /** How many more there were than `items` holds. Left out when none. */
  more?: number;
}

/** The most items one summary post holds. */
export const MAX_SUMMARY_ITEMS = 100;

/**
 * Text made safe for the line Slack shows. Slack reads `<...>` as a mention or
 * a link, as in `<!channel>`, `<@U123>` or `<https://example.com|a label>`, and
 * `&` as the start of an entity, so those three are written as entities, which
 * Slack shows as the characters themselves. An @ is followed by a space of no
 * width, so a name such as `@everyone` cannot ping a channel on a service that
 * reads plain mentions, as Discord does.
 */
export function slackSafe(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b");
}

/** The session as a post names it, each part cleaned to one short line. */
function sessionOf(
  session: Pick<Session, "id" | "name" | "project" | "surface">,
  agent: string | null,
) {
  return {
    name: oneLine(sessionTitle(session)),
    agent: (agent && oneLine(agent)) || null,
    folder: (session.project && oneLine(session.project)) || null,
    app: surfaceLabel(session.surface),
  };
}

/** "checkout-flow is waiting for permission (4m 12s, checkout-flow, VS Code, Claude Code)". */
function lineOf(happened: string, facts: readonly (string | null)[]): string {
  const known = facts.filter((fact): fact is string => fact !== null && fact !== "");
  return slackSafe(known.length === 0 ? happened : `${happened} (${known.join(", ")})`);
}

/**
 * The post for a wait that has lasted the delay and is still open. What the
 * session is asking follows the reason, as in the notification of a wait:
 * "checkout-flow is waiting for permission: Run: npm test (4m 12s, ...)".
 */
export function waitPost(facts: WaitFacts): WebhookEventPost {
  const { begunAt, now } = facts;
  // The channel has cleaned and cut it already, by the rule the dashboard's
  // line is made by. It is put through that rule again, which leaves it as it
  // was, so no line break handed in can reach `text`.
  const asking = waitingText(facts.asking);
  const session = sessionOf(facts.session, facts.agent);
  const waitedMs = Math.max(0, now - begunAt);
  const happened = `${session.name} ${waitingPhrase(facts.session)}`;
  return {
    // In `text` it is made safe for Slack with the rest.
    text: lineOf(asking ? `${happened}: ${asking}` : happened, [
      formatDuration(waitedMs),
      session.folder,
      session.app,
      session.agent,
    ]),
    event: "needs-you",
    reason: facts.session.waitingReason ?? "other",
    // Left out, not null, when it does not go, so a post without it is the post it always was.
    ...(asking ? { asking } : {}),
    session,
    at: new Date(begunAt).toISOString(),
    waitedSeconds: Math.floor(waitedMs / 1_000),
  };
}

/**
 * The post that reminds of a long wait: the post of a wait, with the line
 * "checkout-flow has waited 10 minutes for permission (/work/checkout-flow,
 * ...)" and `reminder: true`, and on a repeat, `repeat`. The line says how
 * long already, so the bracket does not say it again; `waitedSeconds` has it
 * to the second.
 */
export function reminderPost(facts: ReminderFacts): WebhookEventPost {
  const post = waitPost(facts);
  const asking = waitingText(facts.asking);
  const said = reminderSentence(facts.session, facts.now - facts.begunAt);
  return {
    ...post,
    text: lineOf(asking ? `${said}: ${asking}` : said, [
      post.session.folder,
      post.session.app,
      post.session.agent,
    ]),
    reminder: true,
    // Left out on the first, so its post is the post it always was.
    ...(facts.repeat > 0 && { repeat: facts.repeat }),
  };
}

/**
 * The post that sums up quiet hours: "While quiet: checkout-flow waited 25
 * minutes and billing-webhooks finished".
 */
export function summaryPost(facts: SummaryFacts): WebhookSummaryPost {
  const items = facts.items.slice(0, MAX_SUMMARY_ITEMS).map((item): WebhookSummaryItem => ({
    event: item.event,
    session: sessionOf(item.session, item.agent),
    at: new Date(item.at).toISOString(),
    ...(item.event === "needs-you" && {
      waitedSeconds: Math.floor(item.waitedMs / 1_000),
      times: item.times,
      ...(item.then && {
        then: { event: item.then.event, at: new Date(item.then.at).toISOString() },
      }),
    }),
  }));
  const more = facts.items.length - items.length;
  return {
    text: slackSafe(`${WHILE_QUIET}: ${summaryLine(facts.items)}`),
    event: "quiet-summary",
    from: new Date(facts.from).toISOString(),
    to: new Date(facts.to).toISOString(),
    items,
    ...(more > 0 && { more }),
  };
}

/** The post for a session that finished, failed or ended: "billing-webhooks finished (...)". */
export function overPost(facts: OverFacts): WebhookEventPost {
  const session = sessionOf(facts.session, facts.agent);
  return {
    text: lineOf(`${session.name} ${overPhrase(facts.event)}`, [
      session.folder,
      session.app,
      session.agent,
    ]),
    event: facts.event,
    session,
    at: new Date(facts.seenAt).toISOString(),
  };
}
