import { useSyncExternalStore } from "react";

/**
 * The present, refreshed once a second.
 *
 * Durations on screen tick from this clock without any request being made. One
 * timer serves every component, and it only runs while something is listening.
 */

const TICK_MS = 1_000;

let current = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
  current = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    current = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return current;
}

/** Epoch milliseconds, updated every second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
