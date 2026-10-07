import {
  createJsonPoster,
  outcomeOfPost,
  type JsonPosterOptions,
  type PostWords,
} from "../outbound/httpPost.ts";
import type { SendOutcome } from "../outbound/outboundChannel.ts";
import type { PhoneMessage } from "../outbound/phoneMessage.ts";
import { pushoverBody } from "./pushoverMessage.ts";
import type { PushoverSettings } from "./pushoverSettings.ts";

/**
 * The one seam between the collector and Pushover. `send` never rejects:
 * whatever goes wrong comes back as an outcome. Tests pass one aimed at a
 * server of their own on 127.0.0.1.
 */
export interface PushoverSender {
  send(message: PhoneMessage): Promise<SendOutcome>;
}

export type CreatePushoverSender = (settings: PushoverSettings) => PushoverSender;

/** Where every push goes: Pushover's messages API. No setting changes it. */
export const PUSHOVER_ENDPOINT = "https://api.pushover.net/1/messages.json";

/**
 * What Pushover's outcomes say. None holds the token, the key or what
 * Pushover answered, which can name them: its reasons are chosen from the
 * status alone.
 */
export const PUSHOVER_WORDS: PostWords = {
  where: "Pushover",
  whose: "Pushover's",
  notSent: "the push could not be sent",
  refused(status) {
    if (status === 400) {
      return `Pushover refused the push: check the application's token and the user key (status ${status})`;
    }
    if (status === 429)
      return `Pushover's monthly limit for the application was reached (status ${status})`;
    return `Pushover refused the push (status ${status})`;
  },
  troubled: (status) => `Pushover had a problem (status ${status})`,
};

/**
 * Posts each push to Pushover as JSON, by `createJsonPoster` in
 * `outbound/httpPost.ts`: once, on a connection of its own, with the
 * certificate always checked, no redirect followed and nothing tried again. A
 * 2xx is sent. The answer is read and dropped.
 *
 * `endpoint` is for tests alone, which aim it at a server of their own on
 * 127.0.0.1. Nothing a person sets reaches it.
 */
export function createPushoverSender(
  settings: PushoverSettings,
  options: Omit<JsonPosterOptions, "headers"> & { endpoint?: URL },
): PushoverSender {
  const poster = createJsonPoster(options.endpoint ?? new URL(PUSHOVER_ENDPOINT), options);
  return {
    async send(message) {
      let body: string;
      try {
        body = JSON.stringify(pushoverBody(settings.token, settings.user, message));
      } catch {
        return { sent: false, reason: PUSHOVER_WORDS.notSent };
      }
      return outcomeOfPost(await poster.post(body), PUSHOVER_WORDS);
    },
  };
}
