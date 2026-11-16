import { describe, expect, test } from "vitest";

import {
  createEditorRunner,
  EDITOR_JUMP_ENV,
  editorEnvironment,
  editorJumpOff,
} from "@collector/editor/program";
import { VSCODE_BUNDLE } from "@tests/support/node/terminal";

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
  // Each of these answers without starting a program, which is what is tested:
  // no test here runs an editor's command.
  test.each([
    ["AGENT_LOOKOUT_EDITOR_JUMP is off", { AGENT_LOOKOUT_EDITOR_JUMP: "off" }, "darwin"],
    ["this is Linux", {}, "linux"],
    ["this is Windows", {}, "win32"],
  ] as const)("starts nothing when %s", async (_what, env, platform) => {
    const run = createEditorRunner({ env, platform });
    expect(
      await run(`${VSCODE_BUNDLE}/Contents/Resources/app/bin/code`, [
        "--new-window",
        "/Users/example/code/demo",
      ]),
    ).toEqual({ ok: false, timedOut: false });
  });
});
