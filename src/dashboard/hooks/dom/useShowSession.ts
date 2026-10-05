import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { ViewId } from "@dashboard/lib/shell/view";

/** Every row that stands for one session on the Overview: in the hero, or in the Sessions table. */
const ROWS = ['[data-slot="hero-session"]', '[data-slot="session-row"]'];

/**
 * Brings a session's row into view and puts focus on it. A row with a Jump has
 * its Jump focused and pressed, so the press is the one the row's own button
 * makes, and the row says what it came to. A row without one takes focus
 * itself, until focus moves on to another part of the page: it is not a stop
 * on the way through the page. A session whose row has gone leaves focus on
 * the view.
 *
 * The ring shows whether the session was chosen by a key or by a click, since
 * after a click the person needs it as much to see which row it is.
 */
function show(view: HTMLElement | null, sessionId: string): void {
  if (!view) return;
  const id = CSS.escape(sessionId);
  const row = view.querySelector<HTMLElement>(
    ROWS.map((slot) => `${slot}[data-session="${id}"]`).join(", "),
  );
  if (!row) {
    view.focus({ preventScroll: true });
    return;
  }
  row.scrollIntoView({ block: "center" });
  const jump = row.querySelector<HTMLElement>('[data-part="jump"]');
  if (jump) {
    jump.focus({ preventScroll: true, focusVisible: true });
    jump.click();
    return;
  }
  if (!row.hasAttribute("tabindex")) {
    row.tabIndex = -1;
    // Kept while a dialog opened from here has focus, so closing it gives focus back to the row.
    const drop = (event: FocusEvent) => {
      const to = event.target;
      if (to === row || (to instanceof Element && to.closest('[role="dialog"]'))) return;
      row.removeAttribute("tabindex");
      document.removeEventListener("focusin", drop);
    };
    document.addEventListener("focusin", drop);
  }
  row.focus({ preventScroll: true, focusVisible: true });
}

/**
 * Takes the person to a session on the Overview, as choosing it in the search
 * does. From another view it moves to the Overview first. The Overview takes
 * focus there as any new view does, so this hook is called after the effect
 * that does that, and the row takes focus from it.
 *
 * `main` is the main area the views are drawn in, and `view` the one showing.
 */
export function useShowSession(
  main: RefObject<HTMLElement | null>,
  view: ViewId,
): (sessionId: string) => void {
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (view !== "overview" || pending.current === null) return;
    const sessionId = pending.current;
    pending.current = null;
    show(main.current, sessionId);
  }, [main, view]);

  return useCallback(
    (sessionId: string) => {
      if (view === "overview") {
        show(main.current, sessionId);
        return;
      }
      pending.current = sessionId;
      window.location.hash = "#overview";
    },
    [main, view],
  );
}
