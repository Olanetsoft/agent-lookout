import {
  createJsonPoster,
  outcomeOfPost,
  type JsonPosterOptions,
  type PostWords,
} from "../outbound/httpPost.ts";
import type { SendOutcome } from "../outbound/outboundChannel.ts";
import type { PhoneMessage } from "../outbound/phoneMessage.ts";
import { ntfyBody } from "./ntfyMessage.ts";
import type { NtfySettings } from "./ntfySettings.ts";

/**
 * The one seam between the collector and ntfy. `send` never rejects: whatever
 * goes wrong comes back as an outcome. Tests pass one aimed at a server of
 * their own on 127.0.0.1.
 */
export interface NtfySender {
  send(message: PhoneMessage): Promise<SendOutcome>;
}

export type CreateNtfySender = (settings: NtfySettings) => NtfySender;

/** What ntfy's outcomes say. None holds the topic, the token or what the server answered. */
export const NTFY_WORDS: PostWords = {
  where: "the ntfy server",
  whose: "the ntfy server's",
  notSent: "the push could not be sent",
  refused(status) {
    if (status === 401 || status === 403) {
      return `the ntfy server refused the access token or the topic (status ${status})`;
    }
    if (status === 413) return `the ntfy server refused the push as too large (status ${status})`;
    if (status === 429) return `the ntfy server's rate limit was reached (status ${status})`;
    return `the ntfy server refused the push (status ${status})`;
  },
  troubled: (status) => `the ntfy server had a problem (status ${status})`,
};

/**
 * The headers ntfy is sent besides the JSON ones: the access token, when one
 * is set, and nothing else. It goes in a header, never in the address, so no
 * log of an address can keep it.
 */
export function ntfyHeaders(settings: Pick<NtfySettings, "token">): Record<string, string> {
  return settings.token === null ? {} : { Authorization: `Bearer ${settings.token}` };
}

/**
 * Posts each push to the ntfy server as JSON, with the topic in it, by
 * `createJsonPoster` in `outbound/httpPost.ts`: once, on a connection of its
 * own, with the certificate always checked, no redirect followed and nothing
 * tried again. A 2xx is sent. The answer, which repeats the push, is read and
 * dropped.
 */
export function createNtfySender(
  settings: NtfySettings,
  options: Omit<JsonPosterOptions, "headers">,
): NtfySender {
  const poster = createJsonPoster(settings.server, { ...options, headers: ntfyHeaders(settings) });
  return {
    async send(message) {
      let body: string;
      try {
        body = JSON.stringify(ntfyBody(settings.topic, message));
      } catch {
        return { sent: false, reason: NTFY_WORDS.notSent };
      }
      return outcomeOfPost(await poster.post(body), NTFY_WORDS);
    },
  };
}
