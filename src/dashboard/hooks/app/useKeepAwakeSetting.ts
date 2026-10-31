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
 * Whether the Mac app keeps the Mac awake while a session counts, and whether
 * it does right now, and the switch that changes it. It is read when the card
 * mounts and again each time `snapshotAt`, the time of the page's latest
 * snapshot, changes: the app follows every poll's snapshot, so by the time the
 * page has one, the app's answer is as new. The switch shows the app's answer,
 * so it stays as it was when the app does not take the change. An answer that
 * comes after a newer one, from a slower read, is left out, and so is one that
 * could not be read once there is an answer to show.
 *
 * Only the Keep awake card uses it, and Settings draws that only in the app's
 * window, so a page in a browser never asks.
 */
export function useKeepAwakeSetting(snapshotAt: number | null = null): KeepAwakeSetting {
  const [reading, setReading] = useState<KeepAwakeReading>(null);
  const mounted = useRef(true);
  /** How many reads and presses have been asked, and the newest whose answer has been shown. */
  const asked = useRef(0);
  const shown = useRef(0);

  const show = useCallback((ask: number, answer: KeepAwakeStatus | null, isRead: boolean) => {
    if (!mounted.current || ask < shown.current) return;
    // An answer that could not be read leaves what is shown as it was, but
    // for a read's before anything is shown, which says so.
    if (answer === null && !(isRead && shown.current === 0)) return;
    shown.current = ask;
    setReading(answer ?? "unknown");
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const ask = ++asked.current;
    void fetchKeepAwakeStatus().then((answer) => show(ask, answer, true));
  }, [snapshotAt, show]);

  const setOn = useCallback(
    (on: boolean) => {
      const ask = ++asked.current;
      void requestKeepAwake(on).then((answer) => show(ask, answer, false));
    },
    [show],
  );

  return { reading, setOn };
}
