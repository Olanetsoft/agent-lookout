import type { RequestOptions } from "node:https";

import {
  connectionReason,
  createJsonPoster,
  jsonHeaders,
  outcomeOfPost,
  POST_TIMEOUT_MS,
  postOptions,
  type PostWords,
} from "../outbound/httpPost.ts";
import type { SendOutcome } from "../outbound/outboundChannel.ts";
import type { WebhookPost } from "./webhookMessage.ts";
import type { WebhookSettings } from "./webhookSettings.ts";

/**
 * The one seam between the collector and the webhook. `send` never rejects:
 * whatever goes wrong comes back as an outcome. Tests pass one aimed at a
 * server of their own on 127.0.0.1.
 */
export interface WebhookSender {
  send(post: WebhookPost): Promise<SendOutcome>;
}

export type CreateWebhookSender = (settings: WebhookSettings) => WebhookSender;

/**
 * How long one post may take in all, from connecting to the answer's status.
 * An address that does not answer costs one post this long, and never holds
 * up a poll.
 */
export const WEBHOOK_TIMEOUT_MS = POST_TIMEOUT_MS;

/** The headers of every post, besides the `Host` and `Connection: close` Node adds itself. */
export function postHeaders(body: string, version: string): Record<string, string> {
  return jsonHeaders(body, version);
}

/** What the webhook's outcomes say. */
const WORDS: PostWords = {
  where: "the address",
  whose: "the address's",
  notSent: "the post could not be sent",
  refused: (status) => `the address refused the post (status ${status})`,
  troubled: (status) => `the receiving service had a problem (status ${status})`,
};

/**
 * How a post went, from the status of the answer. Only a 2xx is sent. A
 * redirect is not followed: the address set is the only one posted to.
 */
export function outcomeOfStatus(status: number): SendOutcome {
  return outcomeOfPost({ kind: "status", status }, WORDS);
}

/**
 * Why a post could not be made, in a few words the dashboard can show. It is
 * chosen from the error's code alone, and never repeats the error's message,
 * which can hold the address.
 */
export function failureReason(error: unknown): string {
  const { code } = (error ?? {}) as { code?: unknown };
  return connectionReason(typeof code === "string" ? code : null, WORDS);
}

/**
 * What each request is made with, besides the address. The certificate is
 * checked even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the environment,
 * which would otherwise turn the check off for the whole process.
 */
export function requestOptions(body: string, version: string): RequestOptions {
  return postOptions(body, version);
}

/**
 * Posts to the address in the settings, once for each notice, with a new
 * connection each time that is closed after it, by `createJsonPoster` in
 * `outbound/httpPost.ts`. Nothing is retried, no redirect is followed and no
 * cookie is kept. A certificate is always checked. A post that has had no
 * answer within its time counts as not sent, and its connection is closed.
 */
export function createHttpSender(
  settings: WebhookSettings,
  options: { version: string; timeoutMs?: number },
): WebhookSender {
  const poster = createJsonPoster(settings.url, options);
  return {
    async send(post) {
      let body: string;
      try {
        body = JSON.stringify(post);
      } catch {
        return { sent: false, reason: WORDS.notSent };
      }
      return outcomeOfPost(await poster.post(body), WORDS);
    },
  };
}
