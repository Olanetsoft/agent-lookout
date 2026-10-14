// The routes through which the page in the app's window hears what came of
// installing the Claude Code plugin: `GET /api/app/claude-plugin` reads it,
// and `POST /api/app/claude-plugin/told` says the Overview has said so, so it
// is not said again.
//
// Only the Mac app answers them, under its own scheme, in
// `protocol/appProtocol.ts`. The standalone server and the dev server never
// mount this, so there the GET is the collector's 404 and the POST its 405.
//
// The POST passes the checks every request has (`refusalFor`) and those every
// route that acts makes (`actionRefusalFor` in `collector/handler.ts`), as the
// routes for updates and the menu bar do: a POST, from the dashboard's own
// page, with its own `X-Agent-Lookout-Action`, JSON and small. Its body is `{}`.
// No route starts, repeats or retries the install, and nothing from a request
// reaches a command.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { ErrorResponse } from "../../core/api.ts";
import {
  APP_PLUGIN_INSTALL_PATH,
  APP_PLUGIN_INSTALL_TOLD_ACTION,
  APP_PLUGIN_INSTALL_TOLD_PATH,
  type PluginInstallStatus,
} from "../../core/answers/pluginInstall.ts";
import {
  actionRefusalFor,
  readRequestBody,
  refusalFor,
  type ApiAnswer,
} from "../../collector/handler.ts";
import { isEmptyObject } from "../updates/updateRoute.ts";
import type { PluginInstaller } from "./pluginInstaller.ts";

/** The most a body may hold. `{}` is 2 bytes. */
export const MAX_PLUGIN_INSTALL_BODY_BYTES = 64;

const refuse = (
  status: number,
  error: string,
  headers: Record<string, string> = {},
): ApiAnswer => ({
  status,
  body: { error } satisfies ErrorResponse,
  headers,
});

const answerWith = (status: PluginInstallStatus): ApiAnswer => ({ status: 200, body: status });

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

/** The Node handler for `/api/app/claude-plugin` and its POST, over the app's installer. */
export function createPluginInstallRoute(
  installer: Pick<PluginInstaller, "status" | "markTold">,
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

    if (pathname === APP_PLUGIN_INSTALL_PATH) {
      if (req.method !== "GET") {
        return refuse(405, "This address only answers GET requests.", { Allow: "GET" });
      }
      return answerWith(installer.status());
    }
    if (pathname !== APP_PLUGIN_INSTALL_TOLD_PATH) {
      return refuse(404, "There is nothing at that address.");
    }

    const refused = actionRefusalFor(
      req,
      APP_PLUGIN_INSTALL_TOLD_ACTION,
      MAX_PLUGIN_INSTALL_BODY_BYTES,
    );
    if (refused) return refused;
    const body = await readRequestBody(req, MAX_PLUGIN_INSTALL_BODY_BYTES);
    if (!body.ok) {
      return body.tooLarge
        ? refuse(413, `The body must be no more than ${MAX_PLUGIN_INSTALL_BODY_BYTES} bytes.`, {
            Connection: "close",
          })
        : refuse(400, "The body could not be read.", { Connection: "close" });
    }
    if (!isEmptyObject(body.text)) return refuse(400, "The body must be {}.");
    return answerWith(installer.markTold());
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
