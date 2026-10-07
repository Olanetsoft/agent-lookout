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

describe("findClaudeBinary on macOS and Linux", () => {
  test("AGENT_LOOKOUT_CLAUDE_BIN wins over PATH and the fixed locations", async () => {
    const fake = executables("/opt/tools/claude", "/usr/bin/claude", "/usr/local/bin/claude");
    const result = await findClaudeBinary({
      env: { AGENT_LOOKOUT_CLAUDE_BIN: "/opt/tools/claude", PATH: "/usr/bin" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
      platform: "darwin",
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
      platform: "darwin",
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
      platform: "darwin",
    });
    expect(result).toEqual({ found: true, path: "/second/claude" });
    expect(fake.asked).toEqual(["/first/claude", "/second/claude"]);
  });

  test("without a useful PATH, as in an app opened from the Finder, the fixed locations are tried", async () => {
    for (const location of fixedLocations(HOME, "linux")) {
      const fake = executables(location);
      const result = await findClaudeBinary({
        env: { PATH: "/usr/bin:/bin" },
        homeDir: HOME,
        isExecutable: fake.isExecutable,
        platform: "linux",
      });
      expect(result).toEqual({ found: true, path: location });
    }
    // The Mac's three first, in the order they always had, then the two that
    // are Linux's alone.
    expect(fixedLocations(HOME, "linux")).toEqual([
      "/Users/example/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/Users/example/.npm-global/bin/claude",
      "/usr/bin/claude",
    ]);
  });

  test("a place that is on PATH and is a fixed location too is looked in once, where PATH has it", async () => {
    const fake = executables();
    await findClaudeBinary({
      env: { PATH: "/usr/bin:/usr/local/bin" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
      platform: "darwin",
    });
    expect(fake.asked).toEqual([
      "/usr/bin/claude",
      "/usr/local/bin/claude",
      "/Users/example/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/Users/example/.npm-global/bin/claude",
    ]);
  });

  test("with no PATH at all the fixed locations are still tried", async () => {
    const fake = executables("/opt/homebrew/bin/claude");
    const result = await findClaudeBinary({
      env: {},
      homeDir: HOME,
      isExecutable: fake.isExecutable,
      platform: "darwin",
    });
    expect(result).toEqual({ found: true, path: "/opt/homebrew/bin/claude" });
  });

  test("relative and empty PATH entries are never searched", async () => {
    const fake = executables();
    await findClaudeBinary({
      env: { PATH: ":.:bin:./tools:/opt/tools:" },
      homeDir: HOME,
      isExecutable: fake.isExecutable,
      platform: "darwin",
    });
    expect(fake.asked).toEqual(["/opt/tools/claude", ...fixedLocations(HOME, "linux")]);
  });

  test("when nothing is found, it says where it looked in plain words", async () => {
    const result = await findClaudeBinary({
      env: { PATH: "/usr/bin" },
      homeDir: HOME,
      isExecutable: executables().isExecutable,
      platform: "linux",
    });
    expect(result).toEqual({
      found: false,
      looked:
        "The claude command was not found on PATH or in ~/.local/bin, /opt/homebrew/bin, /usr/local/bin, ~/.npm-global/bin or /usr/bin",
    });
  });
});

describe("findClaudeBinary on Windows", () => {
  const home = "C:\\Users\\example";
  const appData = "C:\\Users\\example\\AppData\\Roaming";
  const npmProgram = "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";

  test("looks on Path for claude.com and claude.exe, then for the program npm's claude.cmd runs, folder by folder", async () => {
    const fake = executables("D:\\npm\\" + npmProgram);
    const result = await findClaudeBinary({
      env: { Path: "C:\\Tools;D:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      homeDir: home,
      isExecutable: fake.isExecutable,
      platform: "win32",
    });
    expect(result).toEqual({ found: true, path: `D:\\npm\\${npmProgram}` });
    expect(fake.asked).toEqual([
      "C:\\Tools\\claude.com",
      "C:\\Tools\\claude.exe",
      `C:\\Tools\\${npmProgram}`,
      "D:\\npm\\claude.com",
      "D:\\npm\\claude.exe",
      `D:\\npm\\${npmProgram}`,
    ]);
  });

  test("a claude.exe in a folder comes before npm's program in the same folder, as a shell would choose", async () => {
    const fake = executables("D:\\npm\\claude.exe", `D:\\npm\\${npmProgram}`);
    const result = await findClaudeBinary({
      env: { PATH: "D:\\npm" },
      homeDir: home,
      isExecutable: fake.isExecutable,
      platform: "win32",
    });
    expect(result).toEqual({ found: true, path: "D:\\npm\\claude.exe" });
  });

  test("then the native installer's place, and then npm's own folder under APPDATA", async () => {
    expect(fixedLocations(home, "win32", { APPDATA: appData })).toEqual([
      "C:\\Users\\example\\.local\\bin\\claude.exe",
      `C:\\Users\\example\\AppData\\Roaming\\npm\\${npmProgram}`,
    ]);
    // With no APPDATA, npm's folder is where Windows keeps APPDATA in the home folder.
    expect(fixedLocations(home, "win32", {})[1]).toBe(
      `C:\\Users\\example\\AppData\\Roaming\\npm\\${npmProgram}`,
    );
    for (const location of fixedLocations(home, "win32", { APPDATA: "E:\\Roaming" })) {
      const fake = executables(location);
      const result = await findClaudeBinary({
        env: { APPDATA: "E:\\Roaming" },
        homeDir: home,
        isExecutable: fake.isExecutable,
        platform: "win32",
      });
      expect(result).toEqual({ found: true, path: location });
    }
  });

  test("AGENT_LOOKOUT_CLAUDE_BIN names a program, and a script named there is refused, as it needs a shell", async () => {
    const named = await findClaudeBinary({
      env: { AGENT_LOOKOUT_CLAUDE_BIN: "D:\\tools\\claude.exe", Path: "C:\\Tools" },
      homeDir: home,
      isExecutable: executables("D:\\tools\\claude.exe", "C:\\Tools\\claude.exe").isExecutable,
      platform: "win32",
    });
    expect(named).toEqual({ found: true, path: "D:\\tools\\claude.exe" });

    for (const script of ["D:\\npm\\claude.cmd", "D:\\npm\\claude.bat", "D:\\npm\\claude.ps1"]) {
      const fake = executables(script, "C:\\Tools\\claude.exe");
      const result = await findClaudeBinary({
        env: { AGENT_LOOKOUT_CLAUDE_BIN: script, Path: "C:\\Tools" },
        homeDir: home,
        isExecutable: async (candidate) =>
          (await fake.isExecutable(candidate)) && !/\.(cmd|bat|ps1)$/.test(candidate),
        platform: "win32",
      });
      expect(result).toEqual({
        found: false,
        looked: `AGENT_LOOKOUT_CLAUDE_BIN is set to ${script}, which is a script that needs a shell to run, and Agent Lookout runs no shell`,
      });
      expect(fake.asked).toEqual([script]);
    }
  });

  test("when nothing is found, it says where it looked, in the home folder's short form", async () => {
    const result = await findClaudeBinary({
      env: { Path: "C:\\Tools", APPDATA: appData },
      homeDir: home,
      isExecutable: executables().isExecutable,
      platform: "win32",
    });
    expect(result).toEqual({
      found: false,
      looked:
        "The claude command, claude.exe, was not found on PATH or in ~/.local/bin or ~/AppData/Roaming/npm",
    });
  });
});
