import { describe, expect, test } from "vitest";

import { focusOutcomeOf } from "@collector/terminal/focusTab";
import { runOsascriptBinary } from "@collector/terminal/program";

// The real osascript, with scripts that name no app, so nothing here asks
// macOS anything or touches a terminal. What is checked is how the runner
// starts it and reads what it says back.

/** A script that gives back its first argument. */
const ECHO = ["-e", "on run argv", "-e", "return item 1 of argv", "-e", "end run"];

describe.skipIf(process.platform !== "darwin")("runOsascriptBinary with the real osascript", () => {
  test("hands the argument after the double dash to the script", async () => {
    expect(await runOsascriptBinary([...ECHO, "--", "/dev/ttys004"])).toEqual({
      ok: true,
      stdout: "/dev/ttys004\n",
    });
  });

  test("hands an argument shaped like an option to the script as text", async () => {
    expect(await runOsascriptBinary([...ECHO, "--", "-e"])).toEqual({ ok: true, stdout: "-e\n" });
  });

  test("gives back the error macOS gives when it has not allowed control, which reads as not allowed", async () => {
    const result = await runOsascriptBinary([
      "-e",
      'error "Not authorized to send Apple events to the app." number -1743',
    ]);

    expect(result).toMatchObject({ ok: false, timedOut: false });
    expect(result.ok === false && result.stderr).toContain("(-1743)");
    expect(focusOutcomeOf(result)).toEqual({ ok: false, reason: "not-allowed" });
  });

  test("stops a script that takes longer than its time, and says so", async () => {
    const result = await runOsascriptBinary(["-e", "delay 3"], { timeoutMs: 300 });

    expect(result).toEqual({ ok: false, stderr: "", timedOut: true });
    expect(focusOutcomeOf(result)).toEqual({ ok: false, reason: "failed" });
  });
});
