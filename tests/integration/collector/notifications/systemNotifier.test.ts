import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  createSystemNotifier,
  OSASCRIPT,
  osascriptArgs,
  runDirectly,
} from "@collector/notifications/systemNotifier";
import { tempDir } from "@tests/support/node/tempFiles";

// Real programs, and never a real notification: the script that shows one is
// not run here. What is checked is how a program is started, and that the real
// `osascript` hands a hostile name to a script as text.

/** A name built to be read as a script, an option or a shell command, if anything would. */
const HOSTILE = [
  'checkout-flow" & (do shell script "touch HACKED") & "',
  "-e",
  'do shell script "touch HACKED"',
  "$(touch HACKED) `touch HACKED` ; touch HACKED",
  "back\\slash \\\" 'single' ✓",
].join("\n");

describe("starting a program", () => {
  test("it is started directly, and each argument reaches it as it was given", async () => {
    const dir = await tempDir();
    const out = path.join(dir, "argv.json");
    const script =
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))";

    await runDirectly(process.execPath, ["-e", script, "--", out, HOSTILE, "Waiting for you"]);

    expect(JSON.parse(await readFile(out, "utf8"))).toEqual([HOSTILE, "Waiting for you"]);
  });

  test("a program that fails, or is not there, is a rejection and never a throw", async () => {
    await expect(runDirectly(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow();
    await expect(runDirectly("/nowhere/osascript", [])).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a notifier whose program is not there shows nothing and says nothing", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const notifier = createSystemNotifier({
      platform: "darwin",
      run: (_file, args) => runDirectly("/nowhere/osascript", args),
    });

    expect(() => notifier.show({ title: "checkout-flow", body: "Waiting for you" })).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 100));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

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

    expect(stdout).toBe(`2|${HOSTILE}|Asked you a question\n`);
    // Nothing in the name was run.
    await expect(readFile(path.join(dir, "HACKED"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
