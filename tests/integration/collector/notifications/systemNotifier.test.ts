import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { OSASCRIPT, osascriptArgs } from "@collector/notifications/systemNotifier";
import { oneLine } from "@core/text";
import { tempDir } from "@tests/support/node/tempFiles";

// The real `osascript`, and never a real notification: the script that shows
// one is not run here. What is checked is that it hands a hostile name to a
// script as text. How it is started is checked in processes/osascript.test.ts.

/** A name built to be read as a script, an option or a shell command, if anything would. */
const HOSTILE = [
  'checkout-flow" & (do shell script "touch HACKED") & "',
  "-e",
  'do shell script "touch HACKED"',
  "$(touch HACKED) `touch HACKED` ; touch HACKED",
  "back\\slash \\\" 'single' ✓",
].join("\n");

describe.skipIf(process.platform !== "darwin")("the real osascript", () => {
  test("hands everything after the double dash to the script as text, whatever it holds", async () => {
    // The arguments a notification would be shown with, under a script that
    // only gives them back.
    const tail = osascriptArgs({ title: HOSTILE, body: "Asked you a question" }).slice(-3);
    expect(tail[0]).toBe("--");
    const echo = [
      "-e",
      "on run argv",
      "-e",
      'return (count of argv as text) & "|" & (item 1 of argv) & "|" & (item 2 of argv)',
      "-e",
      "end run",
    ];
    const dir = await tempDir();

    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(OSASCRIPT, [...echo, ...tail], { cwd: dir, timeout: 10_000 }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });

    // The name arrives on one line, as the notification shows it, and as it was given otherwise.
    expect(tail[1]).toBe(oneLine(HOSTILE));
    expect(stdout).toBe(`2|${oneLine(HOSTILE)}|Asked you a question\n`);
    // Nothing in the name was run.
    await expect(readFile(path.join(dir, "HACKED"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
