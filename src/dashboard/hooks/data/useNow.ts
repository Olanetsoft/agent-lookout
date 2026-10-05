import { useSyncExternalStore } from "react";

/**
 * The present, refreshed once a second and as the page comes back into sight.
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

/**
 * Back in sight, the clock reads the time at once: a hidden tab's timer may
 * have run only once a minute. React draws after every listener has run, so the
 * page that comes back is drawn with the fresh time.
 */
function onVisible(): void {
  if (!document.hidden) tick();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    current = Date.now();
    timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
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
