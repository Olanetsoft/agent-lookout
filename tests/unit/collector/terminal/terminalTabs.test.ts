import { describe, expect, test } from "vitest";

import {
  appOfProgram,
  isTtyPath,
  ITERM_PATH,
  tabOfProcess,
  TERMINAL_PATH,
  ttyPathOf,
} from "@collector/terminal/terminalTabs";
import { HOME } from "@tests/fixtures/claudeCode";
import { inTab, processTable, type ProcessRow } from "@tests/support/node/terminal";

const SERVER = `${HOME}/Library/Application Support/iTerm2/iTermServer-3.6.11`;
const SESSION = 4242;

const tabOf = (rows: readonly ProcessRow[], pid = SESSION) =>
  tabOfProcess(pid, processTable(rows), HOME);

describe("appOfProgram", () => {
  test("knows Terminal, iTerm2 and the server iTerm2 runs its shells under", () => {
    expect(appOfProgram(TERMINAL_PATH, HOME)).toBe("Terminal");
    expect(appOfProgram(ITERM_PATH, HOME)).toBe("iTerm2");
    expect(appOfProgram(SERVER, HOME)).toBe("iTerm2");
    expect(
      appOfProgram(`${HOME}/Library/Application Support/iTerm2/iTermServer-3.5.0beta1`, HOME),
    ).toBe("iTerm2");
  });

  test.each([
    ["Warp", "/Applications/Warp.app/Contents/MacOS/stable"],
    ["Ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
    ["Alacritty", "/Applications/Alacritty.app/Contents/MacOS/alacritty"],
    ["kitty", "/Applications/kitty.app/Contents/MacOS/kitty"],
    ["WezTerm", "/Applications/WezTerm.app/Contents/MacOS/wezterm-gui"],
    [
      "VS Code's terminal",
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
    ],
    ["a program named like Terminal", "Terminal"],
    [
      "Terminal under another folder",
      "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ],
    ["iTerm2 under another folder", "/Users/example/Applications/iTerm.app/Contents/MacOS/iTerm2"],
    [
      "a server in another person's Library",
      "/Users/other/Library/Application Support/iTerm2/iTermServer-3.6.11",
    ],
    [
      "a server in a folder below",
      `${HOME}/Library/Application Support/iTerm2/x/iTermServer-3.6.11`,
    ],
    [
      "another program beside the server",
      `${HOME}/Library/Application Support/iTerm2/iterm2-daemon-1.socket`,
    ],
    [
      "a server with a name that is not a version",
      `${HOME}/Library/Application Support/iTerm2/iTermServer- x`,
    ],
  ])("knows %s as no app it can drive", (_what, program) => {
    expect(appOfProgram(program, HOME)).toBeNull();
  });
});

describe("ttyPathOf and isTtyPath", () => {
  test("a terminal `ps` names becomes its device's path", () => {
    expect(ttyPathOf("ttys004")).toBe("/dev/ttys004");
    expect(ttyPathOf("ttys1234")).toBe("/dev/ttys1234");
    expect(isTtyPath("/dev/ttys004")).toBe(true);
  });

  test.each([
    "??",
    "?",
    "pts/3",
    "",
    "console",
    "ttyp1",
    "ttys",
    "ttys12345",
    "ttys004 ",
    "/dev/ttys004",
    "s004",
    "ttysx",
  ])("%j is no terminal of a tab", (name) => {
    expect(ttyPathOf(name)).toBeNull();
  });

  test.each([
    "/dev/ttys",
    "/dev/tty",
    "/dev/console",
    "/dev/ttys004\n",
    "/dev/ttys004; tell application",
    "-e",
    "ttys004",
    "/dev/../dev/ttys004",
    "/dev/ttys00a",
    42,
    null,
  ])("%j is not the path of one", (value) => {
    expect(isTtyPath(value)).toBe(false);
  });
});

describe("tabOfProcess", () => {
  test("a session under Terminal, through a login, a shell and a wrapper, is in a Terminal tab", () => {
    expect(tabOf(inTab(TERMINAL_PATH, SESSION))).toEqual({ app: "Terminal", tty: "/dev/ttys004" });
  });

  test("a session under iTerm2 is in an iTerm2 tab, whether its shell is iTerm2's own or its server's", () => {
    expect(tabOf(inTab(ITERM_PATH, SESSION, "ttys007"))).toEqual({
      app: "iTerm2",
      tty: "/dev/ttys007",
    });
    // The server's parent is iTerm2, under whatever name it was installed, or
    // the system once iTerm2 has restarted.
    const viaServer: ProcessRow[] = [
      [655, 1, "??", "/Applications/iTerm 2.app/Contents/MacOS/iTerm2"],
      [1302, 655, "??", SERVER],
      [4301, 1302, "ttys000", "/usr/bin/login"],
      [4302, 4301, "ttys000", "-zsh"],
      [SESSION, 4302, "ttys000", "claude"],
    ];
    expect(tabOf(viaServer)).toEqual({ app: "iTerm2", tty: "/dev/ttys000" });
    expect(tabOf(inTab(SERVER, SESSION, "ttys000", 1302))).toEqual({
      app: "iTerm2",
      tty: "/dev/ttys000",
    });
  });

  test("the session's own terminal is the one kept, and nothing else of the walk", () => {
    const tab = tabOf(inTab(TERMINAL_PATH, SESSION, "ttys012"));
    expect(Object.keys(tab ?? {}).sort()).toEqual(["app", "tty"]);
    expect(tab?.tty).toBe("/dev/ttys012");
  });

  test.each([
    ["Warp", "/Applications/Warp.app/Contents/MacOS/stable"],
    ["Ghostty", "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
    [
      "VS Code",
      "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper",
    ],
  ])("a session under %s is in no tab Agent Lookout can drive", (_app, program) => {
    expect(tabOf(inTab(program, SESSION))).toBeUndefined();
  });

  test("a session in a Linux terminal, as the ps of Linux lists it, is in no tab", () => {
    const rows: ProcessRow[] = [
      [2301, 1, "?", "gnome-terminal-"],
      [2318, 2301, "pts/3", "bash"],
      [SESSION, 2318, "pts/3", "claude"],
    ];
    expect(tabOf(rows)).toBeUndefined();
  });

  test("a session in another app's terminal started from a Terminal tab is not in that tab", () => {
    // Terminal, its shell, Ghostty started from that shell, and the session in Ghostty.
    const rows: ProcessRow[] = [
      [600, 1, "??", TERMINAL_PATH],
      [601, 600, "ttys001", "/usr/bin/login"],
      [602, 601, "ttys001", "-zsh"],
      [700, 602, "ttys001", "/Applications/Ghostty.app/Contents/MacOS/ghostty"],
      [701, 700, "ttys009", "-zsh"],
      [SESSION, 701, "ttys009", "claude"],
    ];
    expect(tabOf(rows)).toBeUndefined();
  });

  test("a session in tmux, inside a Terminal tab or not, is left to tmux", () => {
    const rows: ProcessRow[] = [
      ...inTab(TERMINAL_PATH, 300, "ttys001"),
      [800, 1, "??", "tmux"],
      [801, 800, "ttys020", "-zsh"],
      [SESSION, 801, "ttys020", "claude"],
    ];
    expect(tabOf(rows)).toBeUndefined();
  });

  test("a session whose terminal is not a tab's, or that has none, is in no tab", () => {
    const rows = inTab(TERMINAL_PATH, SESSION);
    const withTty = (tty: string) =>
      rows.map(([pid, ppid, own, path]): ProcessRow => [
        pid,
        ppid,
        pid === SESSION ? tty : own,
        path,
      ]);

    expect(tabOf(withTty("??"))).toBeUndefined();
    expect(tabOf(withTty("console"))).toBeUndefined();
    expect(tabOf(withTty("ttys004; activate"))).toBeUndefined();
    // On another terminal than its shell's, it was given that terminal by something else.
    expect(tabOf(withTty("ttys005"))).toBeUndefined();
  });

  test("a walk through a loop, a missing parent or the first process ends with no tab", () => {
    expect(
      tabOf([
        [SESSION, 501, "ttys004", "claude"],
        [501, 502, "ttys004", "-zsh"],
        [502, 501, "ttys004", "/usr/bin/login"],
      ]),
    ).toBeUndefined();
    expect(tabOf([[SESSION, SESSION, "ttys004", "claude"]])).toBeUndefined();
    expect(tabOf([[SESSION, 501, "ttys004", "claude"]])).toBeUndefined();
    expect(
      tabOf([
        [1, 0, "??", "/sbin/launchd"],
        [SESSION, 1, "ttys004", "claude"],
      ]),
    ).toBeUndefined();
  });

  test("a process `ps` did not list is in no tab", () => {
    expect(tabOf(inTab(TERMINAL_PATH, SESSION), 9999)).toBeUndefined();
  });
});
