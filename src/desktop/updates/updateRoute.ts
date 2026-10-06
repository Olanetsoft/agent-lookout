// The routes through which the page in the app's window reaches its updates:
// `GET /api/app/update` reads where they stand, and three POSTs check now,
// install the version that is ready, and turn the automatic check on or off.
//
// Only the Mac app answers them, under its own scheme, in
// `protocol/appProtocol.ts`. The standalone server and the dev server never
// mount this, so there each of these addresses is the collector's 404.
//
// The page reaches them the way it reaches the collector, through the
// adapter in `protocol/requestAdapter.ts`, so a request from the app's own
// page carries the loopback `Origin` and one from anywhere else an `Origin` no
// check accepts. On top of the checks every request has (`refusalFor`), each
// POST must pass those every route that acts makes (`actionRefusalFor` in
// `collector/handler.ts`, as the jump route does): a POST, from
// the dashboard's own page, with its own `X-Agent-Lookout-Action`, JSON and
// small. A body says nothing but what its route needs. Nothing from a request
// reaches a command or a path: install takes no argument at all.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ErrorResponse } from "../../core/api.ts";
import {
  APP_UPDATE_ACTIONS,
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_SETTING_PATH,
  type AppUpdateInstallRefused,
  type AppUpdateStatus,
} from "../../core/appUpdate.ts";
import {
  actionRefusalFor,
  readRequestBody,
  refusalFor,
  type ApiAnswer,
} from "../../collector/handler.ts";
import type { Updater } from "./updater.ts";

/** The most a body may hold. `{"automatic": false}` is 20 bytes. */
export const MAX_UPDATE_BODY_BYTES = 256;

/** Whether a body is the empty JSON object, `{}`, which the check and the install send. */
export function isEmptyObject(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return false;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * What the switch is set to, from a body that is exactly
 * `{"automatic": true}` or `{"automatic": false}`, or null for anything else.
 */
export function settingIn(body: string): boolean | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "automatic") return null;
  const { automatic } = value as { automatic: unknown };
  return typeof automatic === "boolean" ? automatic : null;
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

const answerWith = (status: AppUpdateStatus): ApiAnswer => ({ status: 200, body: status });

/** The POSTs, each with its action and what it does with its body. */
type Post = (body: string) => Promise<ApiAnswer>;

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

/** The Node handler for `/api/app/*`, over the app's updater. */
export function createUpdateRoute(
  updater: Pick<Updater, "status" | "check" | "install" | "setAutomatic">,
): (req: IncomingMessage, res: ServerResponse) => void {
  const posts: Record<string, { action: string; act: Post }> = {
    [APP_UPDATE_CHECK_PATH]: {
      action: APP_UPDATE_ACTIONS.check,
      act: async (body) =>
        isEmptyObject(body)
          ? answerWith(await updater.check())
          : refuse(400, "The body must be {}."),
    },
    [APP_UPDATE_INSTALL_PATH]: {
      action: APP_UPDATE_ACTIONS.install,
      act: async (body) => {
        if (!isEmptyObject(body)) return refuse(400, "The body must be {}.");
        const installed = await updater.install();
        if (installed.ok) return answerWith(installed.status);
        return {
          status: 409,
          body: {
            error: "No version is ready to install here.",
            status: installed.status,
          } satisfies AppUpdateInstallRefused,
        };
      },
    },
    [APP_UPDATE_SETTING_PATH]: {
      action: APP_UPDATE_ACTIONS.setting,
      act: async (body) => {
        const automatic = settingIn(body);
        return automatic === null
          ? refuse(400, 'The body must be {"automatic": true} or {"automatic": false}.')
          : answerWith(updater.setAutomatic(automatic));
      },
    },
  };

  async function answer(req: IncomingMessage): Promise<ApiAnswer> {
    const refusal = refusalFor(req);
    if (refusal) return refuse(403, refusal);

    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return refuse(400, "That address could not be read.");
    }

    if (pathname === APP_UPDATE_PATH) {
      if (req.method !== "GET") {
        return refuse(405, "This address only answers GET requests.", { Allow: "GET" });
      }
      return answerWith(updater.status());
    }

    // Only the three addresses named above, never a name every object has.
    const post = Object.hasOwn(posts, pathname) ? posts[pathname] : undefined;
    if (post === undefined) return refuse(404, "There is nothing at that address.");
    const refused = actionRefusalFor(req, post.action, MAX_UPDATE_BODY_BYTES);
    if (refused) return refused;
    const body = await readRequestBody(req, MAX_UPDATE_BODY_BYTES);
    if (!body.ok) {
      return body.tooLarge
        ? refuse(413, `The body must be no more than ${MAX_UPDATE_BODY_BYTES} bytes.`, {
            Connection: "close",
          })
        : refuse(400, "The body could not be read.", { Connection: "close" });
    }
    return post.act(body.text);
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
