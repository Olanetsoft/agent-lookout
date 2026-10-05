import { useEffect, useState } from "react";

import {
  fetchHistory,
  HISTORY_WINDOW_MS,
  type CollectorHistory,
} from "@dashboard/lib/api/collectorStore";
import { mergeHistory } from "@dashboard/lib/charts/historyChart";

/** How often a long window is asked for again while a panel shows it. */
const REFRESH_MS = 60_000;

export interface HistoryWindow {
  /** The points for the window, or null while they are not there to show. */
  history: CollectorHistory | null;
  status: "ready" | "loading" | "failed";
}

/**
 * The counts over a window of time, for a history panel.
 *
 * The page already polls the last 15 minutes on every beat, so that window costs
 * nothing more. A longer one is asked for when the panel wants it and once a
 * minute after, and the polled points are joined on to its end, so the chart
 * still moves with every poll.
 */
export function useHistoryWindow(windowMs: number, live: CollectorHistory | null): HistoryWindow {
  const [loaded, setLoaded] = useState<{ windowMs: number; history: CollectorHistory } | null>(
    null,
  );
  const [failedFor, setFailedFor] = useState<number | null>(null);
  const long = windowMs > HISTORY_WINDOW_MS;
  // A new start time means the collector restarted, and what was loaded is of the old one.
  const startedAt = live?.startedAt ?? null;

  useEffect(() => {
    if (!long) return;
    let current = true;
    const load = () => {
      fetchHistory(windowMs).then(
        (history) => {
          if (!current) return;
          setLoaded({ windowMs, history });
          setFailedFor(null);
        },
        () => {
          if (current) setFailedFor(windowMs);
        },
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [long, windowMs, startedAt]);

  if (!long) return { history: live, status: live ? "ready" : "loading" };

  const base =
    loaded?.windowMs === windowMs && (startedAt === null || loaded.history.startedAt === startedAt)
      ? loaded.history
      : null;
  if (!base) return { history: null, status: failedFor === windowMs ? "failed" : "loading" };
  return { history: mergeHistory(base, live), status: "ready" };
}
