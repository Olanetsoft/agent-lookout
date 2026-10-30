// What the Mac app's page and its main process say to each other about the
// switch Keep the Mac awake: whether it is on. Settings has the switch, which
// is off until the person turns it on. While it is on, the app keeps the Mac
// from going to sleep on its own while a session counts (`keepAwakeRule.ts`).
//
// The app answers these under its own scheme, `agent-lookout://app/`, beside
// its routes for updates and the menu bar. The standalone server and the dev
// server never do: there, the collector answers a GET of either address
// with 404 and a POST with 405.

/** `GET`: whether the switch is on, a `KeepAwakeStatus`. */
export const APP_KEEP_AWAKE_PATH = "/api/app/keep-awake";

/** `POST`, with the body `{"on": true}` or `{"on": false}`: the switch in Settings. */
export const APP_KEEP_AWAKE_SETTING_PATH = "/api/app/keep-awake/setting";

/**
 * What `ACTION_HEADER` says on the POST. A page at another origin cannot send
 * a header of this kind without asking first, and is never told yes.
 */
export const APP_KEEP_AWAKE_ACTION = "keep-awake-setting";

/** Whether an address belongs to the keep-awake routes. */
export function isKeepAwakePath(pathname: string): boolean {
  return pathname === APP_KEEP_AWAKE_PATH || pathname.startsWith(`${APP_KEEP_AWAKE_PATH}/`);
}

/** `GET /api/app/keep-awake`, and the answer to the POST. */
export interface KeepAwakeStatus {
  /** Whether the switch is on. Off until the person turns it on. */
  on: boolean;
}

/** The body of `POST /api/app/keep-awake/setting`, and nothing else. */
export interface KeepAwakeSettingRequest {
  on: boolean;
}
