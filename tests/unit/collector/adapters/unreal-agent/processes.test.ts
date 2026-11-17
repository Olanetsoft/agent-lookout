import { describe, expect, test } from "vitest";

import {
  createUnrealProcessReader,
  noUnrealIn,
  UNREAL_PROGRAMS,
  UNREAL_TABLE_ARGS,
  unrealInTable,
} from "@collector/adapters/unreal-agent/processes";

/** `lstart` as `ps` prints it in UTC, and the time it names. */
const LSTART = "Tue Nov 17 10:58:00 2026";
const STARTED = Date.UTC(2026, 10, 17, 10, 58, 0);

const row = (program: string, lstart = LSTART) => `${lstart} ${program}`;

describe("the table", () => {
  test("is asked for when each process started and its program's name, in UTC", async () => {
    const asked: { args: readonly string[]; options?: { utc?: boolean } }[] = [];
    const reader = createUnrealProcessReader({
      platform: "darwin",
      run: async (args, options) => {
        asked.push({ args, options });
        return { ok: true, stdout: "" };
      },
    });
    expect(await reader.read()).toEqual({ ok: true, starts: [], unknownStart: false });
    expect(asked).toEqual([{ args: ["-A", "-o", "lstart=,comm="], options: { utc: true } }]);
    expect(UNREAL_TABLE_ARGS).toEqual(["-A", "-o", "lstart=,comm="]);
  });

  test("gives the start of each program named as Unreal Agent's, whole or as a path", () => {
    for (const name of UNREAL_PROGRAMS) {
      expect(unrealInTable(row(name)), name).toEqual({ starts: [STARTED], unknownStart: false });
      expect(unrealInTable(row(`/opt/homebrew/bin/${name}`)), name).toEqual({
        starts: [STARTED],
        unknownStart: false,
      });
    }
    expect(unrealInTable(row("/Users/example/My Tools/unreal-agent-runner"))).toEqual({
      starts: [STARTED],
      unknownStart: false,
    });
    // As Linux pads a day, and as the cut names come.
    expect(
      unrealInTable(`  ${"Mon Nov  2 09:00:00 2026"}   unreal-agent-tu\n${row("unreal-agent-ru")}`),
    ).toEqual({
      starts: [Date.UTC(2026, 10, 2, 9, 0, 0), STARTED],
      unknownStart: false,
    });
  });

  test("passes over every other program", () => {
    const table = ["node", "unreal-agent-tuix", "unreal", "uatx", "/usr/bin/zsh", "fx"].map(
      (name) => row(name),
    );
    expect(unrealInTable(table.join("\n"))).toEqual({ starts: [], unknownStart: false });
  });

  test("makes the start unknown for a line that names a program but whose start cannot be read", () => {
    expect(unrealInTable(row("uat", "Tue Foo 17 10:58:00 2026"))).toEqual({
      starts: [],
      unknownStart: true,
    });
    expect(unrealInTable("/usr/local/bin/unreal-agent-tui")).toEqual({
      starts: [],
      unknownStart: true,
    });
    expect(unrealInTable("garbage node")).toEqual({ starts: [], unknownStart: false });
  });

  test("gives only numbers and a flag", async () => {
    const reader = createUnrealProcessReader({
      platform: "linux",
      run: async () => ({
        ok: true,
        stdout: [row("uat"), row("node --secret"), row("unreal-agent-tui")].join("\n"),
      }),
    });
    const answer = await reader.read();
    expect(answer).toEqual({ ok: true, starts: [STARTED, STARTED], unknownStart: false });
    expect(JSON.stringify(answer)).not.toContain("secret");
    expect(noUnrealIn(answer)).toBe(false);
    expect(noUnrealIn({ ok: true, starts: [], unknownStart: false })).toBe(true);
    expect(noUnrealIn({ ok: true, starts: [], unknownStart: true })).toBe(false);
    expect(noUnrealIn({ ok: false })).toBe(false);
  });

  test("says it cannot tell when ps fails or throws", async () => {
    const failing = createUnrealProcessReader({
      platform: "darwin",
      run: async () => ({ ok: false, stdout: row("uat") }),
    });
    expect(await failing.read()).toEqual({ ok: false });
    const throwing = createUnrealProcessReader({
      platform: "darwin",
      run: async () => {
        throw new Error("no ps");
      },
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test("is never asked on Windows or another system", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      let ran = 0;
      const reader = createUnrealProcessReader({
        platform,
        run: async () => {
          ran += 1;
          return { ok: true, stdout: "" };
        },
      });
      expect(await reader.read(), platform).toEqual({ ok: false });
      expect(ran, platform).toBe(0);
    }
  });
});
