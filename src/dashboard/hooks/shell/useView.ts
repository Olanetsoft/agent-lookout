import { useSyncExternalStore } from "react";

import { viewFromHash, type ViewId } from "@dashboard/lib/shell/view";

function subscribe(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function getSnapshot(): ViewId {
  return viewFromHash(window.location.hash);
}

/**
 * The view the page is on, read from the URL fragment and kept current as it
 * changes. The rail's links change the fragment, and so do the browser's back
 * and forward buttons, so every way of moving between views goes through here.
 */
export function useView(): ViewId {
  return useSyncExternalStore(subscribe, getSnapshot);
}
