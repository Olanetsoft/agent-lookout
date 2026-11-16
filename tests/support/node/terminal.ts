// Stand-ins for a person's Terminal, iTerm2 and VS Code. `fakeOsascript` runs
// nothing: it writes down each run's arguments and answers as osascript would.
// `fakeEditor` runs nothing either: it writes down each run of an editor's
// command. `processTable` is a table of processes as `ps` would print it, so a
// test chooses which app a session seems to run in, and `inEditor` lists a
// session of the VS Code extension under VS Code. No test asks, or changes, the
// terminal or the editor a person is using, and no test runs an editor's own
// command.

import type { EditorResult, RunEditor } from "@collector/editor/program";
import type { ProcessFacts, ReadProcessTable } from "@collector/processes/processTable";
import type { OsascriptResult, RunOsascript } from "@collector/terminal/program";
import { ITERM_PATH, TERMINAL_PATH } from "@collector/terminal/terminalTabs";

export { ITERM_PATH, TERMINAL_PATH };

/** What a card says `ps` is run with, to find a session's tab. */
export const TAB_CHECK = "ps -A -o pid=,ppid=,tty=,comm=";

/** How often it says that runs, once it has been asked for one of the card's sessions. */
export const TAB_CHECK_RUN = "once for each new process, every 5 seconds at most";

export interface FakeOsascript {
  run: RunOsascript;
  /** Every run, in order, as its arguments. */
  ran: string[][];
  /** What each run answers until a test changes it. */
  answer: OsascriptResult;
  /** While set, a run answers only once this has settled, as one does while macOS asks the person. */
  holdUntil: Promise<unknown> | null;
}

/** What osascript prints when the script found the tab, and when it found none. */
export const FOUND: OsascriptResult = { ok: true, stdout: "found\n" };
export const MISSING: OsascriptResult = { ok: true, stdout: "missing\n" };

/** What osascript says when macOS has not allowed it to control the app. */
export const NOT_ALLOWED: OsascriptResult = {
  ok: false,
  stderr: "execution error: Not authorized to send Apple events to Terminal. (-1743)",
  timedOut: false,
};

/** A run stopped for taking too long, as while a question from macOS goes unanswered. */
export const TIMED_OUT: OsascriptResult = { ok: false, stderr: "", timedOut: true };

export function fakeOsascript(answer: OsascriptResult = FOUND): FakeOsascript {
  const fake: FakeOsascript = {
    ran: [],
    answer,
    holdUntil: null,
    run: async (args) => {
      fake.ran.push([...args]);
      if (fake.holdUntil !== null) await fake.holdUntil;
      return fake.answer;
    },
  };
  return fake;
}

/** One process: its pid, its parent's, its terminal as `ps` names it, and its program. */
export type ProcessRow = [pid: number, ppid: number, tty: string, path: string];

/** A table of processes from rows. */
export function processTable(rows: readonly ProcessRow[]): Map<number, ProcessFacts> {
  return new Map(rows.map(([pid, ppid, tty, path]) => [pid, { ppid, tty, path }]));
}

export interface FakeProcesses {
  /** Reads the table, as `ps` would. */
  read: ReadProcessTable;
  /** How often it was read. */
  runs: number;
  /** What it lists until a test changes it. */
  rows: ProcessRow[];
  /** Set, and every read fails. */
  fails: boolean;
}

/** A reader of a table of processes that counts how often it is asked. */
export function fakeProcesses(rows: readonly ProcessRow[] = []): FakeProcesses {
  const ps: FakeProcesses = {
    runs: 0,
    rows: [...rows],
    fails: false,
    read: async () => {
      ps.runs += 1;
      if (ps.fails) throw new Error("ps could not be run");
      return processTable(ps.rows);
    },
  };
  return ps;
}

/**
 * A session's process in a tab of the app: the app, a login on the tab's
 * terminal, a shell and a wrapper on it too, and the session.
 */
export function inTab(app: string, session: number, tty = "ttys004", appPid = 600): ProcessRow[] {
  const base = session * 10;
  return [
    [appPid, 1, "??", app],
    [base + 1, appPid, tty, "/usr/bin/login"],
    [base + 2, base + 1, tty, "-zsh"],
    [base + 3, base + 2, tty, "node"],
    [session, base + 3, tty, "claude"],
  ];
}

export interface FakeEditor {
  run: RunEditor;
  /** Every run, in order, as the program and then its arguments. */
  ran: string[][];
  /** What each run answers until a test changes it. */
  answer: EditorResult;
}

/** What an editor's command answers when it handed the folder on, and when it failed. */
export const EDITOR_OPENED: EditorResult = { ok: true };
export const EDITOR_FAILED: EditorResult = { ok: false, timedOut: false };

export function fakeEditor(answer: EditorResult = EDITOR_OPENED): FakeEditor {
  const fake: FakeEditor = {
    ran: [],
    answer,
    run: async (program, args) => {
      fake.ran.push([program, ...args]);
      return fake.answer;
    },
  };
  return fake;
}

/** Where VS Code's app is when it is installed the usual way. */
export const VSCODE_BUNDLE = "/Applications/Visual Studio Code.app";

/**
 * A session of Claude Code's VS Code extension under the editor whose bundle is
 * given: the editor's own program, its extension host, which is a helper app
 * inside its bundle, and the session, none of them on a terminal.
 */
export function inEditor(
  bundle: string,
  session: number,
  hostPid = 900,
  mainPid = 800,
): ProcessRow[] {
  return [
    [mainPid, 1, "??", `${bundle}/Contents/MacOS/Code`],
    [
      hostPid,
      mainPid,
      "??",
      `${bundle}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`,
    ],
    [
      session,
      hostPid,
      "??",
      "/Users/example/.vscode/extensions/anthropic.claude-code-2.1.0-darwin-arm64/resources/native-binary/claude",
    ],
  ];
}
