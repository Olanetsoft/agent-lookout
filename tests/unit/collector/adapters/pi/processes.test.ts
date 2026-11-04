import { describe, expect, test } from "vitest";

import { createPiProcessReader, PI_TABLE_ARGS, piInTable } from "@collector/adapters/pi/processes";

describe("a table of `ps`", () => {
  test.each([
    ["the command", "launchd\npi\nzsh\n"],
    ["a full path to it", "/opt/homebrew/bin/pi\n"],
    ["the entry point for RPC", "pi-rpc\n"],
    ["a line padded with spaces", "  pi  \n"],
  ])("with %s has a Pi", (_case, stdout) => {
    expect(piInTable(stdout)).toBe(true);
  });

  test.each([
    ["none", ""],
    ["another program", "launchd\nzsh\nnode\n"],
    ["a name that only starts the same", "pip\npi-update\npiper\n"],
    ["a folder of the name", "/opt/pi/bin/other\n"],
  ])("with %s has no Pi", (_case, stdout) => {
    expect(piInTable(stdout)).toBe(false);
  });
});

describe("asking whether Pi runs", () => {
  test.each(["darwin", "linux"] as const)(
    "on %s asks for each program's name and nothing else",
    async (platform) => {
      const asked: (readonly string[])[] = [];
      const reader = createPiProcessReader({
        platform,
        run: async (args) => {
          asked.push(args);
          return { ok: true, stdout: "pi\n" };
        },
      });
      expect(await reader.read()).toEqual({ ok: true, running: true });
      expect(asked).toEqual([PI_TABLE_ARGS]);
      expect(PI_TABLE_ARGS).toEqual(["-A", "-o", "comm="]);
    },
  );

  test("says when none runs", async () => {
    const reader = createPiProcessReader({
      platform: "linux",
      run: async () => ({ ok: true, stdout: "zsh\n" }),
    });
    expect(await reader.read()).toEqual({ ok: true, running: false });
  });

  test("cannot say when `ps` fails or throws", async () => {
    const failing = createPiProcessReader({
      platform: "darwin",
      run: async () => ({ ok: false, stdout: "pi\n" }),
    });
    expect(await failing.read()).toEqual({ ok: false });
    const throwing = createPiProcessReader({
      platform: "darwin",
      run: async () => {
        throw new Error("A stand-in that throws.");
      },
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test.each(["win32", "freebsd"] as const)(
    "on %s runs nothing and cannot say",
    async (platform) => {
      let ran = false;
      const reader = createPiProcessReader({
        platform,
        run: async () => {
          ran = true;
          return { ok: true, stdout: "pi\n" };
        },
      });
      expect(await reader.read()).toEqual({ ok: false });
      expect(ran).toBe(false);
    },
  );
});
