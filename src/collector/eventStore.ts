import { MAX_EVENTS_PER_RESPONSE } from "../core/api.ts";
import type { SessionEvent } from "../core/sessions/session.ts";

/** How many events are kept. Older ones are dropped. */
export const EVENT_CAPACITY = 1_000;

export interface EventStore {
  /** Appends events in the order they happened. */
  add(events: readonly SessionEvent[]): void;
  /**
   * Newest first. `since` keeps only the events added after the one at that
   * time, whatever theirs are, so a caller that passes the time of the newest
   * event it holds misses none when the clock is set back, and gets no repeats
   * when it is not. With none at that time it keeps those later than it.
   */
  list(options?: { since?: number; limit?: number }): SessionEvent[];
  /** Lets every event go, as clearing the history does. */
  clear(): void;
  readonly size: number;
}

/** Events in memory, in a buffer that cannot grow past `capacity`. */
export function createEventStore(capacity: number = EVENT_CAPACITY): EventStore {
  const max = Math.max(1, Math.floor(capacity));
  // Oldest first.
  let events: SessionEvent[] = [];

  return {
    add(added) {
      if (added.length === 0) return;
      events = events.concat(added);
      if (events.length > max) events = events.slice(events.length - max);
    },
    list({ since, limit = MAX_EVENTS_PER_RESPONSE } = {}) {
      const cap = Math.max(0, Math.min(Math.floor(limit), MAX_EVENTS_PER_RESPONSE));
      let held = events.findIndex((event) => event.at === since);
      while (held >= 0 && events[held]?.at === since) held += 1;
      const added =
        since === undefined || held >= 0
          ? events.slice(Math.max(0, held))
          : events.filter((event) => event.at > since);
      return added.slice(Math.max(0, added.length - cap)).reverse();
    },
    clear() {
      events = [];
    },
    get size() {
      return events.length;
    },
  };
}
