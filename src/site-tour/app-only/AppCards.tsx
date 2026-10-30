/*
 * The tour's Menu bar, Keep awake and Updates cards: nothing. Settings draws
 * the real ones, from src/dashboard/components/settings/app/, only when
 * `inAppWindow()` says the page is in the Mac app's own window. A browser
 * never is, and so the tour never is: its scene of the Mac app only sets
 * `data-host` on the page, whose address is still the site's.
 * scripts/site-tour/build.mjs points the dashboard's imports of the three
 * here, so the tour does not carry code it never runs. SettingsView's tests
 * hold that a browser draws none of them.
 */

/** In place of the Mac app's Menu bar card. */
export function MenuBarCard() {
  return null;
}

/** In place of the Mac app's Keep awake card. */
export function KeepAwakeCard() {
  return null;
}

/** In place of the Mac app's Updates card. */
export function UpdatesCard() {
  return null;
}
