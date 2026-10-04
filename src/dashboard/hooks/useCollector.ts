import { useSyncExternalStore } from "react";

import type { CollectorState, CollectorStore } from "@dashboard/lib/collectorStore";

/** Subscribes to a collector store. Polling runs only while something is subscribed. */
export function useCollector(store: CollectorStore): CollectorState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
