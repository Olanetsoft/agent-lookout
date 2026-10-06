// What the page in the app's window may ask the browser for, and reach.
//
// It may show notifications, as it does in a browser tab, and nothing else:
// no camera, no clipboard reading, no opening of other apps by itself, no
// devices. It may load nothing from the network either. The page's own policy
// already allows only its own origin; here the session refuses every web
// request outright, so nothing the page does can leave the machine. Its own
// scheme is answered by the app and is not a web request.

import type { Session } from "electron";

import { APP_ORIGIN } from "../../core/appAddress.ts";
import { isAppAddress } from "./links.ts";

/** Every request that would go over the network. */
const WEB_REQUESTS = { urls: ["*://*/*", "ws://*/*", "wss://*/*"] };

/** Whether the page may use this permission: notifications, from the app's own page. */
export function mayUse(permission: string, origin: string | undefined): boolean {
  return permission === "notifications" && origin === APP_ORIGIN;
}

/**
 * The app's origin when an address or an origin is the app's own, and
 * undefined otherwise. Electron writes an origin here as an address, with a
 * slash after the host, so it is read as one.
 */
export function appOriginOf(urlOrOrigin: string): string | undefined {
  return isAppAddress(urlOrOrigin) ? APP_ORIGIN : undefined;
}

export function applySessionRules(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(mayUse(permission, appOriginOf(details.requestingUrl)));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    mayUse(permission, appOriginOf(requestingOrigin)),
  );
  session.setDevicePermissionHandler(() => false);
  session.webRequest.onBeforeRequest(WEB_REQUESTS, (_details, callback) => {
    callback({ cancel: true });
  });
  session.on("will-download", (event) => event.preventDefault());
}
