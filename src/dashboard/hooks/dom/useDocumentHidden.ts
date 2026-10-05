import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

function getSnapshot(): boolean {
  return document.hidden;
}

/**
 * Whether the page is out of sight: its tab in the background, or its window
 * minimised. Motion that nobody can see is paused while it is.
 */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
