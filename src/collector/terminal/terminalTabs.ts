import path from "node:path";

import type { TerminalApp } from "../../core/sessions/session.ts";
import type { ProcessFacts } from "../processes/processTable.ts";

// Which terminal app a process runs in, and on which of its terminals, read
// from a table of processes. Pure, so every odd chain can be tested.

/** A tab of a terminal app, as the collector knows it. */
export interface TerminalTab {
  app: TerminalApp;
  /**
   * The terminal device the tab shows, `/dev/ttys003`, which no other tab has
   * while it is open. The only thing a script is ever aimed with.
   */
  tty: string;
}

/** Where macOS keeps Terminal's executable. */
export const TERMINAL_PATH = "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";

/** Where iTerm2's executable is when it is installed the usual way. */
export const ITERM_PATH = "/Applications/iTerm.app/Contents/MacOS/iTerm2";

/**
 * iTerm2 runs each window's shells under a server process of its own, a copy
 * of a program it keeps in the person's Library and names for its version.
 */
const ITERM_SERVER_FOLDER = "Library/Application Support/iTerm2";
const ITERM_SERVER_NAME = /^iTermServer-[0-9A-Za-z._-]{1,40}$/;

const TTY_NAME = /^ttys\d{1,4}$/;
const TTY_PATH = /^\/dev\/ttys\d{1,4}$/;

/** Whether a value is a terminal device as a tab names it, `/dev/ttys003`, and nothing more. */
export function isTtyPath(value: unknown): value is string {
  return typeof value === "string" && TTY_PATH.test(value);
}

/** The terminal device `ps` names, `ttys003`, as a path, or null for anything else. */
export function ttyPathOf(name: string): string | null {
  return TTY_NAME.test(name) ? `/dev/${name}` : null;
}

/** The terminal app a program is, or null when it is none Agent Lookout can drive. */
export function appOfProgram(program: string, homeDir: string): TerminalApp | null {
  if (program === TERMINAL_PATH) return "Terminal";
  if (program === ITERM_PATH) return "iTerm2";
  const inServerFolder = path.dirname(program) === path.join(homeDir, ITERM_SERVER_FOLDER);
  return inServerFolder && ITERM_SERVER_NAME.test(path.basename(program)) ? "iTerm2" : null;
}

/**
 * The tab a process runs in: its own terminal, and the app found by walking up
 * through its parents. Undefined when the process has no terminal or none
 * that an app Agent Lookout can drive shows.
 *
 * Every process between a session and its app has the session's terminal. The
 * first parent that has another, or none, is the one that made that terminal.
 * When it is not Terminal or iTerm2, the terminal is not a tab of theirs: it
 * is another app's, such as Warp's or VS Code's, or tmux's, `script`'s or
 * `ssh`'s, even when one of those runs inside a Terminal tab.
 *
 * The walk stops at the first process of the system, at a process `ps` did not
 * list, and at one already passed, so a table that loops cannot hold it.
 */
export function tabOfProcess(
  pid: number,
  table: ReadonlyMap<number, ProcessFacts>,
  homeDir: string,
): TerminalTab | undefined {
  const own = table.get(pid);
  const tty = own ? ttyPathOf(own.tty) : null;
  if (!own || tty === null) return undefined;

  const passed = new Set<number>([pid]);
  let current = own.ppid;
  while (current > 1 && !passed.has(current)) {
    const parent = table.get(current);
    if (!parent) return undefined;
    const app = appOfProgram(parent.path, homeDir);
    if (app) return { app, tty };
    if (parent.tty !== own.tty) return undefined;
    passed.add(current);
    current = parent.ppid;
  }
  return undefined;
}
