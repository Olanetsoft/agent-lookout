// The routes through which the page in the app's window reaches the switch
// Show in menu bar: `GET /api/app/menu-bar` reads it, and
// `POST /api/app/menu-bar/setting` turns it on or off.
//
// Only the Mac app answers them, under its own scheme, in
// `protocol/appProtocol.ts`. The standalone server and the dev server never
// mount this, so there each of these addresses is the collector's 404.
//
// The POST passes the checks every request has (`refusalFor`) and those every
// route that acts makes (`actionRefusalFor` in `collector/handler.ts`), as the
// routes for updates do: a POST, from the dashboard's own page, with its own
// `X-Agent-Lookout-Action`, JSON and small. Its body says the switch and
// nothing else, and nothing from it reaches a command or a path.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ErrorResponse } from "../../core/api.ts";
import {
  APP_MENU_BAR_ACTION,
  APP_MENU_BAR_PATH,
  APP_MENU_BAR_SETTING_PATH,
  type MenuBarStatus,
} from "../../core/appMenuBar.ts";
import {
  actionRefusalFor,
  readRequestBody,
  refusalFor,
  type ApiAnswer,
} from "../../collector/handler.ts";
import type { MenuBar } from "./menuBar.ts";

/** The most a body may hold. `{"show": false}` is 15 bytes. */
export const MAX_MENU_BAR_BODY_BYTES = 64;

/**
 * What the switch is set to, from a body that is exactly `{"show": true}` or
 * `{"show": false}`, or null for anything else.
 */
export function showIn(body: string): boolean | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "show") return null;
  const { show } = value as { show: unknown };
  return typeof show === "boolean" ? show : null;
}

const refuse = (
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ApiAnswer => ({
  status,
  body: { error } satisfies ErrorResponse,
  headers,
});

const answerWith = (status: MenuBarStatus): ApiAnswer => ({ status: 200, body: status });

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

/** The Node handler for `/api/app/menu-bar` and its setting, over the app's menu bar item. */
export function createMenuBarRoute(
  menuBar: Pick<MenuBar, "status" | "setShown">,
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

    if (pathname === APP_MENU_BAR_PATH) {
      if (req.method !== "GET") {
        return refuse(405, "This address only answers GET requests.", { Allow: "GET" });
      }
      return answerWith(menuBar.status());
    }
    if (pathname !== APP_MENU_BAR_SETTING_PATH) {
      return refuse(404, "There is nothing at that address.");
    }

    const refused = actionRefusalFor(req, APP_MENU_BAR_ACTION, MAX_MENU_BAR_BODY_BYTES);
    if (refused) return refused;
    const body = await readRequestBody(req, MAX_MENU_BAR_BODY_BYTES);
    if (!body.ok) {
      return body.tooLarge
        ? refuse(413, `The body must be no more than ${MAX_MENU_BAR_BODY_BYTES} bytes.`, {
            Connection: "close",
          })
        : refuse(400, "The body could not be read.", { Connection: "close" });
    }
    const show = showIn(body.text);
    return show === null
      ? refuse(400, 'The body must be {"show": true} or {"show": false}.')
      : answerWith(menuBar.setShown(show));
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
