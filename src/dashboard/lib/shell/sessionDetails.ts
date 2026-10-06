import { sessionHash, sessionIdFromHash } from "@core/sessions/sessionHash";
import { goTo } from "@dashboard/lib/shell/addressHost";

/**
 * The address of one session's details, which open over the Overview:
 * `#overview/session/claude-code:1234`. It is a fragment like the views', so a
 * link, the browser's back button and a reload all land on it, and the page
 * under it is the Overview. The Mac app's menu bar opens the same address, by
 * the rule in `@core/sessions/sessionHash`.
 */

/** What the page writes on the history entry it adds when it opens a session's details. */
const OPENED_HERE = "agent-lookout-details";

/**
 * The address of a session's details. The id is written so that any character
 * a status file's name can hold survives the trip; the colon after the source
 * is left as it is, so the address stays readable.
 */
export function sessionHref(sessionId: string): string {
  return sessionHash(sessionId);
}

/** The session a URL fragment names, or null when it names none. */
export function sessionFromHash(hash: string): string | null {
  return sessionIdFromHash(hash);
}

/**
 * Opens a session's details, as a new entry in the browser's history, so Back
 * closes them again. The entry is marked as added here. A host that moves the
 * address without adding an entry, as a frame on another page does, leaves
 * nothing to mark, so closing them replaces the address in turn.
 */
export function openSession(sessionId: string): void {
  const href = sessionHref(sessionId);
  if (window.location.hash === href) return;
  if (goTo(href)) window.history.replaceState({ [OPENED_HERE]: true }, "");
}

/** Set while the step back that closes the details is on its way. */
let leaving = false;

/**
 * Closes the details and goes back to the Overview. When this page added the
 * entry, that is going back, so the history holds no trace of them and Forward
 * opens them again. A second close before that step has landed, as from a
 * double click on Close, takes no second step, which would leave the Overview.
 * Arrived at from a link or a reload, there may be nothing of this page to go
 * back to, so the address is replaced with the Overview's.
 */
export function closeSession(): void {
  if (sessionFromHash(window.location.hash) === null) return;
  const state: unknown = window.history.state;
  if (typeof state === "object" && state !== null && OPENED_HERE in state) {
    if (leaving) return;
    leaving = true;
    window.addEventListener(
      "hashchange",
      () => {
        leaving = false;
      },
      { once: true },
    );
    window.history.back();
  } else {
    window.location.replace("#overview");
  }
}

/**
 * Opens a session's details from a click anywhere on its row or its card,
 * except on a control the row has of its own: its name, which is a link to
 * the same place, its Jump, and anything that opens a tooltip. A click that
 * ends a drag across the words, to copy them, opens nothing.
 */
export function openFromClick(
  event: { target: EventTarget; currentTarget: Element; defaultPrevented: boolean },
  sessionId: string,
): void {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const control = event.target.closest("a, button, [tabindex]");
  if (control && control !== event.currentTarget && event.currentTarget.contains(control)) return;
  if (window.getSelection()?.isCollapsed === false) return;
  openSession(sessionId);
}

/**
 * What the name's link does when pressed: opens the details in this page, as
 * a click on the row does. Pressed with a key that asks for a new tab or
 * window, it is left to the browser, which opens the same address there.
 */
export function openFromLink(
  event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    preventDefault: () => void;
  },
  sessionId: string,
): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  event.preventDefault();
  openSession(sessionId);
}
