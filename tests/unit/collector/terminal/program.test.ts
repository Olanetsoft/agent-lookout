import { describe, expect, test } from "vitest";

import {
  createOsascriptRunner,
  TERMINAL_JUMP_ENV,
  terminalJumpOff,
} from "@collector/terminal/program";

describe("terminalJumpOff", () => {
  test("is true only for off, in any case and with spaces around it", () => {
    expect(TERMINAL_JUMP_ENV).toBe("AGENT_LOOKOUT_TERMINAL_JUMP");
    expect(terminalJumpOff({ AGENT_LOOKOUT_TERMINAL_JUMP: "off" })).toBe(true);
    expect(terminalJumpOff({ AGENT_LOOKOUT_TERMINAL_JUMP: " Off " })).toBe(true);
    for (const value of [undefined, "", "on", "0", "false", "no"]) {
      expect(terminalJumpOff({ AGENT_LOOKOUT_TERMINAL_JUMP: value })).toBe(false);
    }
  });
});

describe("createOsascriptRunner", () => {
  // Each of these answers without starting a program, which is what is tested:
  // no test here runs osascript.
  test.each([
    ["AGENT_LOOKOUT_TERMINAL_JUMP is off", { AGENT_LOOKOUT_TERMINAL_JUMP: "off" }, "darwin"],
    ["this is Linux", {}, "linux"],
    ["this is Windows", {}, "win32"],
  ] as const)("starts nothing when %s", async (_what, env, platform) => {
    const run = createOsascriptRunner({ env, platform });
    expect(await run(["-e", "return 1"])).toEqual({ ok: false, stderr: "", timedOut: false });
  });
});
