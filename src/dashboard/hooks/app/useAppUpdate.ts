import { useCallback, useEffect, useRef, useState } from "react";

import type { AppUpdateStatus } from "@core/appUpdate";
import {
  fetchUpdateStatus,
  requestAutomaticUpdates,
  requestUpdateCheck,
  requestUpdateInstall,
} from "@dashboard/lib/updates/appUpdate";

/** How often the card reads the status while a check, a download or an install is under way. */
export const UPDATE_BUSY_REFRESH_MS = 1_000;

/** How often it reads it otherwise, so a check the app made by itself shows up. */
export const UPDATE_REFRESH_MS = 5_000;

/** The app's answer, "unknown" when it did not give one, or null before the first. */
export type UpdateReading = AppUpdateStatus | "unknown" | null;

export interface AppUpdate {
  reading: UpdateReading;
  /** Which press is waiting for the app's answer. */
  pressed: "check" | "install" | null;
  check: () => void;
  install: () => void;
  setAutomatic: (on: boolean) => void;
}

/** A download, one ready, or an install, which the app leaves as it is through a check. */
function underWay(reading: AppUpdateStatus): boolean {
  const { phase } = reading.update;
  return phase === "downloading" || phase === "ready" || phase === "installing";
}

function busy(reading: UpdateReading): boolean {
  if (reading === null || reading === "unknown") return false;
  const { phase } = reading.update;
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

/**
 * Where the Mac app's updates stand, read when the card mounts and again every
 * few seconds while it stays, each second while something is under way, and
 * the three things the card can ask the app to do. A press updates the card
 * with the app's answer. Only the Updates card uses it, and Settings draws
 * that only in the app's window, so a page in a browser never asks.
 */
export function useAppUpdate(): AppUpdate {
  const [reading, setReading] = useState<UpdateReading>(null);
  const [pressed, setPressed] = useState<"check" | "install" | null>(null);
  const mounted = useRef(true);

  const take = useCallback((answer: AppUpdateStatus | null) => {
    if (mounted.current) setReading(answer ?? "unknown");
  }, []);

  useEffect(() => {
    mounted.current = true;
    void fetchUpdateStatus().then(take);
    return () => {
      mounted.current = false;
    };
  }, [take]);

  const isBusy = busy(reading);
  useEffect(() => {
    if (reading === null) return;
    const timer = setTimeout(
      () => void fetchUpdateStatus().then(take),
      isBusy ? UPDATE_BUSY_REFRESH_MS : UPDATE_REFRESH_MS,
    );
    return () => clearTimeout(timer);
  }, [reading, isBusy, take]);

  const check = useCallback(() => {
    setPressed("check");
    // Said at once, as the app says it, so a slow answer does not look like none.
    setReading((before) =>
      before === null || before === "unknown" || underWay(before)
        ? before
        : { ...before, update: { phase: "checking" } },
    );
    void requestUpdateCheck().then((answer) => {
      if (!mounted.current) return;
      setPressed(null);
      // An answer that could not be read leaves the card as it was, and the next read catches up.
      if (answer !== null) setReading(answer);
    });
  }, []);

  const install = useCallback(() => {
    setPressed("install");
    void requestUpdateInstall().then((answer) => {
      if (!mounted.current) return;
      setPressed(null);
      if (answer !== null) setReading(answer);
    });
  }, []);

  const setAutomatic = useCallback((on: boolean) => {
    void requestAutomaticUpdates(on).then((answer) => {
      if (mounted.current && answer !== null) setReading(answer);
    });
  }, []);

  return { reading, pressed, check, install, setAutomatic };
}
