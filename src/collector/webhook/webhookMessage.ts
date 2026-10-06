import { formatDuration } from "../../core/duration.ts";
import { surfaceLabel, type Session, type WaitingReason } from "../../core/sessions/session.ts";
import type { NoticeEvent } from "../../core/notices/sessionChanges.ts";
import { overPhrase, sessionTitle, waitingPhrase } from "../../core/notices/waiting.ts";
import { oneLine } from "../../core/text.ts";
import type { OverFacts, WaitFacts } from "../outbound/outboundChannel.ts";

/**
 * What one post to the webhook holds, as JSON. `text` is one line for a
 * person, which is what Slack shows, so a Slack incoming webhook takes the
 * post as it is. The rest says the same for a program: the event, the reason
 * for a wait, the session's name, agent, project folder and app, when it
 * happened, and how long a wait had lasted when it was posted.
 *
 * Nothing else goes in it: no path, no prompt, none of the agent's own words.
 */
export interface WebhookPost {
  text: string;
  event: NoticeEvent;
  /** Why the session waits. A wait only. */
  reason?: WaitingReason;
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
}

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

/** The post for a wait that has lasted the delay and is still open. */
export function waitPost(facts: WaitFacts): WebhookPost {
  const { begunAt, now } = facts;
  const session = sessionOf(facts.session, facts.agent);
  const waitedMs = Math.max(0, now - begunAt);
  return {
    text: lineOf(`${session.name} ${waitingPhrase(facts.session)}`, [
      formatDuration(waitedMs),
      session.folder,
      session.app,
      session.agent,
    ]),
    event: "needs-you",
    reason: facts.session.waitingReason ?? "other",
    session,
    at: new Date(begunAt).toISOString(),
    waitedSeconds: Math.floor(waitedMs / 1_000),
  };
}

/** The post for a session that finished, failed or ended: "billing-webhooks finished (...)". */
export function overPost(facts: OverFacts): WebhookPost {
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
