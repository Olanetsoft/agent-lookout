import { APP_PROTOCOL } from "@core/appAddress";

/** The page's own scheme, or nothing where there is no page, as in a test run in Node. */
function currentProtocol(): string {
  return typeof location === "undefined" ? "" : location.protocol;
}

/**
 * Whether the page is in the Mac app's own window. The app serves the page
 * from an address scheme of its own, so the page can tell from its address,
 * and needs nothing from the app to know.
 */
export function inAppWindow(protocol: string = currentProtocol()): boolean {
  return protocol === APP_PROTOCOL;
}

/**
 * Marks `<html>` with `data-host="app"` when the page is in the app's window.
 * The window has no title bar, so the stylesheet then makes room on the rail
 * for the window's three buttons and lets the header and the top of the rail
 * move the window when dragged. Nothing else about the page changes: it reaches
 * its data the same way, through `apiRequest`, on its own origin.
 *
 * In full screen, where macOS hides the window's buttons, the window itself
 * adds `data-fullscreen` to `<html>`, and the rail drops their cell.
 *
 * `main.tsx` calls it before React renders, so the first frame is already right.
 */
export function markAppWindow(
  root: HTMLElement = document.documentElement,
  protocol: string = currentProtocol(),
): void {
  if (inAppWindow(protocol)) root.dataset.host = "app";
}
