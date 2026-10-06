// Where the Mac app serves the dashboard and its API: an address scheme of the
// app's own, so the page and the API are one origin that only the app's window
// can reach, and no port is opened. The app registers it before it starts, and
// the page reads it from `location.protocol` to know it is in the app's window.

/** The scheme the Mac app serves the dashboard from. */
export const APP_SCHEME = "agent-lookout";

/** The one host under that scheme. */
export const APP_HOST = "app";

/** The page's origin in the app's window, as the browser writes it. */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** The address the app's window opens. */
export const APP_START_URL = `${APP_ORIGIN}/`;

/** What `location.protocol` reads in the app's window. */
export const APP_PROTOCOL = `${APP_SCHEME}:`;
