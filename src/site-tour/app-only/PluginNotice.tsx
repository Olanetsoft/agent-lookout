/*
 * The tour's note on the Claude Code plugin: nothing. The Overview draws the
 * real one, from src/dashboard/components/dashboard/PluginNotice.tsx, only
 * when `inAppWindow()` says the page is in the Mac app's own window, since
 * only the app installs the plugin. A browser never is, and so the tour never
 * is. scripts/site-tour/build.mjs points the dashboard's import of it here, so
 * the tour does not carry code it never runs. PluginNotice's tests hold that a
 * browser never draws it.
 */

/** In place of the Mac app's note on its Claude Code plugin. */
export function PluginNotice() {
  return null;
}
