import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ACTION_HEADER,
  NOTIFICATIONS_HEADER,
  readNotificationsHeader,
  type EmailStatusResponse,
  type ErrorResponse,
  type EventsResponse,
  type HealthResponse,
  type HistoryKept,
  type HistoryResponse,
  type HistoryRestart,
  type HistorySince,
  type NotificationsSaid,
  type WaitsResponse,
  type WebhookStatusResponse,
} from "../core/api.ts";
import { DEFAULT_HISTORY_WINDOW_MS } from "../core/history.ts";
import type { SessionsSnapshot } from "../core/sessions/session.ts";
import { emailOffStatus } from "./email/emailNotifications.ts";
import type { EventStore } from "./eventStore.ts";
import { memoryOnlyStatus } from "./history/historyLimits.ts";
import { HISTORY_CAPACITY, type HistoryStore } from "./historyStore.ts";
import type { ServerNotifications } from "./notifications/serverNotifications.ts";
import { POLL_INTERVAL_MS, type Poller } from "./poller.ts";
import { webhookOffStatus } from "./webhook/webhookNotifications.ts";

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

/** Where the collector's two routes that do something are. Every other route only reads. */
export const JUMP_PATH = "/api/jump";
export const CLEAR_HISTORY_PATH = "/api/history/clear";

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
   * What `GET /api/webhook` answers: whether a webhook is set up, its host and
   * never the rest of its address, the delay and how the last post went. Left
   * out, it answers that the webhook is off.
   */
  webhook?: () => WebhookStatusResponse;
  /**
   * Answers `POST /api/jump`, with checks of its own on top of the ones every
   * request passes: `createJumpRoute` in `jumpRoute.ts`. Left out, there is no
   * such route.
   */
  jump?: (req: IncomingMessage) => Promise<ApiAnswer>;
  /**
   * Answers `POST /api/history/clear`, with the same checks of its own as the
   * jump route: `createClearHistoryRoute` in `history/clearRoute.ts`. Left
   * out, there is no such route.
   */
  clearHistory?: (req: IncomingMessage) => Promise<ApiAnswer>;
  /**
   * Where the history held begins, where it is kept and the restarts in it,
   * for `/api/history`. Left out, it is kept in memory only and begins when
   * the poller started.
   */
  historyKept?: () => {
    since: HistorySince | null;
    kept: HistoryKept;
    restarts?: HistoryRestart[];
  };
  /**
   * What `GET /api/waits` answers: how long sessions waited on the person
   * today and over the last seven days, from the whole of the history kept.
   * Left out, there is no such route.
   */
  waits?: () => WaitsResponse;
  /**
   * While the history kept on disk is being read back, as the collector
   * starts: what to wait for before answering, so no page is told of an empty
   * history that is about to fill. Null once it has been read.
   */
  ready?: () => Promise<unknown> | null;
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

/** A header that was sent once. Node joins repeats of most headers with a comma. */
function header(req: Pick<IncomingMessage, "headers">, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/**
 * An answer that turns away a request to a route that acts. Its body may not
 * have been read, so its connection is not used again.
 */
export function refusal(
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ApiAnswer {
  return {
    status,
    body: { error } satisfies ErrorResponse,
    headers: { Connection: "close", ...headers },
  };
}

/**
 * Why a request to a route that acts is refused before its body is read, or
 * null when it may proceed. The collector's two such routes,
 * `POST /api/jump` and `POST /api/history/clear`, and the Mac app's routes for
 * its updates, in `src/desktop/updates/updateRoute.ts`, make these checks on
 * top of the ones every request has already passed in `refusalFor`, so each is
 * a request only the dashboard's own page can send:
 *
 * - A POST, so that no link, image or address typed into a browser sends it.
 * - With an `Origin` that is a page served from this machine. A browser puts
 *   `Origin` on every POST a page makes, so a request without one did not come
 *   from a page, and here that is refused, where a GET may go without.
 * - Marked `same-origin` by a browser that marks its requests at all.
 * - Carrying `X-Agent-Lookout-Action` with the route's own action, such as
 *   `jump`, and a JSON content type. A page at another origin may send neither without asking
 *   first, with a preflight. A preflight is an OPTIONS request. One from
 *   another site never gets this far, and one that does is refused here like
 *   any other method. No answer to either has a CORS header.
 * - No larger than `maxBodyBytes`.
 */
export function actionRefusalFor(
  req: Pick<IncomingMessage, "method" | "headers">,
  action: string,
  maxBodyBytes: number,
): ApiAnswer | null {
  if (req.method !== "POST") {
    return refusal(405, "This address only answers POST requests.", { Allow: "POST" });
  }

  const origin = header(req, "origin");
  if (origin === undefined || !isLoopbackOrigin(origin)) {
    return refusal(403, "This address only acts for the dashboard page served from this machine.");
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return refusal(403, "This address only acts for the dashboard page served from this machine.");
  }
  if (header(req, ACTION_HEADER) !== action) {
    return refusal(
      403,
      `A request to this address must carry the header ${ACTION_HEADER}: ${action}.`,
    );
  }

  const contentType = header(req, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return refusal(415, "The body must be JSON, sent as application/json.");
  }

  const length = header(req, "content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
    return refusal(413, `The body must be no more than ${maxBodyBytes} bytes.`);
  }
  return null;
}

/** A request's body as text, or why it could not be read. */
export type RequestBody = { ok: true; text: string } | { ok: false; tooLarge: boolean };

/** Reads a request's body, and stops as soon as it is larger than the limit. */
export function readRequestBody(req: IncomingMessage, limit: number): Promise<RequestBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (body: RequestBody) => {
      if (done) return;
      done = true;
      resolve(body);
    };
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      received += chunk.byteLength;
      if (received > limit) finish({ ok: false, tooLarge: true });
      else chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => finish({ ok: false, tooLarge: false }));
    req.on("close", () => finish({ ok: false, tooLarge: false }));
  });
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
  const { version, poller, events, history, notifications, email, webhook, jump } = options;
  const now = options.now ?? Date.now;
  /** The routes that act, by path. Each makes its own checks, method included. */
  const actions = new Map<string, (req: IncomingMessage) => Promise<ApiAnswer>>();
  if (jump) actions.set(JUMP_PATH, jump);
  if (options.clearHistory) actions.set(CLEAR_HISTORY_PATH, options.clearHistory);

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

    // The routes that are not a GET. Each makes its own checks, method
    // included, after the ones above, which every request has passed by now.
    const action = url === null ? undefined : actions.get(url.pathname);
    if (action) {
      action(req)
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
      case "/api/webhook": {
        send(
          res,
          200,
          (webhook ? webhook() : webhookOffStatus(null)) satisfies WebhookStatusResponse,
        );
        return;
      }
      case "/api/history": {
        const requested = numberParam(url.searchParams.get("windowMs"));
        if (requested === "invalid" || requested === 0) {
          fail(res, 400, "windowMs must be a length of time in milliseconds, for example 900000.");
          return;
        }
        const windowMs = Math.min(requested ?? DEFAULT_HISTORY_WINDOW_MS, MAX_HISTORY_WINDOW_MS);
        const held = options.historyKept?.();
        const since = held?.since ?? { at: poller.startedAt, by: "started" as const };
        send(res, 200, {
          points: history.list(windowMs, now()),
          startedAt: poller.startedAt,
          since,
          kept: held?.kept ?? memoryOnlyStatus(),
          // A restart before where the history now begins was cleared, or let go.
          restarts: (held?.restarts ?? []).filter((restart) => restart.at > since.at),
        } satisfies HistoryResponse);
        return;
      }
      case "/api/waits": {
        if (options.waits) {
          send(res, 200, options.waits() satisfies WaitsResponse);
          return;
        }
        fail(res, 404, "There is nothing at that address.");
        return;
      }
      default: {
        fail(res, 404, "There is nothing at that address.");
      }
    }
  }

  function answer(req: IncomingMessage, res: ServerResponse): void {
    try {
      route(req, res);
    } catch {
      if (res.headersSent) res.end();
      else fail(res, 500, "The collector ran into an unexpected problem.");
    }
  }

  return (req, res) => {
    const reading = options.ready?.() ?? null;
    if (reading === null) {
      answer(req, res);
      return;
    }
    // Read back in well under a second, and never rejected: the collector
    // gives up on the files itself if they take too long.
    void reading.then(
      () => answer(req, res),
      () => answer(req, res),
    );
  };
}
