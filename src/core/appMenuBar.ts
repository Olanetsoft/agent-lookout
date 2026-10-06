// What the Mac app's page and its main process say to each other about the
// item the app keeps in the menu bar: whether it is shown. Settings has the
// switch, Show in menu bar, which is on until the person turns it off.
//
// The app answers these under its own scheme, `agent-lookout://app/`, beside
// its routes for updates. The standalone server and the dev server never do:
// there, each of these addresses is the collector's 404.

/** `GET`: whether the menu bar item is shown, a `MenuBarStatus`. */
export const APP_MENU_BAR_PATH = "/api/app/menu-bar";

/** `POST`, with the body `{"show": true}` or `{"show": false}`: the switch in Settings. */
export const APP_MENU_BAR_SETTING_PATH = "/api/app/menu-bar/setting";

/**
 * What `ACTION_HEADER` says on the POST. A page at another origin cannot send
 * a header of this kind without asking first, and is never told yes.
 */
export const APP_MENU_BAR_ACTION = "menu-bar-setting";

/** Whether an address belongs to the menu bar's routes. */
export function isMenuBarPath(pathname: string): boolean {
  return pathname === APP_MENU_BAR_PATH || pathname.startsWith(`${APP_MENU_BAR_PATH}/`);
}

/** `GET /api/app/menu-bar`, and the answer to the POST. */
export interface MenuBarStatus {
  /**
   * Whether the item is in the menu bar. On until the person turns it off, and
   * off while it could not be put there, whatever the switch was set to.
   */
  show: boolean;
}

/** The body of `POST /api/app/menu-bar/setting`, and nothing else. */
export interface MenuBarSettingRequest {
  show: boolean;
}
