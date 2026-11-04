import { describe, expect, test } from "vitest";

import {
  createGooseProcessReader,
  GOOSE_TABLE_ARGS,
  gooseInTable,
} from "@collector/adapters/goose/processes";

describe("a table of `ps`", () => {
  test.each([
    ["the command", "launchd\ngoose\nzsh\n"],
    ["a full path to it", "/opt/homebrew/bin/goose\n"],
    ["the desktop app's server", "/Applications/Goose.app/Contents/Resources/bin/goose\n"],
    ["the older server", "/Applications/Goose.app/Contents/Resources/bin/goosed\n"],
    ["the server built for ACP clients", "goose-acp\n"],
    ["a line padded with spaces", "  goose  \n"],
  ])("with %s has a Goose", (_case, stdout) => {
    expect(gooseInTable(stdout)).toBe(true);
  });

  test.each([
    ["none", ""],
    ["another program", "launchd\nzsh\nnode\n"],
    ["the desktop app's window alone", "/Applications/Goose.app/Contents/MacOS/Goose\n"],
    ["a name that only starts the same", "goose-migrate\ngoosefoo\n"],
    ["a folder of the name", "/opt/goose/bin/other\n"],
  ])("with %s has no Goose", (_case, stdout) => {
    expect(gooseInTable(stdout)).toBe(false);
  });
});

describe("asking whether Goose runs", () => {
  test.each(["darwin", "linux"] as const)(
    "on %s asks for each program's name and nothing else",
    async (platform) => {
      const asked: (readonly string[])[] = [];
      const reader = createGooseProcessReader({
        platform,
        run: async (args) => {
          asked.push(args);
          return { ok: true, stdout: "goose\n" };
        },
      });
      expect(await reader.read()).toEqual({ ok: true, running: true });
      expect(asked).toEqual([GOOSE_TABLE_ARGS]);
      expect(GOOSE_TABLE_ARGS).toEqual(["-A", "-o", "comm="]);
    },
  );

  test("says when none runs", async () => {
    const reader = createGooseProcessReader({
      platform: "linux",
      run: async () => ({ ok: true, stdout: "zsh\n" }),
    });
    expect(await reader.read()).toEqual({ ok: true, running: false });
  });

  test("cannot say when `ps` fails or throws", async () => {
    const failing = createGooseProcessReader({
      platform: "darwin",
      run: async () => ({ ok: false, stdout: "goose\n" }),
    });
    expect(await failing.read()).toEqual({ ok: false });
    const throwing = createGooseProcessReader({
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
      let asked = 0;
      const reader = createGooseProcessReader({
        platform,
        run: async () => {
          asked += 1;
          return { ok: true, stdout: "" };
        },
      });
      expect(await reader.read()).toEqual({ ok: false });
      expect(asked).toBe(0);
    },
  );
});
