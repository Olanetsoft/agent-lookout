import { describe, expect, test } from "vitest";

import { findClaudeBinary, fixedLocations } from "@collector/adapters/claude-code/findBinary";
import { HOME } from "@tests/fixtures/claudeCode";

/** Pretends exactly these paths are runnable, and records every path asked about. */
function executables(...present: string[]) {
  const asked: string[] = [];
  return {
    asked,
    isExecutable: async (candidate: string) => {
      asked.push(candidate);
      return present.includes(candidate);
    },
  };
}

describe("findClaudeBinary", () => {
  test("AGENT_LOOKOUT_CLAUDE_BIN wins over PATH and the fixed locations", async () => {
    const fake = executables("/opt/tools/claude", "/usr/bin/claude", "/usr/local/bin/claude");
    const result = await findClaudeBinary({
      env: { AGENT_LOOKOUT_CLAUDE_BIN: "/opt/tools/claude", PATH: "/usr/bin" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
    });
    expect(result).toEqual({ found: true, path: "/opt/tools/claude" });
    expect(fake.asked).toEqual(["/opt/tools/claude"]);
  });

  test("a named binary that cannot be run is not replaced by another one", async () => {
    const fake = executables("/usr/bin/claude", "/usr/local/bin/claude");
    const result = await findClaudeBinary({
      env: { AGENT_LOOKOUT_CLAUDE_BIN: "/nowhere/claude", PATH: "/usr/bin" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
    });
    expect(result).toEqual({
      found: false,
      looked:
        "AGENT_LOOKOUT_CLAUDE_BIN is set to /nowhere/claude, which is not a program this user can run",
    });
    expect(fake.asked).toEqual(["/nowhere/claude"]);
  });

  test("PATH is searched in order, before the fixed locations", async () => {
    const fake = executables("/second/claude", "/usr/local/bin/claude");
    const result = await findClaudeBinary({
      env: { PATH: "/first:/second:/third" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
    });
    expect(result).toEqual({ found: true, path: "/second/claude" });
    expect(fake.asked).toEqual(["/first/claude", "/second/claude"]);
  });

  test("without a useful PATH, as in an app opened from the Finder, the fixed locations are tried", async () => {
    for (const location of fixedLocations(HOME)) {
      const fake = executables(location);
      const result = await findClaudeBinary({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: HOME,
        isExecutable: fake.isExecutable,
      });
      expect(result).toEqual({ found: true, path: location });
    }
    expect(fixedLocations(HOME)).toEqual([
      "/Users/example/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
  });

  test("with no PATH at all the fixed locations are still tried", async () => {
    const fake = executables("/opt/homebrew/bin/claude");
    const result = await findClaudeBinary({
      env: {},
      homeDir: HOME,
      isExecutable: fake.isExecutable,
    });
    expect(result).toEqual({ found: true, path: "/opt/homebrew/bin/claude" });
  });

  test("relative and empty PATH entries are never searched", async () => {
    const fake = executables();
    await findClaudeBinary({
      env: { PATH: ":.:bin:./tools:/usr/bin:" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
    });
    expect(fake.asked).toEqual(["/usr/bin/claude", ...fixedLocations(HOME)]);
  });

  test("when nothing is found, it says where it looked in plain words", async () => {
    const result = await findClaudeBinary({
      env: { PATH: "/usr/bin" },
      homeDir: HOME,
      isExecutable: executables().isExecutable,
    });
    expect(result).toEqual({
      found: false,
      looked:
        "The claude command was not found on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin",
    });
  });
});
