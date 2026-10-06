import { describe, expect, test } from "vitest";

import {
  HELPER_SCRIPT,
  HELPER_SHELL,
  helperArguments,
  startHelper,
  type InstallPlan,
} from "@desktop/updates/install/installHelper";

const PLAN: InstallPlan = {
  pid: 4242,
  bundle: "/Applications/Agent Lookout.app",
  replacement: "/private/var/folders/xy/T/agent-lookout-update-abc/app/Agent Lookout.app",
  aside: "/private/var/folders/xy/T/agent-lookout-update-abc/previous/Agent Lookout.app",
};

describe("the helper that replaces the app", () => {
  test("is /bin/sh with a fixed script, and the plan only as arguments", () => {
    expect(HELPER_SHELL).toBe("/bin/sh");
    expect(helperArguments(PLAN)).toEqual([
      "-c",
      HELPER_SCRIPT,
      "agent-lookout-update",
      "4242",
      PLAN.bundle,
      PLAN.replacement,
      PLAN.aside,
    ]);
    // Nothing of the plan is in the script itself.
    expect(HELPER_SCRIPT).not.toContain("Agent Lookout");
    expect(HELPER_SCRIPT).not.toContain("4242");
  });

  test("names every program by its full path, and reads each argument quoted", () => {
    for (const program of ["kill", "sleep", "mv", "open"]) {
      expect(HELPER_SCRIPT).toMatch(new RegExp(`/(usr/)?bin/${program} `));
      expect(HELPER_SCRIPT).not.toMatch(new RegExp(`(^|[\\s;])${program} `, "m"));
    }
    expect(HELPER_SCRIPT).not.toMatch(/\$[1-4](?!")/);
    expect(HELPER_SCRIPT).not.toMatch(/\$(app|new|aside|pid)(?!")/);
    expect(HELPER_SCRIPT).not.toContain("eval");
  });

  test("waits for the app to quit, moves the old bundle aside, moves the new one in and opens it", () => {
    const lines = HELPER_SCRIPT.split("\n").map((line) => line.trim());
    const at = (line: string) => lines.indexOf(line);
    expect(at('while /bin/kill -0 "$pid" 2>/dev/null; do')).toBeGreaterThan(-1);
    expect(at('if /bin/mv "$app" "$aside"; then')).toBeGreaterThan(at("done"));
    expect(at('if /bin/mv "$new" "$app"; then')).toBeGreaterThan(
      at('if /bin/mv "$app" "$aside"; then'),
    );
    // A new bundle that cannot be moved in puts the old one back, and opens that.
    expect(at('/bin/mv "$aside" "$app"')).toBeGreaterThan(at('if /bin/mv "$new" "$app"; then'));
    expect(lines.filter((line) => line === '/usr/bin/open "$app"')).toHaveLength(2);
  });

  test.each([
    ["a process ID that is not one", { pid: 0 }],
    ["launchd's process ID", { pid: 1 }],
    ["a relative path", { bundle: "Agent Lookout.app" }],
    ["a path that is not a bundle", { bundle: "/Applications" }],
    ["a path with .. in it", { replacement: "/private/var/folders/xy/T/../../Agent Lookout.app" }],
    ["a path with a line break", { aside: "/private/var/x\n/Agent Lookout.app" }],
    ["the same path twice", { aside: PLAN.replacement }],
  ])("refuses a plan with %s", (_what, change) => {
    expect(helperArguments({ ...PLAN, ...change })).toBeNull();
  });

  test("starts nothing for a plan it refuses, and starts the shell for one it takes", async () => {
    const started: [string, readonly string[]][] = [];
    const start = async (file: string, args: readonly string[]) => {
      started.push([file, args]);
      return true;
    };
    expect(await startHelper({ ...PLAN, pid: -1 }, start)).toBe(false);
    expect(started).toEqual([]);
    expect(await startHelper(PLAN, start)).toBe(true);
    expect(started).toEqual([["/bin/sh", helperArguments(PLAN)]]);
  });

  test("says so when the helper did not start", async () => {
    expect(await startHelper(PLAN, async () => false)).toBe(false);
    expect(
      await startHelper(PLAN, async () => {
        throw new Error("spawn failed");
      }),
    ).toBe(false);
  });
});
