import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { findClaudeBinary, NPM_PROGRAM } from "@collector/adapters/claude-code/findBinary";
import { isExecutableFile } from "@collector/files/paths";
import { HOME } from "@tests/fixtures/claudeCode";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

// The execute bit and the sh stub are POSIX: Windows has neither, and is
// checked on its own below.
describe.skipIf(process.platform === "win32")("on macOS and Linux", () => {
  test("on a real disk, the named binary is found and run-checked for real", async () => {
    const stub = await writeStub("echo '[]'");
    expect(
      await findClaudeBinary({ env: { AGENT_LOOKOUT_CLAUDE_BIN: stub }, homeDir: HOME }),
    ).toEqual({ found: true, path: stub });

    await chmod(stub, 0o644);
    expect(
      await findClaudeBinary({ env: { AGENT_LOOKOUT_CLAUDE_BIN: stub }, homeDir: HOME }),
    ).toMatchObject({ found: false });
  });

  test("isExecutableFile: a file must be executable, must exist and must not be a directory", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "claude");
    await writeFile(file, "#!/bin/sh\necho '[]'\n");

    await chmod(file, 0o644);
    expect(await isExecutableFile(file)).toBe(false);

    await chmod(file, 0o755);
    expect(await isExecutableFile(file)).toBe(true);

    expect(await isExecutableFile(path.join(dir, "missing"))).toBe(false);

    await mkdir(path.join(dir, "folder"));
    expect(await isExecutableFile(path.join(dir, "folder"))).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("on Windows, on a real disk", () => {
  /** Writes a file, and the folders it is in. */
  async function put(file: string, content = ""): Promise<string> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  }

  test("isExecutableFile: a .exe or a .com that is there, and never a script or a folder", async () => {
    const dir = await tempDir();
    expect(await isExecutableFile(await put(path.join(dir, "claude.exe")))).toBe(true);
    expect(await isExecutableFile(await put(path.join(dir, "CLAUDE.COM")))).toBe(true);
    for (const name of ["claude.cmd", "claude.bat", "claude.ps1", "claude"]) {
      expect(await isExecutableFile(await put(path.join(dir, name))), name).toBe(false);
    }
    expect(await isExecutableFile(path.join(dir, "missing.exe"))).toBe(false);
    await mkdir(path.join(dir, "folder.exe"));
    expect(await isExecutableFile(path.join(dir, "folder.exe"))).toBe(false);
  });

  test("a claude.exe on Path is found, wherever it is on Path", async () => {
    const empty = await tempDir();
    const tools = await tempDir();
    const exe = await put(path.join(tools, "claude.exe"));
    const home = await tempDir();
    expect(await findClaudeBinary({ env: { Path: `${empty};${tools}` }, homeDir: home })).toEqual({
      found: true,
      path: exe,
    });
  });

  test("for npm's claude.cmd, the program it runs is found, and the script itself never", async () => {
    const npm = await tempDir();
    await put(path.join(npm, "claude.cmd"), "@echo off\r\n");
    const home = await tempDir();
    const env = { Path: npm, APPDATA: await tempDir() };

    // Only the script, as an install too old to have the program leaves it.
    expect(await findClaudeBinary({ env, homeDir: home })).toEqual({
      found: false,
      looked: expect.stringMatching(/^The claude command, claude\.exe, was not found on PATH/),
    });

    const exe = await put(path.join(npm, ...NPM_PROGRAM));
    expect(await findClaudeBinary({ env, homeDir: home })).toEqual({ found: true, path: exe });
  });

  test("with nothing on Path, the native installer's place and npm's folder are looked in", async () => {
    const home = await tempDir();
    const appData = await tempDir();
    const env = { Path: "", APPDATA: appData };

    const npmExe = await put(path.join(appData, "npm", ...NPM_PROGRAM));
    expect(await findClaudeBinary({ env, homeDir: home })).toEqual({ found: true, path: npmExe });

    // The native installer's comes first.
    const native = await put(path.join(home, ".local", "bin", "claude.exe"));
    expect(await findClaudeBinary({ env, homeDir: home })).toEqual({ found: true, path: native });
  });

  test("AGENT_LOOKOUT_CLAUDE_BIN may name a .exe, and never a script", async () => {
    const dir = await tempDir();
    const exe = await put(path.join(dir, "claude.exe"));
    const script = await put(path.join(dir, "claude.cmd"));
    const home = await tempDir();
    expect(
      await findClaudeBinary({ env: { AGENT_LOOKOUT_CLAUDE_BIN: exe }, homeDir: home }),
    ).toEqual({ found: true, path: exe });
    expect(
      await findClaudeBinary({
        env: { AGENT_LOOKOUT_CLAUDE_BIN: script, Path: dir },
        homeDir: home,
      }),
    ).toEqual({
      found: false,
      looked: `AGENT_LOOKOUT_CLAUDE_BIN is set to ${script}, which is a script that needs a shell to run, and Agent Lookout runs no shell`,
    });
  });
});
