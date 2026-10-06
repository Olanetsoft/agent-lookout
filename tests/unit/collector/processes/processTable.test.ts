import { describe, expect, test } from "vitest";

import { parentsIn, parseProcessTable, PS_TABLE_ARGS } from "@collector/processes/processTable";

describe("PS_TABLE_ARGS", () => {
  test("asks for every process's id, its parent's, its terminal and its program, and nothing else", () => {
    expect(PS_TABLE_ARGS).toEqual(["-A", "-o", "pid=,ppid=,tty=,comm="]);
  });
});

describe("parseProcessTable", () => {
  test("reads the ps of macOS: each line a process, its parent, its terminal and its program's path, whatever the padding", () => {
    const stdout = [
      "    1     0 ??       /sbin/launchd",
      "  657     1 ??       /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      " 4301   657 ttys004  /usr/bin/login",
      " 4302  4301 ttys004  -zsh",
      "54321  4302 ttys004  claude  ",
    ].join("\n");

    expect([...parseProcessTable(stdout)]).toEqual([
      [1, { ppid: 0, tty: "??", path: "/sbin/launchd" }],
      [
        657,
        {
          ppid: 1,
          tty: "??",
          path: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
        },
      ],
      [4301, { ppid: 657, tty: "ttys004", path: "/usr/bin/login" }],
      [4302, { ppid: 4301, tty: "ttys004", path: "-zsh" }],
      [54321, { ppid: 4302, tty: "ttys004", path: "claude" }],
    ]);
  });

  test("reads the ps of Linux, procps, which names terminals pts/3 and no terminal ?, and gives a program's short name", () => {
    const stdout = [
      "      1       0 ?        systemd",
      "      2       0 ?        kthreadd",
      "    812       2 ?        kworker/0:1H-kblockd",
      "   2301       1 ?        gnome-terminal-",
      "   2318    2301 pts/3    bash",
      "4194303    2318 pts/3    claude",
      "   2400       1 ?        tmux: server",
    ].join("\n");

    expect([...parseProcessTable(stdout)]).toEqual([
      [1, { ppid: 0, tty: "?", path: "systemd" }],
      [2, { ppid: 0, tty: "?", path: "kthreadd" }],
      [812, { ppid: 2, tty: "?", path: "kworker/0:1H-kblockd" }],
      [2301, { ppid: 1, tty: "?", path: "gnome-terminal-" }],
      [2318, { ppid: 2301, tty: "pts/3", path: "bash" }],
      [4194303, { ppid: 2318, tty: "pts/3", path: "claude" }],
      [2400, { ppid: 1, tty: "?", path: "tmux: server" }],
    ]);
  });

  test("a program's path may hold spaces, since it comes last", () => {
    const stdout =
      " 1302   655 ??       /Users/example/Library/Application Support/iTerm2/iTermServer-3.6.11\n" +
      "18499 18489 ttys000  npm exec docs-site\n";

    expect(parseProcessTable(stdout).get(1302)?.path).toBe(
      "/Users/example/Library/Application Support/iTerm2/iTermServer-3.6.11",
    );
    expect(parseProcessTable(stdout).get(18499)?.path).toBe("npm exec docs-site");
  });

  test("a line that is not in that shape is left out", () => {
    const stdout = [
      "  PID  PPID TTY      COMM",
      "",
      "4301",
      "4301 657",
      "4301 657 ttys004",
      "abc 1 ?? /bin/zsh",
      "4302 -1 ttys004 /bin/zsh",
      " 4303  657 ttys005  /bin/zsh",
    ].join("\n");

    expect([...parseProcessTable(stdout).keys()]).toEqual([4303]);
  });

  test("nothing printed is an empty table", () => {
    expect(parseProcessTable("").size).toBe(0);
  });
});

describe("parentsIn", () => {
  test("is each process's parent, as the tmux pane finder reads it from a table a test hands in", () => {
    const table = parseProcessTable(
      "  600     1 ??       /Applications/Terminal\n 6001   600 ttys004  -zsh\n",
    );
    expect([...parentsIn(table)]).toEqual([
      [600, 1],
      [6001, 600],
    ]);
  });
});
