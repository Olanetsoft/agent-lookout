import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { Session } from "@core/sessions/session";
import { jumpWay } from "@dashboard/lib/sessions/status";
import { openSession } from "@dashboard/lib/shell/sessionDetails";
import type { ViewId } from "@dashboard/lib/shell/view";

/** Every row that stands for one session on the Overview: in the hero, the Sessions table or its board. */
const ROWS = [
  '[data-slot="hero-session"]',
  '[data-slot="session-row"]',
  '[data-slot="board-card"]',
];

/** The same rows as one selector, for whatever follows focus from one row to the next. */
export const SESSION_ROWS = ROWS.join(", ");

/**
 * Does with a session what its Jump does, or opens its details when it has
 * none, as the search's line under its list says.
 *
 * A Jump is pressed on the session's own row, brought into view, with focus
 * on it, so the press is the one the row's own button makes, and the row says
 * what it came to. The ring shows whether the session was chosen by a key or
 * by a click, since after a click the person needs it as much to see which
 * row it is.
 *
 * Its details open over the Overview, as a click on its row opens them, and
 * closing them puts focus on its name. They also open for a session with a
 * Jump that has no row in the page, as one past the cards a board's column
 * shows, since they carry the same Jump.
 */
function show(view: HTMLElement | null, session: Session): void {
  if (jumpWay(session) === null) {
    openSession(session.id);
    return;
  }
  if (!view) return;
  const id = CSS.escape(session.id);
  const row = view.querySelector<HTMLElement>(
    ROWS.map((slot) => `${slot}[data-session="${id}"]`).join(", "),
  );
  const jump = row?.querySelector<HTMLElement>('[data-part="jump"]');
  if (!row || !jump) {
    openSession(session.id);
    return;
  }
  row.scrollIntoView({ block: "center" });
  jump.focus({ preventScroll: true, focusVisible: true });
  jump.click();
}

/**
 * Takes the person to a session chosen in the search. From another view it
 * moves to the Overview first, so closing the details lands there. The
 * Overview takes focus there as any new view does, so this hook is called
 * after the effect that does that, and the Jump takes focus from it.
 *
 * `main` is the main area the views are drawn in, and `view` the one showing.
 */
export function useShowSession(
  main: RefObject<HTMLElement | null>,
  view: ViewId,
): (session: Session) => void {
  const pending = useRef<Session | null>(null);

  useEffect(() => {
    if (view !== "overview" || pending.current === null) return;
    const session = pending.current;
    pending.current = null;
    show(main.current, session);
  }, [main, view]);

  return useCallback(
    (session: Session) => {
      if (view === "overview") {
        show(main.current, session);
        return;
      }
      pending.current = session;
      window.location.hash = "#overview";
    },
    [main, view],
  );
}
