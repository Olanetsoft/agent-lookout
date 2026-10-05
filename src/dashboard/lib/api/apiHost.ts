import { NOTIFICATIONS_HEADER, notificationsHeaderValue } from "@core/api";
import { notificationEventsInForce } from "@dashboard/lib/notifications/notificationSetting";

/**
 * The one seam between the dashboard and its data.
 *
 * Every data request goes through `apiRequest`. The dashboard never names a host,
 * so the same components run unchanged in the dev server, in the standalone
 * server, and later in an Electron window or a browser extension. A host that is
 * not same-origin installs its own transport with `setApiHost` before React
 * renders.
 *
 * Every request also says whether this page's notifications are on, and for
 * which events, in a header. The collector shows a notification itself when no
 * page is open to, and what the pages say is all it knows of the setting, so
 * turning notifications off here turns the collector's off at the next
 * request. It is added here, at the seam, so no request can go without it.
 */

/** Fetch-shaped on purpose, so a call site only swaps `fetch(` for `apiRequest(`. */
export type ApiHost = (path: string, init?: RequestInit) => Promise<Response>;

const sameOriginHost: ApiHost = (path, init) => fetch(path, init);

let currentHost: ApiHost = sameOriginHost;

/** Replaces the transport. Call with no argument to restore the same-origin default. */
export function setApiHost(host: ApiHost = sameOriginHost): void {
  currentHost = host;
}

/** A stand-in for this app's own address, used only to see where a path leads. Never requested. */
const PROBE_ORIGIN = "http://app.invalid";

/**
 * Whether a path stays on the app's own server. The path is resolved the way a
 * browser would resolve it, because that is not the way it reads: a browser drops
 * tabs and newlines and treats a backslash as a slash, so `/\t/host/x` is the
 * address of another machine.
 */
function staysOnThisServer(path: string): boolean {
  if (!path.startsWith("/")) return false;
  try {
    return new URL(path, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * What this page says of its notifications: the events it shows them of, which
 * is none unless the person has turned them on and the browser allows them.
 * Read at each request, because either can change in between.
 */
function notificationsSaid(): string {
  return notificationsHeaderValue(notificationEventsInForce());
}

/**
 * Requests a path from the app's own server, for example `apiRequest("/api/sessions")`.
 *
 * Only root-relative paths are accepted. A full URL, or any path a browser would
 * resolve to another host, is rejected before any request is made, because
 * nothing in the app may call another machine.
 *
 * The request is passed on as it was given, with one header added to its own.
 */
export function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  if (!staysOnThisServer(path)) {
    return Promise.reject(
      new TypeError(
        `apiRequest takes a path on this app's own server, not ${JSON.stringify(path)}.`,
      ),
    );
  }
  const headers = new Headers(init?.headers);
  headers.set(NOTIFICATIONS_HEADER, notificationsSaid());
  return currentHost(path, { ...init, headers });
}
