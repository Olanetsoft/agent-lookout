import { useEffect, useState } from "react";

import type { WaitsResponse } from "@core/api";
import { historySince } from "@core/history";
import type { CollectorHistory } from "@dashboard/lib/api/collectorStore";
import { fetchWaitTotals, WAITS_REFRESH_MS } from "@dashboard/lib/sessions/waitTotals";

export interface WaitTotalsReading {
  /** The last answer, or null before there is one. */
  waits: WaitsResponse | null;
  /** `failed` only while there is no answer to show. */
  status: "loading" | "ready" | "failed";
}

/**
 * How long sessions waited today and over the last seven days, asked for when
 * the card mounts and every 30 seconds while it stays, and again at once when
 * the page comes back into sight. A restart, or a clearing of the history,
 * which `live` shows first, asks again at once, and so does a wait that opens
 * or ends, which `waiting` shows: the ids of the sessions that need the person
 * now. An answer that does not come keeps the last one: the page says above
 * everything when Agent Lookout has stopped answering.
 */
export function useWaitTotals(
  live: CollectorHistory | null,
  waiting: readonly string[],
): WaitTotalsReading {
  const [waits, setWaits] = useState<WaitsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const startedAt = live?.startedAt ?? null;
  const sinceAt = live ? historySince(live).at : null;
  const waitingNow = [...waiting].sort().join(" ");

  useEffect(() => {
    let mounted = true;
    const read = () => {
      void fetchWaitTotals().then((answer) => {
        if (!mounted) return;
        if (answer) setWaits(answer);
        setFailed(answer === null);
      });
    };
    const readInSight = () => {
      if (!document.hidden) read();
    };
    read();
    const timer = setInterval(readInSight, WAITS_REFRESH_MS);
    // A tab in the background is not asked; back in sight, it is asked at once.
    document.addEventListener("visibilitychange", readInSight);
    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", readInSight);
    };
  }, [startedAt, sinceAt, waitingNow]);

  if (waits) return { waits, status: "ready" };
  return { waits: null, status: failed ? "failed" : "loading" };
}
