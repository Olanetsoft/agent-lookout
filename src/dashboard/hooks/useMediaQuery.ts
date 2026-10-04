import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current as the window changes. For the
 * few things CSS cannot do alone, such as how many columns a table cell spans
 * once some columns are left out.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** 760 pixels and below: the `mid` breakpoint in index.css, where `max-mid:` applies. */
export const NARROW = "(max-width: 760px)";

/** Whether the window is at the `mid` breakpoint or below it. */
export function useNarrow(): boolean {
  return useMediaQuery(NARROW);
}
