import { describe, expect, test } from "vitest";

import {
  createOpencodeProcessReader,
  OPENCODE_PROGRAM,
  OPENCODE_TABLE_ARGS,
  opencodeInTable,
  opencodeLiveness,
} from "@collector/adapters/opencode/processes";
import { HOME } from "@tests/fixtures/opencode/opencode";

/** What `ps -A -o comm=` prints for these programs, one a line. */
const table = (programs: string[]) => programs.map((program) => `${program}\n`).join("");

describe("opencodeInTable", () => {
  test("finds a program named opencode, by its name alone or a path ending in it", () => {
    expect(OPENCODE_PROGRAM).toBe("opencode");
    for (const program of [
      // Linux prints the name alone, and macOS the first argument as it was given.
      "opencode",
      `${HOME}/.opencode/bin/opencode`,
      "/opt/homebrew/bin/opencode",
      "./opencode",
      "  opencode  ",
    ]) {
      expect(opencodeInTable(table(["/sbin/launchd", program, "/bin/zsh"])), program).toBe(true);
    }
  });

  test("does not take a program of another name for it", () => {
    expect(
      opencodeInTable(
        table([
          "node",
          "bun",
          "opencode.exe",
          "opencode-desktop",
          "OpenCode",
          "/Applications/OpenCode.app/Contents/MacOS/OpenCode",
          `${HOME}/code/opencode/bin/opencode-dev`,
          "opencode run",
          "",
        ]),
      ),
    ).toBe(false);
  });
});

describe("createOpencodeProcessReader", () => {
  /** A stand-in for `ps` that prints this table, and the arguments it was given each time. */
  function standInPs(stdout: string, ok = true) {
    const asked: (readonly string[])[] = [];
    return {
      asked,
      run: async (args: readonly string[]) => {
        asked.push(args);
        return { ok, stdout };
      },
    };
  }

  test("on macOS and Linux asks ps for the name each process gives its program and nothing else", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const ps = standInPs(table(["/sbin/launchd", "opencode"]));
      const reader = createOpencodeProcessReader({ platform, run: ps.run });
      expect(await reader.read(), platform).toEqual({ ok: true, running: true });
      expect(ps.asked).toEqual([["-A", "-o", "comm="]]);
      // No column that holds the rest of a process's arguments is ever asked for.
      expect(ps.asked.flat().join(" ")).not.toMatch(/args|command|ucomm/);
    }
    expect(OPENCODE_TABLE_ARGS).toEqual(["-A", "-o", "comm="]);
  });

  test("with no OpenCode in the table, none runs", async () => {
    const ps = standInPs(table(["/sbin/launchd", "node"]));
    const reader = createOpencodeProcessReader({ platform: "linux", run: ps.run });
    expect(await reader.read()).toEqual({ ok: true, running: false });
  });

  test("when ps fails, or throws, whether OpenCode runs is not known", async () => {
    const failing = standInPs(table(["opencode"]), false);
    expect(
      await createOpencodeProcessReader({ platform: "darwin", run: failing.run }).read(),
    ).toEqual({ ok: false });
    const throwing = createOpencodeProcessReader({
      platform: "linux",
      run: () => {
        throw new Error("ps broke");
      },
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test("on Windows and other systems nothing is run", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      const ps = standInPs(table(["opencode"]));
      const reader = createOpencodeProcessReader({ platform, run: ps.run });
      expect(await reader.read(), platform).toEqual({ ok: false });
      expect(ps.asked).toEqual([]);
    }
  });
});

describe("opencodeLiveness", () => {
  test("every session is open while OpenCode runs, and none is once it does not", () => {
    expect(opencodeLiveness({ ok: true, running: true })).toBe(true);
    // A session written since is not held open: ps is asked again soon after (index.ts).
    expect(opencodeLiveness({ ok: true, running: false })).toBe(false);
  });

  test("is not known when ps could not say", () => {
    expect(opencodeLiveness({ ok: false })).toBe("unknown");
  });
});
