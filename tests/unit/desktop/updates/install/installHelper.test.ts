import { describe, expect, test } from "vitest";

import {
  HELPER_SCRIPT,
  HELPER_SHELL,
  helperArguments,
  startHelper,
  type InstallPlan,
} from "@desktop/updates/install/installHelper";

const FOLDER =
  "/Users/example/Library/Application Support/Agent Lookout/agent-lookout-update-a1B2c3";

const PLAN: InstallPlan = {
  pid: 4242,
  bundle: "/Applications/Agent Lookout.app",
  replacement: `${FOLDER}/app-d4E5f6/Agent Lookout.app`,
  aside: `${FOLDER}/previous/Agent Lookout.app`,
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

  // What the script does is in the integration test, which runs it.
  test("runs no program but kill, sleep, mv and open", () => {
    const programs = HELPER_SCRIPT.match(/\/(usr\/)?bin\/[a-z]+/g) ?? [];
    expect([...new Set(programs)].sort()).toEqual([
      "/bin/kill",
      "/bin/mv",
      "/bin/sleep",
      "/usr/bin/open",
    ]);
  });

  test.each([
    ["a process ID that is not one", { pid: 0 }],
    ["launchd's process ID", { pid: 1 }],
    ["a relative path", { bundle: "Agent Lookout.app" }],
    ["a path that is not a bundle", { bundle: "/Applications" }],
    ["a path with .. in it", { replacement: `${FOLDER}/../../Agent Lookout.app` }],
    ["a path with a line break", { aside: `${FOLDER}/x\n/Agent Lookout.app` }],
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
