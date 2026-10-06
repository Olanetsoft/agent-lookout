// Where the page in the app's window may go: the app's own addresses, and
// nowhere else. `links.ts` decides which addresses those are, and which links
// may be handed to the system instead; this applies those decisions to the
// window's page, on every way a page can try to leave.
//
// It imports only types from Electron, and takes what opens a link outside the
// app as an argument, so it is tested in plain Node with a stand-in for the page.

import type { WebContents } from "electron";

import { externalLinkFor, isAppAddress } from "./links.ts";

/** Hands a link to the system, which opens it in the right app: `shell.openExternal`. */
export type OpenExternal = (url: string) => Promise<void>;

/**
 * Keeps a window's page to the app's own addresses. A link to anywhere else is
 * never followed in the window: it is handed to the system when it may leave
 * the app, and dropped when not. No page may open a window of its own, or a
 * webview.
 */
export function guardNavigation(contents: WebContents, openExternal: OpenExternal): void {
  /** Hands a link the page opened to the system, when it is one that may leave the app. */
  const openOutside = (url: string): void => {
    const link = externalLinkFor(url);
    if (link === null) return;
    openExternal(link).catch(() => {
      // Nothing on this machine opens it. There is nobody to tell.
    });
  };

  contents.on("will-navigate", (event) => {
    if (isAppAddress(event.url)) return;
    event.preventDefault();
    openOutside(event.url);
  });
  // The page has no frames, and a frame may never leave the app's addresses.
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAppAddress(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (!isAppAddress(event.url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
}
