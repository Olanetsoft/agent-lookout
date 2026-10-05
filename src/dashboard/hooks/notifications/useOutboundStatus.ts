import { useEffect, useState } from "react";

/** How often Settings reads it again while it is showing, so the last outcome keeps up. */
export const OUTBOUND_STATUS_REFRESH_MS = 5_000;

/** The app's answer, "unknown" when it did not give one, and when it was read. */
export interface OutboundStatusReading<Status> {
  status: Status | "unknown";
  readAt: number;
}

/**
 * Whether the app sends something off this computer, by email or to a
 * webhook, read with `fetchStatus` when the component mounts and every few
 * seconds while it stays. Null until the first answer. `fetchStatus` is a
 * function that does not change, such as `fetchEmailStatus`.
 */
export function useOutboundStatus<Status>(
  fetchStatus: () => Promise<Status | null>,
): OutboundStatusReading<Status> | null {
  const [reading, setReading] = useState<OutboundStatusReading<Status> | null>(null);

  useEffect(() => {
    let mounted = true;
    const read = () => {
      void fetchStatus().then((answer) => {
        if (mounted) setReading({ status: answer ?? "unknown", readAt: Date.now() });
      });
    };
    read();
    const timer = setInterval(read, OUTBOUND_STATUS_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [fetchStatus]);

  return reading;
}
