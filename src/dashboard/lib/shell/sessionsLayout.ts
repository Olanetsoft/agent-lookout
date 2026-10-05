/**
 * How the Sessions card lays out its sessions: as the list, grouped by status,
 * or as the board, a column for each status. The choice is kept in local
 * storage, so it belongs to this browser at this address, and is written only
 * when the person makes it. Until then it is the list.
 */

export type SessionsLayout = "list" | "board";

export const SESSIONS_LAYOUT_STORAGE_KEY = "agent-lookout-sessions-layout";

const DEFAULT_LAYOUT: SessionsLayout = "list";

/**
 * The choice made on this page while storage could not be written. The card
 * is drawn again each time the Overview opens, so without it the choice would
 * be lost on the way to Sources and back.
 */
let chosenHere: SessionsLayout | null = null;

/** The layout last chosen on this browser, or the list when none was, or it cannot be read. */
export function readSessionsLayout(): SessionsLayout {
  if (chosenHere !== null) return chosenHere;
  try {
    return localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY) === "board" ? "board" : DEFAULT_LAYOUT;
  } catch {
    // Storage can be blocked. Keep the default.
    return DEFAULT_LAYOUT;
  }
}

/** Keeps the choice for the next time the page opens. */
export function keepSessionsLayout(layout: SessionsLayout): void {
  try {
    localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, layout);
    chosenHere = null;
  } catch {
    // Storage can be blocked. The choice still holds until the page is closed.
    chosenHere = layout;
  }
}
