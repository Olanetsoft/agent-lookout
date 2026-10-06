// The number on the app's Dock icon: how many sessions need you now, by the
// same rule that lights the lamp in the page, and no number when none do. The
// collector runs in the app, so the number is right with the window closed.
// It is a count, and never names a session.
//
// It imports nothing from Electron, so it is tested in plain Node.

import type { Session } from "../../core/sessions/session.ts";

/** What the badge says for these sessions: the count needing you, or nothing at zero. */
export function dockBadgeText(sessions: readonly Pick<Session, "status">[]): string {
  const needingYou = sessions.filter((session) => session.status === "needs-you").length;
  return needingYou > 0 ? String(needingYou) : "";
}

/**
 * Keeps the badge to each snapshot the collector takes. `setBadge` is
 * `app.dock.setBadge`, and is called only when the badge changes.
 */
export function createDockBadge(
  setBadge: (text: string) => void,
): (snapshot: { sessions: readonly Pick<Session, "status">[] }) => void {
  let shown = "";
  return (snapshot) => {
    const text = dockBadgeText(snapshot.sessions);
    if (text === shown) return;
    setBadge(text);
    shown = text;
  };
}
