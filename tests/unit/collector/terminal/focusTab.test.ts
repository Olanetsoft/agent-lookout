import { describe, expect, test } from "vitest";

import {
  focusOutcomeOf,
  focusTab,
  focusTabArgs,
  ITERM_SCRIPT,
  TERMINAL_SCRIPT,
} from "@collector/terminal/focusTab";
import type { TerminalTab } from "@collector/terminal/terminalTabs";
import {
  fakeOsascript,
  FOUND,
  MISSING,
  NOT_ALLOWED,
  TIMED_OUT,
} from "@tests/support/node/terminal";

const IN_TERMINAL: TerminalTab = { app: "Terminal", tty: "/dev/ttys004" };
const IN_ITERM: TerminalTab = { app: "iTerm2", tty: "/dev/ttys012" };

/** The script lines in a list of arguments, each the one after an `-e`. */
const scriptIn = (args: readonly string[]) =>
  args.flatMap((arg, index) => (index > 0 && args[index - 1] === "-e" ? [arg] : []));

describe("focusTabArgs", () => {
  test("is the app's fixed script, a --, and then the terminal alone", () => {
    for (const [tab, script] of [
      [IN_TERMINAL, TERMINAL_SCRIPT],
      [IN_ITERM, ITERM_SCRIPT],
    ] as const) {
      const args = focusTabArgs(tab) as string[];
      expect(args.slice(-2)).toEqual(["--", tab.tty]);
      expect(args.slice(0, -2)).toEqual(script.flatMap((line) => ["-e", line]));
      expect(scriptIn(args)).toEqual([...script]);
      // The terminal is in no line of the script.
      expect(scriptIn(args).join("\n")).not.toContain(tab.tty);
    }
  });

  test("each script is aimed at its app by its id, reads the terminal from its arguments, and starts no app", () => {
    expect(TERMINAL_SCRIPT).toContain('tell application id "com.apple.Terminal"');
    expect(ITERM_SCRIPT).toContain('tell application id "com.googlecode.iterm2"');
    for (const script of [TERMINAL_SCRIPT, ITERM_SCRIPT]) {
      expect(script[0]).toBe("on run argv");
      expect(script[1]).toBe("set wanted to item 1 of argv");
      // A check that the app is running comes before anything is sent to it.
      expect(script[2]).toMatch(
        /^if not \(application id "[\w.]+" is running\) then return "missing"$/,
      );
      expect(script.join("\n")).not.toMatch(/do shell script|keystroke|write text|do script/);
    }
  });

  test("Terminal's script brings a minimised window back from the Dock before bringing it in front", () => {
    const restore = TERMINAL_SCRIPT.indexOf(
      "if miniaturized of w then set miniaturized of w to false",
    );
    expect(restore).toBeGreaterThan(TERMINAL_SCRIPT.indexOf("set selected of t to true"));
    expect(restore).toBeLessThan(TERMINAL_SCRIPT.indexOf("set index of w to 1"));
  });

  test.each<[string, TerminalTab]>([
    ["a terminal that is not a path", { app: "Terminal", tty: "ttys004" }],
    ["an option", { app: "Terminal", tty: "-e" }],
    ["a script", { app: "Terminal", tty: '/dev/ttys004" then activate' }],
    ["a second line", { app: "Terminal", tty: "/dev/ttys004\n/dev/ttys005" }],
    ["another device", { app: "Terminal", tty: "/dev/console" }],
    ["a path that climbs", { app: "Terminal", tty: "/dev/../dev/ttys004" }],
    ["nothing", { app: "Terminal", tty: "" }],
    ["an app with no script", { app: "Warp" as TerminalTab["app"], tty: "/dev/ttys004" }],
    [
      "a name that is not an app's own",
      { app: "toString" as TerminalTab["app"], tty: "/dev/ttys004" },
    ],
  ])("refuses %s", (_what, tab) => {
    expect(focusTabArgs(tab)).toBeNull();
  });
});

describe("focusOutcomeOf", () => {
  test("found is a tab brought forward", () => {
    expect(focusOutcomeOf(FOUND)).toEqual({ ok: true });
    expect(focusOutcomeOf({ ok: true, stdout: "found" })).toEqual({ ok: true });
  });

  test("missing is a tab that has closed", () => {
    expect(focusOutcomeOf(MISSING)).toEqual({ ok: false, reason: "tab-gone" });
  });

  test("error -1743 is macOS not allowing it", () => {
    expect(focusOutcomeOf(NOT_ALLOWED)).toEqual({ ok: false, reason: "not-allowed" });
    expect(
      focusOutcomeOf({
        ok: false,
        stderr: "41:58: execution error: Not authorized to send Apple events to iTerm. (-1743)",
        timedOut: false,
      }),
    ).toEqual({ ok: false, reason: "not-allowed" });
  });

  test.each([
    ["a run that ran out of time", TIMED_OUT],
    ["a run that ran out of time after saying -1743", { ...NOT_ALLOWED, timedOut: true }],
    [
      "an app that is not running",
      { ok: false, stderr: "execution error: Application isn’t running. (-600)", timedOut: false },
    ],
    [
      "another error",
      { ok: false, stderr: "execution error: Can’t get window 1. (-1728)", timedOut: false },
    ],
    [
      "an error that only mentions the number",
      { ok: false, stderr: "error -17430", timedOut: false },
    ],
    ["a run that never started", { ok: false, stderr: "", timedOut: false }],
    ["an answer the script never gives", { ok: true, stdout: "maybe\n" }],
    ["no answer", { ok: true, stdout: "" }],
  ] as const)("%s is a failure", (_what, result) => {
    expect(focusOutcomeOf(result)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("focusTab", () => {
  test("runs osascript once with the tab's arguments, and says what it came to", async () => {
    const osascript = fakeOsascript(FOUND);
    expect(await focusTab(IN_TERMINAL, osascript.run)).toEqual({ ok: true });
    expect(osascript.ran).toEqual([focusTabArgs(IN_TERMINAL)]);

    osascript.answer = NOT_ALLOWED;
    expect(await focusTab(IN_ITERM, osascript.run)).toEqual({ ok: false, reason: "not-allowed" });
    expect(osascript.ran[1]?.at(-1)).toBe("/dev/ttys012");
  });

  test("runs nothing for a tab whose arguments cannot be built", async () => {
    const osascript = fakeOsascript(FOUND);
    expect(await focusTab({ app: "Terminal", tty: "-e" }, osascript.run)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(osascript.ran).toEqual([]);
  });
});
