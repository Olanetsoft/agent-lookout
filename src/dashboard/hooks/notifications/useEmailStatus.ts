import { useEffect, useState } from "react";

import type { EmailStatusResponse } from "@core/api";
import { fetchEmailStatus } from "@dashboard/lib/notifications/emailStatus";

/** How often Settings reads it again while it is showing, so the last email's outcome keeps up. */
export const EMAIL_STATUS_REFRESH_MS = 5_000;

/** The app's answer, "unknown" when it did not give one, and when it was read. */
export interface EmailStatusReading {
  status: EmailStatusResponse | "unknown";
  readAt: number;
}

/**
 * Whether the app sends an email for a wait, read when the component mounts
 * and every few seconds while it stays. Null until the first answer.
 */
export function useEmailStatus(): EmailStatusReading | null {
  const [reading, setReading] = useState<EmailStatusReading | null>(null);

  useEffect(() => {
    let mounted = true;
    const read = () => {
      void fetchEmailStatus().then((answer) => {
        if (mounted) setReading({ status: answer ?? "unknown", readAt: Date.now() });
      });
    };
    read();
    const timer = setInterval(read, EMAIL_STATUS_REFRESH_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return reading;
}
