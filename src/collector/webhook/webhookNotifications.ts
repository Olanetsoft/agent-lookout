import type { WebhookStatusResponse } from "../../core/api.ts";
import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { createOutboundChannel } from "../outbound/outboundChannel.ts";
import {
  overPost,
  reminderPost,
  summaryPost,
  waitPost,
  type WebhookPost,
} from "./webhookMessage.ts";
import type { WebhookSender } from "./webhookSender.ts";
import type { WebhookSettings } from "./webhookSettings.ts";

/**
 * Webhook notifications: one short JSON post for each of the events the
 * person chose, to the one address they set. The collector builds this only
 * when that address has been set in the environment.
 *
 * What is posted and when follows the rules in `outboundChannel.ts`, the ones
 * email follows: nothing for what was already true when the collector
 * started, a wait once it has lasted the delay, a session that finished,
 * failed or ended at once, at most 20 an hour, counted apart from emails, and
 * the time rules: a reminder of a long wait, and nothing during quiet hours
 * but one summary when they end. This file says only what a post is and how
 * it goes.
 *
 * The browser notifications' switch in Settings does not cover this. The
 * webhook is turned off by starting the collector without its address.
 */
export interface WebhookNotifications {
  /** Takes each snapshot the poller produces, and posts what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** What `GET /api/webhook` answers. */
  status(): WebhookStatusResponse;
  /** Resolves once every post handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export interface WebhookNotificationsOptions {
  settings: WebhookSettings;
  sender: WebhookSender;
  now?: () => number;
}

/** What `GET /api/webhook` answers while the webhook is off. */
export function webhookOffStatus(problem: string | null): WebhookStatusResponse {
  return {
    on: false,
    host: null,
    events: null,
    afterMs: null,
    asking: null,
    problem,
    last: null,
    limitedUntil: null,
  };
}

export function createWebhookNotifications(
  options: WebhookNotificationsOptions,
): WebhookNotifications {
  const { settings, sender } = options;
  const channel = createOutboundChannel<WebhookPost>({
    events: settings.events,
    afterMs: settings.afterMs,
    asking: settings.asking,
    waitMessage: waitPost,
    overMessage: overPost,
    reminderMessage: reminderPost,
    summaryMessage: summaryPost,
    send: (post) => sender.send(post),
    failure: "the post could not be sent",
    now: options.now,
  });

  return {
    handle: (snapshot) => channel.handle(snapshot),

    status() {
      return {
        on: true,
        // The host alone. The path holds the token that lets anyone post.
        host: settings.url.hostname,
        events: [...settings.events],
        afterMs: settings.afterMs,
        asking: settings.asking,
        problem: null,
        last: channel.last(),
        limitedUntil: channel.limitedUntil(),
      };
    },

    settled: () => channel.settled(),
  };
}
