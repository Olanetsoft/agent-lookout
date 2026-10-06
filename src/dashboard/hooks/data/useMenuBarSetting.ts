import { useCallback, useEffect, useRef, useState } from "react";

import type { MenuBarStatus } from "@core/appMenuBar";
import { fetchMenuBarStatus, requestMenuBarShown } from "@dashboard/lib/menu-bar/menuBarSetting";

/** The app's answer, "unknown" when it did not give one, or null before the first. */
export type MenuBarReading = MenuBarStatus | "unknown" | null;

export interface MenuBarSetting {
  reading: MenuBarReading;
  setShown: (show: boolean) => void;
}

/**
 * Whether the Mac app shows its item in the menu bar, read once when the card
 * mounts, and the switch that changes it. The switch shows the app's answer,
 * so it stays as it was when the app does not take the change. Only the Menu
 * bar card uses it, and Settings draws that only in the app's window, so a
 * page in a browser never asks.
 */
export function useMenuBarSetting(): MenuBarSetting {
  const [reading, setReading] = useState<MenuBarReading>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void fetchMenuBarStatus().then((answer) => {
      if (mounted.current) setReading(answer ?? "unknown");
    });
    return () => {
      mounted.current = false;
    };
  }, []);

  const setShown = useCallback((show: boolean) => {
    void requestMenuBarShown(show).then((answer) => {
      // An answer that could not be read leaves the switch as it was.
      if (mounted.current && answer !== null) setReading(answer);
    });
  }, []);

  return { reading, setShown };
}
