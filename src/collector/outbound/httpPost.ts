// Type-only imports, which are gone before the code runs. Node's client itself
// is loaded by `createJsonPoster` on the first post, so only once a channel
// that posts has been set up.
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";

import type { SendOutcome } from "./outboundChannel.ts";

/**
 * One JSON post to one address, the way the webhook, ntfy and Pushover each
 * send: with Node's own `https.request`, or `http.request` for an address on
 * this computer, on a connection of its own that is closed after the answer.
 * The certificate is always checked, even when `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * is in the environment, which would otherwise turn the check off for the
 * whole process. No redirect is followed, no cookie is kept and nothing is
 * tried again. The answer's body is read and dropped.
 *
 * What comes back says what happened in the plainest terms: the status, the
 * time running out, or the error's code. Never the error's message, which can
 * repeat the address, so no sentence made from it can hold a secret. Each
 * channel turns it into its own words with `outcomeOfPost`.
 */

/**
 * How long one post may take in all, from connecting to the answer's status.
 * An address that does not answer costs one post this long, and never holds
 * up a poll.
 */
export const POST_TIMEOUT_MS = 10_000;

/**
 * status   the address answered, with this status
 * timeout  it had not answered within its time, and the connection was closed
 * error    the connection failed, with the error's code, or null when it has none
 * unsent   the request could not be made at all
 */
export type PostResult =
  | { kind: "status"; status: number }
  | { kind: "timeout" }
  | { kind: "error"; code: string | null }
  | { kind: "unsent" };

/**
 * The headers of every post, besides the `Host` and `Connection: close` Node
 * adds itself, and those of the channel's own after them, such as ntfy's
 * `Authorization`.
 */
export function jsonHeaders(
  body: string,
  version: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "User-Agent": `Agent Lookout/${version}`,
    ...extra,
  };
}

/** What each request is made with, besides the address. */
export function postOptions(
  body: string,
  version: string,
  extra: Readonly<Record<string, string>> = {},
): RequestOptions {
  return {
    method: "POST",
    headers: jsonHeaders(body, version, extra),
    // A connection of its own, closed after the answer.
    agent: false,
    rejectUnauthorized: true,
  };
}

/** The part of Node's `http` and `https` modules this file uses. */
type Request = (url: URL, options: RequestOptions) => ClientRequest;

export interface JsonPoster {
  /** Posts the body, once. It never rejects. */
  post(body: string): Promise<PostResult>;
}

export interface JsonPosterOptions {
  version: string;
  timeoutMs?: number;
  /** Headers of the channel's own, sent after the others. */
  headers?: Readonly<Record<string, string>>;
}

/** Posts to `url`, once for each body, with a new connection each time. */
export function createJsonPoster(url: URL, options: JsonPosterOptions): JsonPoster {
  const timeoutMs = options.timeoutMs ?? POST_TIMEOUT_MS;
  const extra = options.headers ?? {};
  let client: Promise<Request> | null = null;
  const load = (): Promise<Request> => {
    client ??=
      url.protocol === "https:"
        ? import("node:https").then(({ request }) => request)
        : import("node:http").then(({ request }) => request);
    return client;
  };

  return {
    async post(body) {
      let request: Request;
      try {
        request = await load();
      } catch {
        return { kind: "unsent" };
      }
      return new Promise<PostResult>((resolve) => {
        let finished = false;
        const finish = (result: PostResult) => {
          if (finished) return;
          finished = true;
          resolve(result);
        };

        let req: ClientRequest;
        try {
          req = request(url, postOptions(body, options.version, extra));
        } catch {
          finish({ kind: "unsent" });
          return;
        }
        const timer = setTimeout(() => {
          finish({ kind: "timeout" });
          req.destroy();
        }, timeoutMs);
        timer.unref();

        req.on("response", (res) => {
          finish({ kind: "status", status: res.statusCode ?? 0 });
          // The answer's body says nothing that is kept. It is read and dropped,
          // and the time limit still closes a connection that never ends it.
          res.on("close", () => clearTimeout(timer));
          res.resume();
        });
        req.on("error", (error) => {
          clearTimeout(timer);
          const { code } = (error ?? {}) as { code?: unknown };
          finish({ kind: "error", code: typeof code === "string" ? code : null });
        });
        req.end(body);
      });
    },
  };
}

/** The words one channel says what became of a post in. */
export interface PostWords {
  /** What it was sent to, as the subject of a sentence: "the address", "the ntfy server". */
  where: string;
  /** The same, as an owner: "the address's". */
  whose: string;
  /** When nothing could be sent at all: "the post could not be sent". */
  notSent: string;
  /** For a 4xx: "the address refused the post (status 403)". */
  refused(status: number): string;
  /** For a 5xx: "the receiving service had a problem (status 500)". */
  troubled(status: number): string;
}

/**
 * Why a connection failed, from the error's code alone: it never repeats the
 * error's message, which can hold the address.
 */
export function connectionReason(code: string | null, words: PostWords): string {
  if (code === null) return words.notSent;
  if (code === "ECONNREFUSED") return `nothing answered at ${words.where}`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `${words.whose} host could not be found`;
  if (code === "ETIMEDOUT") return `${words.where} did not answer in time`;
  if (/CERT|SELF_SIGNED|UNABLE_TO|^ERR_TLS|^ERR_SSL|^EPROTO$/.test(code)) {
    return `the secure connection to ${words.where} failed`;
  }
  return `the connection to ${words.where} failed`;
}

/**
 * How a post went, in the channel's words. Only a 2xx is sent. A redirect is
 * not followed: the address set is the only one posted to.
 */
export function outcomeOfPost(result: PostResult, words: PostWords): SendOutcome {
  switch (result.kind) {
    case "unsent":
      return { sent: false, reason: words.notSent };
    case "timeout":
      return { sent: false, reason: `${words.where} did not answer in time` };
    case "error":
      return { sent: false, reason: connectionReason(result.code, words) };
    case "status": {
      const { status } = result;
      if (status >= 200 && status < 300) return { sent: true };
      if (status >= 300 && status < 400) {
        return {
          sent: false,
          reason: `${words.where} answered with a redirect, which is not followed`,
        };
      }
      if (status >= 400 && status < 500) return { sent: false, reason: words.refused(status) };
      if (status >= 500 && status < 600) return { sent: false, reason: words.troubled(status) };
      return { sent: false, reason: `${words.whose} answer could not be understood` };
    }
  }
}
