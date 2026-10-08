// The routes through which the page in the app's window reaches the app's own
// notifications: `GET /api/app/notifications` reads the reason macOS gave the
// last time it would not show one, and `POST /api/app/notifications/test`
// shows one test notification and answers with what macOS made of it.
//
// Only the Mac app answers them, under its own scheme, in
// `protocol/appProtocol.ts`. The standalone server and the dev server never
// mount this, so there the GET is the collector's 404 and the POST its 405.
//
// The POST passes the checks every request has (`refusalFor`) and those every
// route that acts makes (`actionRefusalFor` in `collector/handler.ts`), as the
// routes for updates and the menu bar do: a POST, from the dashboard's own
// page, with its own `X-Agent-Lookout-Action`, JSON and small. Its body is `{}`,
// and nothing from it reaches a command, a path or the notification.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ErrorResponse } from "../../core/api.ts";
import {
  APP_NOTIFICATIONS_PATH,
  APP_NOTIFICATIONS_TEST_ACTION,
  APP_NOTIFICATIONS_TEST_PATH,
  type AppNotificationsStatus,
} from "../../core/notices/appNotifications.ts";
import {
  actionRefusalFor,
  readRequestBody,
  refusalFor,
  type ApiAnswer,
} from "../../collector/handler.ts";
import { isEmptyObject } from "../updates/updateRoute.ts";
import type { DesktopNotifier } from "./desktopNotifier.ts";

/** The most a body may hold. `{}` is 2 bytes. */
export const MAX_NOTIFICATIONS_BODY_BYTES = 64;

const refuse = (
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ApiAnswer => ({
  status,
  body: { error } satisfies ErrorResponse,
  headers,
});

function send(res: ServerResponse, answer: ApiAnswer): void {
  const payload = JSON.stringify(answer.body);
  res.writeHead(answer.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...answer.headers,
  });
  res.end(payload);
}

/** The Node handler for `/api/app/notifications` and its test, over the app's notifier. */
export function createNotificationRoute(
  notifier: Pick<DesktopNotifier, "test" | "lastRefusal">,
): (req: IncomingMessage, res: ServerResponse) => void {
  async function answer(req: IncomingMessage): Promise<ApiAnswer> {
    const refusal = refusalFor(req);
    if (refusal) return refuse(403, refusal);

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return refuse(400, "That address could not be read.");
    }

    if (pathname === APP_NOTIFICATIONS_PATH) {
      if (req.method !== "GET") {
        return refuse(405, "This address only answers GET requests.", { Allow: "GET" });
      }
      return {
        status: 200,
        body: { lastRefusal: notifier.lastRefusal() } satisfies AppNotificationsStatus,
      };
    }
    if (pathname !== APP_NOTIFICATIONS_TEST_PATH) {
      return refuse(404, "There is nothing at that address.");
    }

    const refused = actionRefusalFor(
      req,
      APP_NOTIFICATIONS_TEST_ACTION,
      MAX_NOTIFICATIONS_BODY_BYTES,
    );
    if (refused) return refused;
    const body = await readRequestBody(req, MAX_NOTIFICATIONS_BODY_BYTES);
    if (!body.ok) {
      return body.tooLarge
        ? refuse(413, `The body must be no more than ${MAX_NOTIFICATIONS_BODY_BYTES} bytes.`, {
            Connection: "close",
          })
        : refuse(400, "The body could not be read.", { Connection: "close" });
    }
    if (!isEmptyObject(body.text)) return refuse(400, "The body must be {}.");
    return { status: 200, body: await notifier.test() };
  }

  return (req, res) => {
    answer(req)
      .then((answered) => {
        // A refused request's body is not read, and nothing more of it is waited for.
        req.resume();
        send(res, answered);
      })
      .catch(() => {
        if (res.headersSent) res.end();
        else send(res, refuse(500, "The app ran into an unexpected problem."));
      })
      .catch(() => {
        // The page has gone, and there is nobody left to tell.
      });
  };
}
