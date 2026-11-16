import { execFile } from "node:child_process";

import { describe, expect, test, vi } from "vitest";

import {
  createEditorRunner,
  EDITOR_JUMP_ENV,
  editorEnvironment,
  editorJumpOff,
} from "@collector/editor/program";
import { VSCODE_BUNDLE } from "@tests/support/node/terminal";

// No program is started here: a stand-in for Node's execFile records whether
// it was asked to start one, so a runner that should start nothing and does
// fails, here and on a Mac with VS Code in its place alike.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("editorJumpOff", () => {
  test("is true only for off, in any case and with spaces around it", () => {
    expect(EDITOR_JUMP_ENV).toBe("AGENT_LOOKOUT_EDITOR_JUMP");
    expect(editorJumpOff({ AGENT_LOOKOUT_EDITOR_JUMP: "off" })).toBe(true);
    expect(editorJumpOff({ AGENT_LOOKOUT_EDITOR_JUMP: " Off " })).toBe(true);
    for (const value of [undefined, "", "on", "0", "false", "no"]) {
      expect(editorJumpOff({ AGENT_LOOKOUT_EDITOR_JUMP: value })).toBe(false);
    }
  });

  test("is not turned on or off by the setting for Terminal and iTerm2", () => {
    expect(editorJumpOff({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" })).toBe(false);
  });
});

describe("editorEnvironment", () => {
  test("is the collector's own, less Agent Lookout's settings, the editor's and Electron's own, and Node's options", () => {
    expect(
      editorEnvironment({
        PATH: "/usr/bin:/bin",
        HOME: "/Users/example",
        LANG: "en_GB.UTF-8",
        AGENT_LOOKOUT_SMTP_URL: "smtp://user:secret@mail.example",
        agent_lookout_ntfy_token: "tk_example",
        VSCODE_IPC_HOOK_CLI: "/tmp/vscode-ipc-example.sock",
        VSCODE_PID: "800",
        vscode_cwd: "/Users/example",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_NO_ATTACH_CONSOLE: "1",
        NODE_OPTIONS: "--require /tmp/example.js",
        NODE_REPL_EXTERNAL_MODULE: "/tmp/example.js",
        NODE_ENV: "production",
      }),
    ).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/example",
      LANG: "en_GB.UTF-8",
      NODE_ENV: "production",
    });
  });
});

describe("createEditorRunner", () => {
  test.each([
    ["AGENT_LOOKOUT_EDITOR_JUMP is off", { AGENT_LOOKOUT_EDITOR_JUMP: "off" }, "darwin"],
    ["this is Linux", {}, "linux"],
    ["this is Windows", {}, "win32"],
  ] as const)("starts nothing when %s", async (_what, env, platform) => {
    vi.mocked(execFile).mockClear();
    const run = createEditorRunner({ env, platform });
    expect(
      await run(`${VSCODE_BUNDLE}/Contents/Resources/app/bin/code`, [
        "--new-window",
        "/Users/example/code/demo",
      ]),
    ).toEqual({ ok: false, timedOut: false });
    expect(execFile).not.toHaveBeenCalled();
  });

  test("on a Mac with it on, starts the program it is given, with the arguments as they are", async () => {
    vi.mocked(execFile).mockClear();
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      callback(null);
      return { stdin: { end: () => {} } };
    }) as unknown as typeof execFile);
    const program = `${VSCODE_BUNDLE}/Contents/Resources/app/bin/code`;
    const run = createEditorRunner({ env: {}, platform: "darwin" });
    expect(await run(program, ["--new-window", "/Users/example/code/demo"])).toEqual({ ok: true });
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.slice(0, 2)).toEqual([
      program,
      ["--new-window", "/Users/example/code/demo"],
    ]);
  });
});
