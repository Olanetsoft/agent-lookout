import type { NtfyStatusResponse } from "../../core/api.ts";
import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { createOutboundChannel, type TestResult } from "../outbound/outboundChannel.ts";
import {
  overMessage,
  reminderMessage,
  summaryMessage,
  testMessage,
  waitMessage,
  type PhoneMessage,
} from "../outbound/phoneMessage.ts";
import type { NtfySender } from "./ntfySender.ts";
import type { NtfySettings } from "./ntfySettings.ts";

/**
 * Pushes through ntfy: one short push for each of the events the person
 * chose, to the one topic they set. The collector builds this only when that
 * topic's address has been set in the environment.
 *
 * What is pushed and when follows the rules in `outboundChannel.ts`, the ones
 * email and the webhook follow: nothing for what was already true when the
 * collector started, a wait once it has lasted the delay, a session that
 * finished, failed or ended at once, at most 20 an hour, counted apart from
 * the others, and the time rules: a reminder of a long wait and its repeats,
 * and nothing during quiet hours but one summary when they end. This file
 * says only what a push is and how it goes.
 *
 * The browser notifications' switch in Settings does not cover this. ntfy is
 * turned off by starting the collector without its address.
 */
export interface NtfyNotifications {
  /** Takes each snapshot the poller produces, and pushes what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** What `GET /api/ntfy` answers. */
  status(): NtfyStatusResponse;
  /** Sends the test push, for Send a test in Settings. */
  test(): Promise<TestResult>;
  /** Resolves once every push handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export interface NtfyNotificationsOptions {
  settings: NtfySettings;
  sender: NtfySender;
  now?: () => number;
}

/** What `GET /api/ntfy` answers while ntfy is off. */
export function ntfyOffStatus(problem: string | null): NtfyStatusResponse {
  return {
    on: false,
    host: null,
    tokenSet: null,
    events: null,
    afterMs: null,
    asking: null,
    problem,
    last: null,
    limitedUntil: null,
  };
}

export function createNtfyNotifications(options: NtfyNotificationsOptions): NtfyNotifications {
  const { settings, sender } = options;
  const channel = createOutboundChannel<PhoneMessage>({
    events: settings.events,
    afterMs: settings.afterMs,
    asking: settings.asking,
    waitMessage,
    overMessage,
    reminderMessage,
    summaryMessage,
    send: (message) => sender.send(message),
    failure: "the push could not be sent",
    now: options.now,
  });

  return {
    handle: (snapshot) => channel.handle(snapshot),

    status() {
      return {
        on: true,
        // The host alone. The topic is the secret anyone could read the pushes with.
        host: settings.server.hostname,
        tokenSet: settings.token !== null,
        events: [...settings.events],
        afterMs: settings.afterMs,
        asking: settings.asking,
        problem: null,
        last: channel.last(),
        limitedUntil: channel.limitedUntil(),
      };
    },

    test: () => channel.test(testMessage()),

    settled: () => channel.settled(),
  };
}
