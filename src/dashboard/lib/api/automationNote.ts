import { TERMINAL_APPS, type TerminalApp } from "@core/sessions/session";

/**
 * Where the page keeps the terminal apps it has said macOS will ask about, as
 * names separated by commas: `Terminal,iTerm2`.
 */
export const AUTOMATION_NOTE_STORAGE_KEY = "agent-lookout-automation-note";

/** Said on this page while storage could not be written. */
const saidHere = new Set<TerminalApp>();

/** The apps storage says the line has been said for. Nothing, when it cannot be read. */
function storedApps(): TerminalApp[] {
  try {
    const stored = localStorage.getItem(AUTOMATION_NOTE_STORAGE_KEY) ?? "";
    return TERMINAL_APPS.filter((app) => stored.split(",").includes(app));
  } catch {
    // Storage can be blocked.
    return [];
  }
}

/**
 * Whether the line about macOS's question is still to be said for this app:
 * it is said once on a browser, the first time a tab of that app is jumped to.
 */
export function automationNoteDue(app: TerminalApp): boolean {
  return !saidHere.has(app) && !storedApps().includes(app);
}

/** Records that the line has been said for this app, so it is not said again. */
export function automationNoteSaid(app: TerminalApp): void {
  const said = new Set([...storedApps(), app]);
  try {
    localStorage.setItem(
      AUTOMATION_NOTE_STORAGE_KEY,
      TERMINAL_APPS.filter((name) => said.has(name)).join(","),
    );
  } catch {
    // Storage can be blocked. It is said once on this page instead.
    saidHere.add(app);
  }
}
