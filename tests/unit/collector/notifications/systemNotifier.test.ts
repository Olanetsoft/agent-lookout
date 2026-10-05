import { describe, expect, test, vi } from "vitest";

import {
  createSystemNotifier,
  OSASCRIPT,
  osascriptArgs,
  type RunProgram,
} from "@collector/notifications/systemNotifier";

/** The script every notification is shown with. No part of it comes from a session. */
const SCRIPT = [
  "-e",
  "on run argv",
  "-e",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "-e",
  "end run",
];

describe("the arguments osascript is given", () => {
  test("are the fixed script, a double dash, the title and the text", () => {
    expect(osascriptArgs({ title: "checkout-flow", body: "Waiting for permission" })).toEqual([
      ...SCRIPT,
      "--",
      "checkout-flow",
      "Waiting for permission",
    ]);
  });

  test.each([
    ["quotes", "billing-webhooks \"final\" 'draft'"],
    ["backslashes", 'search-indexing\\ \\" \\n'],
    ["newlines and tabs", "docs-site\nsecond line\r\n\tthird"],
    ["AppleScript", 'x" & (do shell script "open -a Calculator") & "'],
    ["a script of its own", 'end run\non run argv\ndo shell script "id"\nend run'],
    ["an option of osascript's", "-e"],
    ["a script behind an option", '-e do shell script "id"'],
    ["a double dash", "--"],
    ["other languages", "mobile-onboarding 日本語 naïve ✓"],
  ])("a name made of %s is one argument, passed on as it is", (_what, name) => {
    const args = osascriptArgs({ title: name, body: "Asked you a question" });

    // The script is the same whatever the name is: the name is no part of it.
    expect(args.slice(0, SCRIPT.length)).toEqual(SCRIPT);
    // Everything after the double dash is an argument to the script, never an option.
    expect(args.slice(SCRIPT.length)).toEqual(["--", name, "Asked you a question"]);
  });

  test("a NUL, which no argument can hold, is taken out", () => {
    const args = osascriptArgs({ title: "infra\0-terraform", body: "Waiting\0 for you" });
    expect(args.slice(-2)).toEqual(["infra-terraform", "Waiting for you"]);
  });
});

describe("the system notifier", () => {
  test("on macOS it runs osascript, by its full path, with those arguments", () => {
    const run = vi.fn<RunProgram>(async () => {});
    const notice = { title: "email-templates", body: "Waiting for you" };

    createSystemNotifier({ platform: "darwin", run }).show(notice);

    expect(run).toHaveBeenCalledExactlyOnceWith("/usr/bin/osascript", osascriptArgs(notice));
    expect(OSASCRIPT).toBe("/usr/bin/osascript");
  });

  test.each(["linux", "win32", "freebsd"] as const)("on %s it runs nothing", (platform) => {
    const run = vi.fn<RunProgram>(async () => {});

    createSystemNotifier({ platform, run }).show({ title: "checkout-flow", body: "Waiting" });

    expect(run).not.toHaveBeenCalled();
  });

  test("when osascript is missing or fails, nothing is thrown and nothing is left unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const missing = Object.assign(new Error("spawn /usr/bin/osascript ENOENT"), { code: "ENOENT" });
    const fails = createSystemNotifier({ platform: "darwin", run: () => Promise.reject(missing) });
    const throws = createSystemNotifier({
      platform: "darwin",
      run: () => {
        throw missing;
      },
    });

    expect(() => fails.show({ title: "checkout-flow", body: "Waiting for you" })).not.toThrow();
    expect(() => throws.show({ title: "checkout-flow", body: "Waiting for you" })).not.toThrow();

    // Long enough for a rejection nobody caught to be reported.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
