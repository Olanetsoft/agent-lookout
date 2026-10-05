import type { TerminalApp } from "../../core/sessions/session.ts";
import type { OsascriptResult, RunOsascript } from "./program.ts";
import { isTtyPath, type TerminalTab } from "./terminalTabs.ts";

// The one thing the collector does to Terminal and iTerm2: bring forward the
// tab that shows a terminal. Each app has one fixed script, which never
// changes. The only value that varies is the terminal device, which `ps` gave
// and which is checked to be `/dev/ttys` and digits, and it reaches the script
// as an argument, so nothing in it is read as AppleScript.

/** What a script prints when it brought the tab forward, and when no tab shows that terminal. */
const FOUND = "found";
const MISSING = "missing";

/**
 * Terminal: the tab whose terminal is the argument becomes its window's
 * selected tab, the window comes out of the Dock if it was minimised and in
 * front of Terminal's others, and Terminal comes to the front. A Terminal that
 * is not running is not started.
 */
export const TERMINAL_SCRIPT = [
  "on run argv",
  "set wanted to item 1 of argv",
  `if not (application id "com.apple.Terminal" is running) then return "${MISSING}"`,
  'tell application id "com.apple.Terminal"',
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "if tty of t is wanted then",
  "set selected of t to true",
  "if miniaturized of w then set miniaturized of w to false",
  "set index of w to 1",
  "activate",
  `return "${FOUND}"`,
  "end if",
  "end repeat",
  "end repeat",
  "end tell",
  `return "${MISSING}"`,
  "end run",
] as const;

/**
 * iTerm2: the session whose terminal is the argument is selected, with its tab
 * and its window, and iTerm2 comes to the front. An iTerm2 that is not running
 * is not started.
 */
export const ITERM_SCRIPT = [
  "on run argv",
  "set wanted to item 1 of argv",
  `if not (application id "com.googlecode.iterm2" is running) then return "${MISSING}"`,
  'tell application id "com.googlecode.iterm2"',
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "repeat with s in sessions of t",
  "if tty of s is wanted then",
  "select w",
  "select t",
  "select s",
  "activate",
  `return "${FOUND}"`,
  "end if",
  "end repeat",
  "end repeat",
  "end repeat",
  "end tell",
  `return "${MISSING}"`,
  "end run",
] as const;

const SCRIPTS: Record<TerminalApp, readonly string[]> = {
  Terminal: TERMINAL_SCRIPT,
  iTerm2: ITERM_SCRIPT,
};

/**
 * The arguments osascript is given to bring a tab forward: the app's fixed
 * script, a `--`, then the terminal device, alone. Null, and nothing is run,
 * for an app without a script or a value that is not a terminal device.
 *
 * The `--` keeps osascript from reading the argument as one of its own options.
 */
export function focusTabArgs(tab: TerminalTab): string[] | null {
  if (!Object.hasOwn(SCRIPTS, tab.app) || !isTtyPath(tab.tty)) return null;
  return [...SCRIPTS[tab.app].flatMap((line) => ["-e", line]), "--", tab.tty];
}

export type FocusFailure = "tab-gone" | "not-allowed" | "failed";

export type FocusOutcome = { ok: true } | { ok: false; reason: FocusFailure };

/**
 * The error macOS gives a program it has not been allowed to control another
 * app with: "Not authorized to send Apple events to Terminal. (-1743)".
 */
const NOT_ALLOWED = /\(-1743\)/;

/** What a run of a script came to, from what osascript printed. */
export function focusOutcomeOf(result: OsascriptResult): FocusOutcome {
  if (result.ok) {
    const said = result.stdout.trim();
    if (said === FOUND) return { ok: true };
    return { ok: false, reason: said === MISSING ? "tab-gone" : "failed" };
  }
  // A run that ran out of time, as one does while a question from macOS goes
  // unanswered, is a failure like any other.
  if (!result.timedOut && NOT_ALLOWED.test(result.stderr)) {
    return { ok: false, reason: "not-allowed" };
  }
  return { ok: false, reason: "failed" };
}

/** Brings a tab forward. Nothing is run for a tab whose arguments cannot be built. */
export async function focusTab(tab: TerminalTab, run: RunOsascript): Promise<FocusOutcome> {
  const args = focusTabArgs(tab);
  if (args === null) return { ok: false, reason: "failed" };
  return focusOutcomeOf(await run(args));
}
