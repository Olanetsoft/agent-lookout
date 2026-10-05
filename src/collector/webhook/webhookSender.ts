// Type-only imports, which are gone before the code runs. Node's client itself
// is loaded by `createHttpSender` on the first post, so only once an address
// has been set.
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";

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
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The headers of every post, besides the `Host` and `Connection: close` Node adds itself. */
export function postHeaders(body: string, version: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "User-Agent": `Agent Lookout/${version}`,
  };
}

const TIMED_OUT = "the address did not answer in time";

/**
 * How a post went, from the status of the answer. Only a 2xx is sent. A
 * redirect is not followed: the address set is the only one posted to.
 */
export function outcomeOfStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return { sent: true };
  if (status >= 300 && status < 400) {
    return { sent: false, reason: "the address answered with a redirect, which is not followed" };
  }
  if (status >= 400 && status < 500) {
    return { sent: false, reason: `the address refused the post (status ${status})` };
  }
  if (status >= 500 && status < 600) {
    return { sent: false, reason: `the receiving service had a problem (status ${status})` };
  }
  return { sent: false, reason: "the address's answer could not be understood" };
}

/**
 * Why a post could not be made, in a few words the dashboard can show. It is
 * chosen from the error's code alone, and never repeats the error's message,
 * which can hold the address.
 */
export function failureReason(error: unknown): string {
  const { code } = (error ?? {}) as { code?: unknown };
  if (typeof code !== "string") return "the post could not be sent";
  if (code === "ECONNREFUSED") return "nothing answered at the address";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the address's host could not be found";
  if (code === "ETIMEDOUT") return TIMED_OUT;
  if (/CERT|SELF_SIGNED|UNABLE_TO|^ERR_TLS|^ERR_SSL|^EPROTO$/.test(code)) {
    return "the secure connection to the address failed";
  }
  return "the connection to the address failed";
}

/**
 * What each request is made with, besides the address. The certificate is
 * checked even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is in the environment,
 * which would otherwise turn the check off for the whole process.
 */
export function requestOptions(body: string, version: string): RequestOptions {
  return {
    method: "POST",
    headers: postHeaders(body, version),
    // A connection of its own, closed after the answer.
    agent: false,
    rejectUnauthorized: true,
  };
}

/** The part of Node's `http` and `https` modules this file uses. */
type Request = (url: URL, options: RequestOptions) => ClientRequest;

/**
 * Posts to the address in the settings, once for each notice, with a new
 * connection each time that is closed after it. Nothing is retried, no
 * redirect is followed and no cookie is kept. A certificate is always checked.
 * A post that has had no answer within its time counts as not sent, and its
 * connection is closed.
 */
export function createHttpSender(
  settings: WebhookSettings,
  options: { version: string; timeoutMs?: number },
): WebhookSender {
  const { url } = settings;
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  let client: Promise<Request> | null = null;
  const load = (): Promise<Request> => {
    client ??=
      url.protocol === "https:"
        ? import("node:https").then(({ request }) => request)
        : import("node:http").then(({ request }) => request);
    return client;
  };

  return {
    async send(post) {
      let request: Request;
      try {
        request = await load();
      } catch {
        return { sent: false, reason: "the post could not be sent" };
      }
      return new Promise<SendOutcome>((resolve) => {
        let finished = false;
        const finish = (outcome: SendOutcome) => {
          if (finished) return;
          finished = true;
          resolve(outcome);
        };

        let body: string;
        let req: ClientRequest;
        try {
          body = JSON.stringify(post);
          req = request(url, requestOptions(body, options.version));
        } catch {
          finish({ sent: false, reason: "the post could not be sent" });
          return;
        }
        const timer = setTimeout(() => {
          finish({ sent: false, reason: TIMED_OUT });
          req.destroy();
        }, timeoutMs);
        timer.unref();

        req.on("response", (res) => {
          finish(outcomeOfStatus(res.statusCode ?? 0));
          // The answer's body says nothing that is kept. It is read and dropped,
          // and the time limit still closes a connection that never ends it.
          res.on("close", () => clearTimeout(timer));
          res.resume();
        });
        req.on("error", (error) => {
          clearTimeout(timer);
          finish({ sent: false, reason: failureReason(error) });
        });
        req.end(body);
      });
    },
  };
}
