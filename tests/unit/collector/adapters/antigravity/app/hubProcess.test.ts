import { describe, expect, test } from "vitest";

import {
  createHubProcessReader,
  HUB_IN_APP,
  HUB_TABLE_ARGS,
  hubInTable,
  hubLiveness,
} from "@collector/adapters/antigravity/app/hubProcess";
import { HOME, HUB, IDE_SERVER, NOW, programTable, SECOND } from "@tests/fixtures/antigravity";

/** The hub of the app in the person's own `~/Applications`. */
const OWN_HUB = `${HOME}/Applications${HUB_IN_APP}`;

/** The hub of an app opened from Downloads, which macOS runs from a folder of its own (App Translocation). */
const TRANSLOCATED_HUB = `/private/var/folders/ab/demo/T/AppTranslocation/00000000-0000-4000-8000-000000000001/d${HUB_IN_APP}`;

describe("hubInTable", () => {
  test("finds the hub wherever the app is, among other programs", () => {
    expect(HUB).toBe(`/Applications${HUB_IN_APP}`);
    expect(hubInTable(programTable(["/sbin/launchd", HUB, "/bin/zsh"]))).toBe(true);
    for (const hub of [
      OWN_HUB,
      TRANSLOCATED_HUB,
      `/Applications/Utilities${HUB_IN_APP}`,
      `/Volumes/Demo Disk${HUB_IN_APP}`,
    ]) {
      expect(hubInTable(programTable(["/sbin/launchd", hub])), hub).toBe(true);
    }
  });

  test("does not take the Antigravity IDE's language server, or one of the same name at another place, for it", () => {
    expect(
      hubInTable(
        programTable([
          IDE_SERVER,
          "/Applications/Antigravity IDE.app/Contents/Resources/bin/language_server",
          "/Applications/Demo Antigravity.app/Contents/Resources/bin/language_server",
          "/Users/example/code/demo/bin/language_server",
          "language_server",
          HUB_IN_APP.slice(1),
          `${HUB}-helper`,
        ]),
      ),
    ).toBe(false);
  });

  test("takes a line only as a whole path, with nothing more than spaces around it", () => {
    expect(hubInTable(`  ${HUB}  \n`)).toBe(true);
    expect(hubInTable(`${HUB} --standalone\n`)).toBe(false);
    expect(hubInTable("")).toBe(false);
  });
});

describe("createHubProcessReader", () => {
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

  test("on macOS asks ps for the name each process gives its program and nothing else, and says whether the hub runs", async () => {
    const ps = standInPs(programTable(["/sbin/launchd", HUB]));
    const reader = createHubProcessReader({ platform: "darwin", run: ps.run });
    expect(await reader.read()).toEqual({ ok: true, running: true });
    expect(ps.asked).toEqual([["-A", "-o", "comm="]]);
    expect(HUB_TABLE_ARGS).toEqual(["-A", "-o", "comm="]);
    // No column that holds the rest of a process's arguments is ever asked for.
    expect(ps.asked.flat().join(" ")).not.toMatch(/args|command|ucomm/);
  });

  test("with the hub not in the table, it does not run", async () => {
    const ps = standInPs(programTable(["/sbin/launchd", IDE_SERVER]));
    const reader = createHubProcessReader({ platform: "darwin", run: ps.run });
    expect(await reader.read()).toEqual({ ok: true, running: false });
  });

  test("when ps fails, or throws, whether it runs is not known", async () => {
    const failing = standInPs(programTable([HUB]), false);
    expect(await createHubProcessReader({ platform: "darwin", run: failing.run }).read()).toEqual({
      ok: false,
    });
    const throwing = createHubProcessReader({
      platform: "darwin",
      run: () => {
        throw new Error("ps broke");
      },
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test("on Linux and Windows, where the hub is not known yet, nothing is run", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const ps = standInPs(programTable([HUB]));
      const reader = createHubProcessReader({ platform, run: ps.run });
      expect(await reader.read()).toEqual({ ok: false });
      expect(ps.asked).toEqual([]);
    }
  });
});

describe("hubLiveness", () => {
  test("every chat is open while the hub runs", () => {
    expect(hubLiveness({ ok: true, running: true }, NOW, NOW - 60 * SECOND)).toBe(true);
    expect(hubLiveness({ ok: true, running: true }, NOW, null)).toBe(true);
  });

  test("none is once it does not, but one written since ps was asked may be open in an app opened since", () => {
    const closed = { ok: true, running: false } as const;
    expect(hubLiveness(closed, NOW, NOW - SECOND)).toBe(false);
    expect(hubLiveness(closed, NOW, NOW)).toBe(false);
    expect(hubLiveness(closed, NOW, NOW + SECOND)).toBe(true);
    expect(hubLiveness(closed, NOW, null)).toBe(false);
  });

  test("is not known when ps was not asked or could not say", () => {
    expect(hubLiveness(null, null, NOW)).toBe("unknown");
    expect(hubLiveness({ ok: false }, NOW, NOW + SECOND)).toBe("unknown");
  });
});
