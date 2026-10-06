import { useEffect, useRef, useState } from "react";

import type { SessionEvent } from "@core/sessions/session";
import { useNow } from "@dashboard/hooks/data/useNow";
import { useDocumentHidden } from "@dashboard/hooks/dom/useDocumentHidden";
import { nextNewSince, startNewSince, type NewSince } from "@dashboard/lib/events/newSince";

/** Where the moment the events log was last on screen is kept, as milliseconds since 1970. */
export const LAST_LOOKED_STORAGE_KEY = "agent-lookout-last-looked";

function readLastLooked(): number | null {
  try {
    const stored = Number(localStorage.getItem(LAST_LOOKED_STORAGE_KEY));
    return Number.isSafeInteger(stored) && stored > 0 ? stored : null;
  } catch {
    // Storage can be blocked. The page then starts with nothing kept.
    return null;
  }
}

function keepLastLooked(at: number): void {
  try {
    localStorage.setItem(LAST_LOOKED_STORAGE_KEY, String(at));
  } catch {
    // Storage can be blocked. The time is still kept for as long as the page is open.
  }
}

export interface UseNewSince {
  /** Events after this moment are new, and the log draws its line under them. Null while there is none. */
  since: number | null;
  /** The events log says whether its line is in view. */
  onLineInView: (inView: boolean) => void;
}

/**
 * Where the events log draws the line between what the person has seen and
 * what arrived while the page was out of sight. `nextNewSince` is the rule;
 * this feeds it the page's visibility, the view, the newest event and whether
 * the line is in view, on the one-second clock.
 *
 * The one thing it keeps is a time: when the log was last on screen, or while a
 * line has not gone yet, the line's own time. It holds that in memory, and
 * writes it to local storage as the page goes out of sight and as it is closed
 * or reloaded, so a page loaded again, or a tab the browser put away and opened
 * again, starts from the same place. Nothing about a session or an event is
 * kept.
 */
export function useNewSince(
  events: readonly SessionEvent[],
  overview: boolean,
  ready: boolean,
): UseNewSince {
  const hidden = useDocumentHidden();
  const now = useNow();
  const [lineInView, setLineInView] = useState(false);
  const [state, setState] = useState(() => startNewSince(readLastLooked()));
  const next = nextNewSince(state, {
    now,
    visible: !hidden && ready,
    overview,
    lineInView,
    newestAt: events[0]?.at ?? null,
  });
  // Kept as the page draws, as state learned from what was drawn before. A
  // second step with the same look changes nothing, so this settles at once.
  if (next !== state) setState(next);

  const latest = useRef<NewSince>(next);
  useEffect(() => {
    latest.current = next;
  });
  useEffect(() => {
    // Read from what was last drawn: as the page goes out of sight, that is
    // still the log on screen, which it was until now. A line that has not gone
    // yet keeps its own time, because what is above it is still to be seen.
    const keep = () => {
      const { away, overview: onOverview, leftAt, since } = latest.current;
      const at = since ?? (!away && onOverview ? Date.now() : leftAt);
      if (at !== null) keepLastLooked(at);
    };
    const onVisibility = () => {
      if (document.hidden) keep();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", keep);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", keep);
    };
  }, []);

  return { since: next.since, onLineInView: setLineInView };
}
