import type { EmailStatusResponse } from "../../core/api.ts";
import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { createOutboundChannel } from "../outbound/outboundChannel.ts";
import { overEmail, waitEmail } from "./emailMessage.ts";
import { maskAddress, type EmailSettings } from "./emailSettings.ts";
import type { EmailSender } from "./smtpSender.ts";

/**
 * Email notifications: one short email for each of the events the person
 * chose, through the mail server they named. The collector builds this only
 * when email has been set up in the environment.
 *
 * What is emailed and when follows the rules in `outboundChannel.ts`, which
 * the webhook follows too: nothing for what was already true when the
 * collector started, a wait once it has lasted the delay, a session that
 * finished, failed or ended at once, and at most 20 an hour. This file says
 * only what an email is and how it goes.
 *
 * The browser notifications' switch in Settings does not cover this. Email is
 * turned off by starting the collector without its settings.
 */
export interface EmailNotifications {
  /** Takes each snapshot the poller produces, and sends what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** What `GET /api/email` answers. */
  status(): EmailStatusResponse;
  /** Resolves once every email handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export interface EmailNotificationsOptions {
  settings: EmailSettings;
  sender: EmailSender;
  now?: () => number;
}

/** What `GET /api/email` answers while email is off. */
export function emailOffStatus(problem: string | null): EmailStatusResponse {
  return {
    on: false,
    to: null,
    events: null,
    afterMs: null,
    asking: null,
    problem,
    last: null,
    limitedUntil: null,
  };
}

export function createEmailNotifications(options: EmailNotificationsOptions): EmailNotifications {
  const { settings, sender } = options;
  const channel = createOutboundChannel({
    events: settings.events,
    afterMs: settings.afterMs,
    asking: settings.asking,
    waitMessage: waitEmail,
    overMessage: overEmail,
    send: (content) => sender.send(content),
    failure: "the email could not be sent",
    now: options.now,
  });

  return {
    handle: (snapshot) => channel.handle(snapshot),

    status() {
      return {
        on: true,
        to: maskAddress(settings.to),
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
