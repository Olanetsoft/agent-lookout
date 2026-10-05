import type { IncomingMessage, ServerResponse } from "node:http";

import {
  NOTIFICATIONS_HEADER,
  readNotificationsHeader,
  type EmailStatusResponse,
  type ErrorResponse,
  type EventsResponse,
  type HealthResponse,
  type HistoryResponse,
  type NotificationsSaid,
} from "../core/api.ts";
import { DEFAULT_HISTORY_WINDOW_MS } from "../core/history.ts";
import type { SessionsSnapshot } from "../core/sessions/session.ts";
import { emailOffStatus } from "./email/emailNotifications.ts";
import type { EventStore } from "./eventStore.ts";
import { HISTORY_CAPACITY, type HistoryStore } from "./historyStore.ts";
import type { ServerNotifications } from "./notifications/serverNotifications.ts";
import { POLL_INTERVAL_MS, type Poller } from "./poller.ts";

/**
 * Answers `/api/*`. The signature is Node's own, so the Vite dev server, the
 * standalone host and a later desktop host can all mount the same function.
 */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** An answer a route worked out for the handler to send. */
export interface ApiAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Where the one route that does something is. Every other route only reads. */
export const JUMP_PATH = "/api/jump";

export interface ApiHandlerOptions {
  version: string;
  poller: Pick<Poller, "getSnapshot" | "startedAt">;
  events: EventStore;
  history: HistoryStore;
  /**
   * Told what each dashboard page says about its notifications, in the header
   * on its requests. Left out, the header is ignored.
   */
  notifications?: Pick<ServerNotifications, "pageSaid">;
  /**
   * What `GET /api/email` answers: whether email is set up, the masked address,
   * the delay and how the last email went. Left out, it answers that email is off.
   */
  email?: () => EmailStatusResponse;
  /**
   * Answers `POST /api/jump`, with checks of its own on top of the ones every
   * request passes: `createJumpRoute` in `jumpRoute.ts`. Left out, there is no
   * such route.
   */
  jump?: (req: IncomingMessage) => Promise<ApiAnswer>;
  now?: () => number;
}

/** The longest history window served: everything the buffer can hold. */
export const MAX_HISTORY_WINDOW_MS = HISTORY_CAPACITY * POLL_INTERVAL_MS;

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** Whether a `Host` header names this machine: localhost, 127.0.0.1 or [::1], any port. */
export function isLoopbackHostHeader(host: string | undefined): boolean {
  return typeof host === "string" && LOOPBACK_HOST.test(host);
}

/** Whether an `Origin` header is a page served from this machine. */
export function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN.test(origin);
}

/** Whether a request URL belongs to the API, so a host knows to hand it over. */
export function isApiPath(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Why a request is refused, or null when it may proceed.
 *
 * Session names and paths are private. The collector listens only on loopback,
 * but a browser on this machine can still be pointed at it by any website:
 *
 * - A page on another site can make the browser send a request here. Browsers
 *   label such requests with `Origin`, and with `Sec-Fetch-Site: cross-site`.
 * - With DNS rebinding, a hostile site's own name is made to resolve to
 *   127.0.0.1, which turns its requests into same-origin ones. The `Host`
 *   header then still carries that site's name.
 *
 * So the `Host` must be loopback, an `Origin` must be loopback when present,
 * and a request the browser calls cross-site is turned away.
 */
export function refusalFor(req: IncomingMessage): string | null {
  if (!isLoopbackHostHeader(req.headers.host)) {
    return "This address only answers requests made to localhost.";
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    return "This address only answers pages served from this machine.";
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    return "This address only answers pages served from this machine.";
  }
  return null;
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  // A host may have run its own middleware first. Vite's dev server does, and it
  // adds CORS headers that would let a page on another local port read the
  // answer. The API sends no CORS headers, whoever mounts it.
  for (const name of res.getHeaderNames()) {
    if (name.toLowerCase().startsWith("access-control-")) res.removeHeader(name);
  }

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    // Every answer is a reading of this moment and must never be reused.
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // Tells the browser not to hand this response to a page from anywhere else,
    // even for a request made without CORS. No CORS header is ever sent.
    "Cross-Origin-Resource-Policy": "same-origin",
    ...headers,
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, error: string, headers = {}): void {
  send(res, status, { error } satisfies ErrorResponse, headers);
}

/**
 * What a page said about its notifications, the events it shows them of, or
 * null when the request carries no such header or one that cannot be read.
 * Node gives header names in lower case.
 */
export function notificationsSaid(req: IncomingMessage): NotificationsSaid | null {
  const value = req.headers[NOTIFICATIONS_HEADER.toLowerCase()];
  if (typeof value !== "string") return null;
  return readNotificationsHeader(value);
}

/** Reads a query value that must be a plain non-negative number. */
function numberParam(value: string | null): number | undefined | "invalid" {
  if (value === null) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

export function createApiHandler(options: ApiHandlerOptions): ApiHandler {
  const { version, poller, events, history, notifications, email, jump } = options;
  const now = options.now ?? Date.now;

  function route(req: IncomingMessage, res: ServerResponse): void {
    const refusal = refusalFor(req);
    if (refusal) {
      fail(res, 403, refusal);
      return;
    }

    let url: URL | null;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      url = null;
    }

    // The one route that is not a GET. It makes its own checks, method included,
    // after the ones above, which every request has passed by now.
    if (jump && url?.pathname === JUMP_PATH) {
      jump(req)
        .then((answer) => send(res, answer.status, answer.body, answer.headers))
        .catch(() => {
          if (res.headersSent) res.end();
          else fail(res, 500, "The collector ran into an unexpected problem.");
        })
        .catch(() => {
          // The connection has gone, and there is nobody left to tell.
        });
      return;
    }

    if (req.method !== "GET") {
      fail(res, 405, "This address only answers GET requests.", { Allow: "GET" });
      return;
    }
    if (url === null) {
      fail(res, 400, "That address could not be read.");
      return;
    }

    // Only a request that passed every check above is listened to, so a page
    // at another address can no more steer the notifications than read a session.
    const said = notificationsSaid(req);
    if (said !== null) notifications?.pageSaid(said, url.pathname === "/api/sessions");

    switch (url.pathname) {
      case "/api/health": {
        send(res, 200, { ok: true, version } satisfies HealthResponse);
        return;
      }
      case "/api/sessions": {
        send(res, 200, poller.getSnapshot() satisfies SessionsSnapshot);
        return;
      }
      case "/api/events": {
        const since = numberParam(url.searchParams.get("since"));
        if (since === "invalid") {
          fail(res, 400, "since must be a time in milliseconds, for example 1700000000000.");
          return;
        }
        send(res, 200, { events: events.list({ since }) } satisfies EventsResponse);
        return;
      }
      case "/api/email": {
        send(res, 200, (email ? email() : emailOffStatus(null)) satisfies EmailStatusResponse);
        return;
      }
      case "/api/history": {
        const requested = numberParam(url.searchParams.get("windowMs"));
        if (requested === "invalid" || requested === 0) {
          fail(res, 400, "windowMs must be a length of time in milliseconds, for example 900000.");
          return;
        }
        const windowMs = Math.min(requested ?? DEFAULT_HISTORY_WINDOW_MS, MAX_HISTORY_WINDOW_MS);
        send(res, 200, {
          points: history.list(windowMs, now()),
          startedAt: poller.startedAt,
        } satisfies HistoryResponse);
        return;
      }
      default: {
        fail(res, 404, "There is nothing at that address.");
      }
    }
  }

  return (req, res) => {
    try {
      route(req, res);
    } catch {
      if (res.headersSent) res.end();
      else fail(res, 500, "The collector ran into an unexpected problem.");
    }
  };
}
