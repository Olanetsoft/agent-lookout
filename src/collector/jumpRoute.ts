import type { IncomingMessage } from "node:http";

import {
  ACTION_HEADER,
  JUMP_INTERVAL_MS,
  type ErrorResponse,
  type JumpFailure,
  type JumpRefusal,
  type JumpResponse,
} from "../core/api.ts";
import { isLoopbackOrigin, type ApiAnswer } from "./handler.ts";
import type { Poller } from "./poller.ts";
import type { PaneFinder } from "./tmux/paneFinder.ts";
import type { RunTmux } from "./tmux/program.ts";
import { selectPane } from "./tmux/selectPane.ts";

/** The most a request's body may hold. A session id is far shorter. */
export const MAX_JUMP_BODY_BYTES = 1024;

/** What `ACTION_HEADER` says on a request to this route. */
const ACTION = "jump";

/** The longest session id that is looked up. */
const MAX_SESSION_ID_LENGTH = 300;

export interface JumpRouteOptions {
  /** The collector's own latest list of sessions. */
  poller: Pick<Poller, "getSnapshot">;
  /** The panes the collector found for its sessions' processes. */
  panes: Pick<PaneFinder, "paneOf" | "lookAgain">;
  run: RunTmux;
  now?: () => number;
}

const refuse = (
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ApiAnswer => ({
  status,
  body: { error } satisfies ErrorResponse,
  // A refused request's body may not have been read, so its connection is not used again.
  headers: { Connection: "close", ...headers },
});

const failed = (status: number, reason: JumpFailure, error: string, headers = {}): ApiAnswer => ({
  status,
  body: { error, reason } satisfies JumpRefusal,
  headers,
});

/** A header that was sent once. Node joins repeats of most headers with a comma. */
function header(req: Pick<IncomingMessage, "headers">, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/**
 * Why a request to the jump route is refused before its body is read, or null
 * when it may proceed.
 *
 * Every other route only reads. This one changes which tmux pane is selected,
 * so on top of the checks every request has already passed (`refusalFor` in
 * `handler.ts`) it must be one only the dashboard's own page can send:
 *
 * - A POST, so that no link, image or address typed into a browser sends it.
 * - With an `Origin` that is a page served from this machine. A browser puts
 *   `Origin` on every POST a page makes, so a request without one did not come
 *   from a page, and here that is refused, where a GET may go without.
 * - Marked `same-origin` by a browser that marks its requests at all.
 * - Carrying `X-Agent-Lookout-Action: jump` and a JSON content type. A page at
 *   another origin may send neither without asking first, with a preflight.
 *   A preflight is an OPTIONS request. One from another site never gets this
 *   far, and one that does is refused here like any other method. No answer
 *   to either has a CORS header.
 * - Small.
 */
export function jumpRefusalFor(req: Pick<IncomingMessage, "method" | "headers">): ApiAnswer | null {
  if (req.method !== "POST") {
    return refuse(405, "This address only answers POST requests.", { Allow: "POST" });
  }

  const origin = header(req, "origin");
  if (origin === undefined || !isLoopbackOrigin(origin)) {
    return refuse(403, "This address only acts for the dashboard page served from this machine.");
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") {
    return refuse(403, "This address only acts for the dashboard page served from this machine.");
  }
  if (header(req, ACTION_HEADER) !== ACTION) {
    return refuse(
      403,
      `A request to this address must carry the header ${ACTION_HEADER}: ${ACTION}.`,
    );
  }

  const contentType = header(req, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return refuse(415, "The body must be JSON, sent as application/json.");
  }

  const length = header(req, "content-length");
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JUMP_BODY_BYTES)) {
    return refuse(413, `The body must be no more than ${MAX_JUMP_BODY_BYTES} bytes.`);
  }
  return null;
}

/**
 * The session id a body names, or null when the body is anything but a JSON
 * object with the one field `sessionId`, a string. A body that says more is not
 * read for the part that fits.
 */
export function sessionIdIn(body: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "sessionId") return null;
  const { sessionId } = value as { sessionId: unknown };
  if (typeof sessionId !== "string" || sessionId === "") return null;
  return sessionId.length <= MAX_SESSION_ID_LENGTH ? sessionId : null;
}

type Body = { ok: true; text: string } | { ok: false; tooLarge: boolean };

/** Reads a request's body, and stops as soon as it is larger than the limit. */
function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (body: Body) => {
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

/**
 * Answers `POST /api/jump`: selects the tmux pane a session runs in.
 *
 * The request names a session and nothing else. The session is looked up in
 * the collector's own list, and the pane is the one the collector found for
 * that session's process when it last asked tmux. So nothing a request holds
 * reaches a command: not a pane, not a name, not an argument. The most a
 * request can do is choose which of the panes already found is selected.
 *
 * One jump is made a second, and one at a time.
 */
export function createJumpRoute(options: JumpRouteOptions) {
  const { poller, panes, run } = options;
  const now = options.now ?? Date.now;

  let lastAt: number | null = null;
  let underWay = false;

  return async function answerJump(req: IncomingMessage): Promise<ApiAnswer> {
    const refusal = jumpRefusalFor(req);
    if (refusal) {
      req.resume();
      return refusal;
    }

    const body = await readBody(req, MAX_JUMP_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refuse(413, `The body must be no more than ${MAX_JUMP_BODY_BYTES} bytes.`)
        : refuse(400, "The body could not be read.");
    }
    const sessionId = sessionIdIn(body.text);
    if (sessionId === null) {
      return refuse(400, 'The body must name one session and nothing else: {"sessionId": "..."}.');
    }

    const session = poller.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
    const pane =
      session?.jump?.kind === "tmux" && session.pid !== undefined
        ? panes.paneOf(session.pid)
        : undefined;
    if (!pane) return failed(404, "no-pane", "No tmux pane is known for that session.");

    const at = now();
    const tooSoon = lastAt !== null && at >= lastAt && at - lastAt < JUMP_INTERVAL_MS;
    if (underWay || tooSoon) {
      return failed(429, "too-soon", "One jump is made a second. Try again in a moment.", {
        "Retry-After": "1",
      });
    }

    lastAt = at;
    underWay = true;
    try {
      const outcome = await selectPane(pane.id, run);
      if (outcome.ok) {
        return {
          status: 200,
          body: {
            ok: true,
            kind: "tmux",
            place: outcome.place ?? pane.place,
          } satisfies JumpResponse,
        };
      }
      if (outcome.reason === "failed") {
        return failed(500, "failed", "tmux could not be asked to select the pane.");
      }
      // What was found is out of date, so tmux is asked again at the next poll.
      panes.lookAgain();
      return outcome.reason === "pane-gone"
        ? failed(409, "pane-gone", "That pane has closed.")
        : failed(409, "tmux-stopped", "tmux is not running.");
    } finally {
      underWay = false;
    }
  };
}
