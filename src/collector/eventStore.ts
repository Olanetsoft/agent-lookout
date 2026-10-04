import { MAX_EVENTS_PER_RESPONSE } from "../core/api.ts";
import type { SessionEvent } from "../core/session.ts";

/** How many events are kept. Older ones are dropped. */
export const EVENT_CAPACITY = 1_000;

export interface EventStore {
  /** Appends events in the order they happened. */
  add(events: readonly SessionEvent[]): void;
  /**
   * Newest first. `since` keeps only events after that time, so a caller that
   * passes the time of the newest event it holds gets no repeats.
   */
  list(options?: { since?: number; limit?: number }): SessionEvent[];
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
      const newestFirst: SessionEvent[] = [];
      for (let index = events.length - 1; index >= 0 && newestFirst.length < cap; index -= 1) {
        const event = events[index] as SessionEvent;
        // Events are stored in time order, so nothing older than this can match.
        if (since !== undefined && event.at <= since) break;
        newestFirst.push(event);
      }
      return newestFirst;
    },
    get size() {
      return events.length;
    },
  };
}
