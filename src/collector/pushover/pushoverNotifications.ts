import type { PushoverStatusResponse } from "../../core/api.ts";
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
import type { PushoverSender } from "./pushoverSender.ts";
import type { PushoverSettings } from "./pushoverSettings.ts";

/**
 * Pushes through Pushover: one short push for each of the events the person
 * chose, to the one user or group key they set. The collector builds this
 * only when the application's token and that key have been set in the
 * environment.
 *
 * What is pushed and when follows the rules in `outboundChannel.ts`, the ones
 * every channel follows, with its own count of 20 an hour. The push says what
 * ntfy's says, from `phoneMessage.ts`. This file says only how it goes.
 *
 * The browser notifications' switch in Settings does not cover this. Pushover
 * is turned off by starting the collector without its token and key.
 */
export interface PushoverNotifications {
  /** Takes each snapshot the poller produces, and pushes what is due. */
  handle(snapshot: SessionsSnapshot): void;
  /** What `GET /api/pushover` answers. */
  status(): PushoverStatusResponse;
  /** Sends the test push, for Send a test in Settings. */
  test(): Promise<TestResult>;
  /** Resolves once every push handed over so far has been tried. For tests and for stopping. */
  settled(): Promise<void>;
}

export interface PushoverNotificationsOptions {
  settings: PushoverSettings;
  sender: PushoverSender;
  now?: () => number;
}

/** What `GET /api/pushover` answers while Pushover is off. */
export function pushoverOffStatus(problem: string | null): PushoverStatusResponse {
  return {
    on: false,
    events: null,
    afterMs: null,
    asking: null,
    problem,
    last: null,
    limitedUntil: null,
  };
}

export function createPushoverNotifications(
  options: PushoverNotificationsOptions,
): PushoverNotifications {
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
