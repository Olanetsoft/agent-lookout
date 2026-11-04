import { describe, expect, test } from "vitest";

import {
  createCrushProcessReader,
  CRUSH_TABLE_ARGS,
  crushInTable,
} from "@collector/adapters/crush/processes";

describe("crushInTable", () => {
  test.each([
    ["its name, as on Linux", "launchd\ncrush\nzsh\n"],
    ["a path ending in it, as on macOS", "/sbin/launchd\n/opt/homebrew/bin/crush\n"],
    ["with spaces round it", "  crush  \n"],
  ])("finds %s", (_name, stdout) => {
    expect(crushInTable(stdout)).toBe(true);
  });

  test.each([
    ["nothing", ""],
    ["other programs", "launchd\nzsh\nnode\n"],
    ["a program whose name holds it", "pngcrush\ncrush-helper\nmycrush\n"],
    ["a folder named for it", "/opt/crush/bin/node\n"],
    ["its name in capitals", "Crush\n"],
  ])("does not take %s for it", (_name, stdout) => {
    expect(crushInTable(stdout)).toBe(false);
  });
});

describe("createCrushProcessReader", () => {
  test("asks for the name of each process's program and nothing else", async () => {
    const asked: (readonly string[])[] = [];
    const reader = createCrushProcessReader({
      platform: "linux",
      run: async (args) => {
        asked.push(args);
        return { ok: true, stdout: "crush\n" };
      },
    });
    expect(await reader.read()).toEqual({ ok: true, running: true });
    expect(asked).toEqual([CRUSH_TABLE_ARGS]);
    expect(CRUSH_TABLE_ARGS).toEqual(["-A", "-o", "comm="]);
  });

  test("says none runs when ps lists no Crush", async () => {
    const reader = createCrushProcessReader({
      platform: "darwin",
      run: async () => ({ ok: true, stdout: "launchd\n" }),
    });
    expect(await reader.read()).toEqual({ ok: true, running: false });
  });

  test("cannot say when ps does not answer, or throws", async () => {
    const failing = createCrushProcessReader({
      platform: "darwin",
      run: async () => ({ ok: false, stdout: "" }),
    });
    const throwing = createCrushProcessReader({
      platform: "darwin",
      run: async () => {
        throw new Error("No ps.");
      },
    });
    expect(await failing.read()).toEqual({ ok: false });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test.each(["win32", "freebsd"] as const)("runs nothing on %s", async (platform) => {
    let ran = false;
    const reader = createCrushProcessReader({
      platform,
      run: async () => {
        ran = true;
        return { ok: true, stdout: "crush\n" };
      },
    });
    expect(await reader.read()).toEqual({ ok: false });
    expect(ran).toBe(false);
  });
});
