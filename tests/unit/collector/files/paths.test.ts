import { describe, expect, test } from "vitest";

import {
  isWindowsProgram,
  pathCandidates,
  pathFolders,
  programNames,
  tildify,
  variable,
} from "@collector/files/paths";
import { HOME } from "@tests/fixtures/claudeCode";

describe("tildify", () => {
  test("shortens paths under the home directory and leaves others alone", () => {
    expect(tildify("/Users/example/.claude/sessions", HOME, "darwin")).toBe("~/.claude/sessions");
    expect(tildify(HOME, HOME, "darwin")).toBe("~");
    expect(tildify("/Users/example-other/.claude", HOME, "darwin")).toBe(
      "/Users/example-other/.claude",
    );
    expect(tildify("/opt/homebrew/bin", HOME, "linux")).toBe("/opt/homebrew/bin");
    expect(tildify("/opt/homebrew/bin", "", "linux")).toBe("/opt/homebrew/bin");
    expect(tildify("/opt/homebrew/bin", "/", "linux")).toBe("/opt/homebrew/bin");
  });

  test("on Windows, writes a path under the home folder with / as on other systems, whatever its case", () => {
    const home = "C:\\Users\\example";
    expect(tildify("C:\\Users\\example\\.claude\\sessions", home, "win32")).toBe(
      "~/.claude/sessions",
    );
    expect(tildify("c:\\users\\EXAMPLE\\.codex", home, "win32")).toBe("~/.codex");
    expect(tildify("C:\\Users\\example\\", home, "win32")).toBe("~");
    expect(tildify("C:\\Users\\example-other\\.claude", home, "win32")).toBe(
      "C:\\Users\\example-other\\.claude",
    );
    expect(tildify("D:\\Users\\example\\.claude", home, "win32")).toBe(
      "D:\\Users\\example\\.claude",
    );
    expect(tildify("C:\\Users", home, "win32")).toBe("C:\\Users");
    // A home folder that is a drive's root would make every path on it short.
    expect(tildify("C:\\tools\\claude.exe", "C:\\", "win32")).toBe("C:\\tools\\claude.exe");
  });
});

describe("pathCandidates", () => {
  test("names the program in each absolute PATH folder, in order, and skips relative ones", () => {
    expect(pathCandidates({ PATH: "/usr/bin:bin::/opt/homebrew/bin" }, "tmux", "darwin")).toEqual([
      "/usr/bin/tmux",
      "/opt/homebrew/bin/tmux",
    ]);
    expect(pathCandidates({}, "claude", "linux")).toEqual([]);
  });

  test("on Windows, reads Path whatever its case, splits it at ; and tries .com and .exe in the order PATHEXT gives", () => {
    const env = {
      Path: 'C:\\Tools;bin;;"C:\\Program Files\\Git\\cmd";D:\\npm',
      PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
    };
    expect(pathFolders(env, "win32")).toEqual([
      "C:\\Tools",
      "C:\\Program Files\\Git\\cmd",
      "D:\\npm",
    ]);
    expect(pathCandidates(env, "gh", "win32")).toEqual([
      "C:\\Tools\\gh.com",
      "C:\\Tools\\gh.exe",
      "C:\\Program Files\\Git\\cmd\\gh.com",
      "C:\\Program Files\\Git\\cmd\\gh.exe",
      "D:\\npm\\gh.com",
      "D:\\npm\\gh.exe",
    ]);
    // A .cmd or a .bat is a script that only a shell runs, so it is never tried.
    expect(programNames({ PATHEXT: ".CMD;.EXE;.BAT" }, "claude", "win32")).toEqual(["claude.exe"]);
    // With no PATHEXT, the two Windows starts by itself.
    expect(programNames({}, "ssh", "win32")).toEqual(["ssh.com", "ssh.exe"]);
    // A name that already ends as a program is tried as it is.
    expect(programNames({}, "tmux.exe", "win32")).toEqual(["tmux.exe"]);
    expect(programNames({}, "tmux", "linux")).toEqual(["tmux"]);
  });

  test("a variable is read as named, and on Windows whatever its case", () => {
    expect(variable({ Path: "C:\\x" }, "PATH", "win32")).toBe("C:\\x");
    expect(variable({ PATH: "C:\\y", Path: "C:\\x" }, "PATH", "win32")).toBe("C:\\y");
    expect(variable({ Path: "/usr/bin" }, "PATH", "linux")).toBeUndefined();
  });

  test("on Windows only a .exe or a .com is a program", () => {
    expect(isWindowsProgram("C:\\Tools\\claude.exe")).toBe(true);
    expect(isWindowsProgram("C:\\Tools\\CLAUDE.EXE")).toBe(true);
    expect(isWindowsProgram("C:\\Tools\\claude.com")).toBe(true);
    for (const file of ["claude.cmd", "claude.bat", "claude.ps1", "claude", "claude.exe.txt"]) {
      expect(isWindowsProgram(`C:\\Tools\\${file}`), file).toBe(false);
    }
  });
});
