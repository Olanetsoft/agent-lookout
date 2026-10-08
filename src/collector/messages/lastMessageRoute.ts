import type { IncomingMessage } from "node:http";

import type { ErrorResponse, LastMessageResponse } from "../../core/api.ts";
import type { Adapter } from "../adapters/adapter.ts";
import type { ApiAnswer } from "../handler.ts";
import { MAX_SESSION_ID_LENGTH } from "../jumpRoute.ts";
import type { Poller } from "../poller.ts";
import { LAST_MESSAGE_ENV, lastMessageOff } from "./lastMessageSettings.ts";

export interface LastMessageRouteOptions {
  /** Where `AGENT_LOOKOUT_LAST_MESSAGE` is read, once, as the route is made. */
  env: NodeJS.ProcessEnv;
  /** The collector's own latest list of sessions. */
  poller: Pick<Poller, "getSnapshot">;
  /** This computer's own adapters. Never another machine's, whose sessions are not read. */
  adapters: readonly Pick<Adapter, "id" | "lastMessage">[];
}

const answer = (body: LastMessageResponse): ApiAnswer => ({ status: 200, body });

const failed = (status: number, error: string, headers?: Record<string, string>): ApiAnswer => ({
  status,
  body: { error } satisfies ErrorResponse,
  ...(headers && { headers }),
});

/**
 * The id a query names, or null when it is anything but one `id` of 1 to 300
 * characters. A query that says more is not read for the part that fits.
 */
export function idIn(query: URLSearchParams): string | null {
  const pairs = [...query];
  if (pairs.length !== 1) return null;
  const [name, value] = pairs[0] ?? ["", ""];
  if (name !== "id" || value === "" || value.length > MAX_SESSION_ID_LENGTH) return null;
  return value;
}

/**
 * Answers `GET /api/sessions/last-message?id=<session id>`: what a session
 * the collector lists last said, which its adapter reads from the end of its
 * transcript now. Every check the handler makes of any request has been made.
 *
 * - A request a browser marks, it must mark `same-origin`: the dashboard's
 *   own page. A page at another site never gets this far, and one at another
 *   port of this machine, or a link opened from elsewhere, is refused here.
 * - The query names one session and nothing else.
 * - With `AGENT_LOOKOUT_LAST_MESSAGE=off` nothing is looked up.
 * - The session must be in the collector's own list, and is read by the
 *   adapter of its own source on this computer. A session on another machine,
 *   or of an agent whose adapter does not read what it says, is not read.
 *
 * Nothing from the request names a file: the adapter makes the path from what
 * it read for the session itself. The text is never logged.
 */
export function createLastMessageRoute(options: LastMessageRouteOptions) {
  const { poller, adapters } = options;
  const off = lastMessageOff(options.env);

  return async (req: Pick<IncomingMessage, "headers">, url: URL): Promise<ApiAnswer> => {
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") {
      return failed(403, "This address only answers the dashboard page served from this machine.");
    }
    const id = idIn(url.searchParams);
    if (id === null) {
      return failed(400, "Name one session as id, and nothing else.");
    }
    if (off) return answer({ message: null, reason: "off", setting: LAST_MESSAGE_ENV });

    const session = poller.getSnapshot().sessions.find((listed) => listed.id === id);
    const notListed = () => failed(404, "No session with that id is listed.");
    if (session === undefined) return notListed();
    const adapter = adapters.find((candidate) => candidate.id === session.source);
    if (adapter?.lastMessage === undefined) return answer({ message: null, reason: "not-read" });

    const read = await adapter.lastMessage(session.id);
    if (read === null) return notListed();
    if (read === "busy") {
      return failed(429, "Too many last messages were asked for at once. Ask again in a second.", {
        "Retry-After": "1",
      });
    }
    return answer(read);
  };
}
