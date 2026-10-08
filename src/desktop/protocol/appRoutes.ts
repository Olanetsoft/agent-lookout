// The routes only the app answers, under `/api/app/*`: those of the menu bar
// item, `/api/app/menu-bar` and its setting, go to the menu bar's handler,
// those of the app's notifications, `/api/app/notifications` and its test, to
// the notifications' handler, and every other one to the updates', which
// answers 404 for an address it does not have.
//
// It imports nothing from Electron, so it is tested in plain Node.

import type { IncomingMessage, ServerResponse } from "node:http";

import { isMenuBarPath } from "../../core/appMenuBar.ts";
import { isNotificationsPath } from "../../core/notices/appNotifications.ts";
import type { NodeHandler } from "./requestAdapter.ts";

export interface AppRoutes {
  /** `/api/app/update` and its POSTs: `updates/updateRoute.ts`. */
  update: NodeHandler;
  /** `/api/app/menu-bar` and its setting: `menu-bar/menuBarRoute.ts`. */
  menuBar: NodeHandler;
  /** `/api/app/notifications` and its test: `notifications/notificationRoute.ts`. */
  notifications: NodeHandler;
}

/** The address's path, or the empty path when it cannot be read. */
function pathOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}

/** One handler for `/api/app/*`, which hands each request to the routes it belongs to. */
export function createAppRoutes(routes: AppRoutes): NodeHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = pathOf(req.url);
    if (isMenuBarPath(pathname)) return routes.menuBar(req, res);
    if (isNotificationsPath(pathname)) return routes.notifications(req, res);
    return routes.update(req, res);
  };
}
