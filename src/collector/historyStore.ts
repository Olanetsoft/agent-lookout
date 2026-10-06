import type { HistoryPoint } from "../core/sessions/session.ts";

/** How many points are kept: six hours of polls at one every two seconds. */
export const HISTORY_CAPACITY = 10_800;

export interface HistoryStore {
  /** Appends one poll's point. Points arrive in time order. */
  add(point: HistoryPoint): void;
  /** The points from the last `windowMs` up to `now`, oldest first. */
  list(windowMs: number, now: number): HistoryPoint[];
  /** Lets every point go, as clearing the history does. */
  clear(): void;
  readonly size: number;
}

/** History in memory, in a buffer that cannot grow past `capacity`. */
export function createHistoryStore(capacity: number = HISTORY_CAPACITY): HistoryStore {
  const max = Math.max(1, Math.floor(capacity));
  // Oldest first.
  let points: HistoryPoint[] = [];

  return {
    add(point) {
      points.push(point);
      if (points.length > max) points = points.slice(points.length - max);
    },
    list(windowMs, now) {
      const from = now - windowMs;
      // Walk back from the newest: the window is usually a small tail of the buffer.
      let start = points.length;
      while (start > 0 && (points[start - 1] as HistoryPoint).at >= from) start -= 1;
      return points.slice(start);
    },
    clear() {
      points = [];
    },
    get size() {
      return points.length;
    },
  };
}
