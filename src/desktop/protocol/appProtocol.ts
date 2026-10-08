// What the app's own scheme answers: `/api/app/*`, the routes only the app has,
// from the app's own handler, the rest of `/api/*` from the collector's, and
// every other path from the built dashboard, by the same rules and with the
// same Content-Security-Policy as the standalone server's static files. All
// are Node handlers, reached through the adapter in `requestAdapter.ts`.
//
// It imports nothing from Electron, so it runs, and is tested, in plain Node.
// `main.ts` hands it to `protocol.handle`.

import { APP_HOST, APP_ORIGIN, APP_PROTOCOL } from "../../core/appAddress.ts";
import { isAppApiPath } from "../../core/appUpdate.ts";
import { isApiPath, type ApiHandler } from "../../collector/handler.ts";
import { createStaticHandler } from "../../collector/hosts/staticFiles.ts";
import { answerWith, originOf, type AppRequest, type NodeHandler } from "./requestAdapter.ts";

export interface AppProtocolOptions {
  /** The collector's handler for `/api/*`. */
  api: ApiHandler;
  /**
   * The app's own handler for `/api/app/*`: its updates, its menu bar item
   * and its notifications (`protocol/appRoutes.ts`). Left out, those
   * addresses go to the collector, which has nothing there.
   */
  app?: NodeHandler;
  /** The built dashboard: the folder that holds `index.html`. */
  distDir: string;
}

/** A short plain answer, for a request that never reaches a handler. */
function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Answers every request made to the app's scheme.
 *
 * Only the app's one host is served. A request that some other origin made is
 * refused before it reaches a handler. Inside this app no other origin has a
 * page, so this is a second fence behind the window's own navigation rules.
 */
export function createAppProtocolHandler(
  options: AppProtocolOptions,
): (request: AppRequest) => Promise<Response> {
  const serveFile = createStaticHandler(options.distDir);

  return async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, "That address could not be read.");
    }
    if (url.protocol !== APP_PROTOCOL || url.host !== APP_HOST) {
      return plain(404, "There is nothing at that address.");
    }
    const origin = originOf(request);
    if (origin !== undefined && origin !== APP_ORIGIN) {
      return plain(403, "This address only answers the app's own window.");
    }
    const handler =
      options.app && isAppApiPath(url.pathname)
        ? options.app
        : isApiPath(url.pathname)
          ? options.api
          : serveFile;
    return answerWith(handler, request, APP_ORIGIN);
  };
}
