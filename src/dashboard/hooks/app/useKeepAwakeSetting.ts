import { useCallback, useEffect, useRef, useState } from "react";

import type { KeepAwakeStatus } from "@core/keep-awake/appKeepAwake";
import { fetchKeepAwakeStatus, requestKeepAwake } from "@dashboard/lib/keep-awake/keepAwakeSetting";

/** The app's answer, "unknown" when it did not give one, or null before the first. */
export type KeepAwakeReading = KeepAwakeStatus | "unknown" | null;

export interface KeepAwakeSetting {
  reading: KeepAwakeReading;
  setOn: (on: boolean) => void;
}

/**
 * Whether the Mac app keeps the Mac awake while a session counts, read once
 * when the card mounts, and the switch that changes it. The switch shows the
 * app's answer, so it stays as it was when the app does not take the change.
 * Only the Keep awake card uses it, and Settings draws that only in the app's
 * window, so a page in a browser never asks.
 */
export function useKeepAwakeSetting(): KeepAwakeSetting {
  const [reading, setReading] = useState<KeepAwakeReading>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void fetchKeepAwakeStatus().then((answer) => {
      if (mounted.current) setReading(answer ?? "unknown");
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const setOn = useCallback((on: boolean) => {
    void requestKeepAwake(on).then((answer) => {
      // An answer that could not be read leaves the switch as it was.
      if (mounted.current && answer !== null) setReading(answer);
    });
  }, []);

  return { reading, setOn };
}
