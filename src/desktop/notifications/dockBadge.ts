// The number on the app's Dock icon: how many sessions need you now, by the
// same rule that lights the lamp in the page, `needsYou`, so a prompt answered
// by Allow, Deny or a permission rule is not counted while Claude Code's file
// still says it waits. No number when none do. The collector runs in the app,
// so the number is right with the window closed. It is a count, and never
// names a session.
//
// It imports nothing from Electron, so it is tested in plain Node.

import type { Session } from "../../core/sessions/session.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";

/** What the badge says for these sessions: the count needing you, or nothing at zero. */
export function dockBadgeText(sessions: readonly Pick<Session, "status" | "answered">[]): string {
  const needingYou = sessions.filter(needsYou).length;
  return needingYou > 0 ? String(needingYou) : "";
}

/**
 * Keeps the badge to each snapshot the collector takes. `setBadge` is
 * `app.dock.setBadge`, and is called only when the badge changes.
 */
export function createDockBadge(
  setBadge: (text: string) => void,
): (snapshot: { sessions: readonly Pick<Session, "status" | "answered">[] }) => void {
  let shown = "";
  return (snapshot) => {
    const text = dockBadgeText(snapshot.sessions);
    if (text === shown) return;
    setBadge(text);
    shown = text;
  };
}
