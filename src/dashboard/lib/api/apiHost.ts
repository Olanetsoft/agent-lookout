/**
 * The one seam between the dashboard and its data.
 *
 * Every data request goes through `apiRequest`. The dashboard never names a host,
 * so the same components run unchanged in the dev server, in the standalone
 * server, and later in an Electron window or a browser extension. A host that is
 * not same-origin installs its own transport with `setApiHost` before React
 * renders.
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
 * Requests a path from the app's own server, for example `apiRequest("/api/sessions")`.
 *
 * Only root-relative paths are accepted. A full URL, or any path a browser would
 * resolve to another host, is rejected before any request is made, because
 * nothing in the app may call another machine.
 */
export function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  if (!staysOnThisServer(path)) {
    return Promise.reject(
      new TypeError(
        `apiRequest takes a path on this app's own server, not ${JSON.stringify(path)}.`,
      ),
    );
  }
  return currentHost(path, init);
}
