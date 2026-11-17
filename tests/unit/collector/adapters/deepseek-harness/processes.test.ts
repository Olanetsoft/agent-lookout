import { describe, expect, test } from "vitest";

import {
  createDshProcessReader,
  DSH_TABLE_ARGS,
  dshInTable,
  dshWriter,
  usable,
  type DshPrograms,
} from "@collector/adapters/deepseek-harness/processes";
import { MINUTE, NOW, SECOND } from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  OWN_PID,
  psLine,
  standInPs,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";

const WRITTEN = NOW - 5 * MINUTE;

const table = (...lines: string[]): DshPrograms =>
  dshInTable([psLine(OWN_PID, NOW - 10 * MINUTE, "node"), ...lines].join("\n"), OWN_PID);

const writer = (answer: DshPrograms | null, extra: Partial<Parameters<typeof dshWriter>[0]> = {}) =>
  dshWriter({
    platform: "darwin",
    writtenAt: WRITTEN,
    bootAt: NOW - 24 * 60 * MINUTE,
    answer,
    answerAt: NOW,
    ...extra,
  });

describe("what ps shows", () => {
  test("is asked for each process's ID, when it started and its program's name, in UTC, and nothing else", async () => {
    const ps = standInPs();
    await createDshProcessReader({ platform: "linux", run: ps.run, ownPid: OWN_PID }).read();
    expect(ps.runs).toEqual([{ args: ["-A", "-o", "pid=,lstart=,comm="], options: { utc: true } }]);
    expect(DSH_TABLE_ARGS).toEqual(["-A", "-o", "pid=,lstart=,comm="]);
  });

  test("is never asked on Windows, or on another system", async () => {
    for (const platform of ["win32", "freebsd"] as const) {
      const ps = standInPs();
      expect(
        await createDshProcessReader({ platform, run: ps.run, ownPid: OWN_PID }).read(),
      ).toEqual({ ok: false });
      expect(ps.runs).toEqual([]);
    }
  });

  test("that failed, or threw, is no answer", async () => {
    const ps = standInPs();
    ps.fail();
    expect(
      await createDshProcessReader({ platform: "darwin", run: ps.run, ownPid: OWN_PID }).read(),
    ).toEqual({
      ok: false,
    });
    const throwing = createDshProcessReader({
      platform: "darwin",
      run: () => Promise.reject(new Error("no")),
      ownPid: OWN_PID,
    });
    expect(await throwing.read()).toEqual({ ok: false });
  });

  test("keeps, of each node, nodejs and DeepSeek Harness program, when it started and whether it is the desktop app", () => {
    const started = NOW - 30 * MINUTE;
    expect(
      table(
        psLine(11, started, "node"),
        psLine(12, started, "/usr/local/bin/nodejs"),
        psLine(13, started, "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"),
        psLine(14, started, "@deepseek-aidsh-desktop"),
        psLine(15, started, "@deepseek-aidsh"),
        psLine(
          16,
          started,
          "/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper",
        ),
        psLine(17, started, "bash"),
        psLine(18, started, "node-gyp"),
      ),
    ).toEqual({
      ok: true,
      ownListed: true,
      programs: [
        { start: Math.floor(started / 1000) * 1000, desktop: false },
        { start: Math.floor(started / 1000) * 1000, desktop: false },
        { start: Math.floor(started / 1000) * 1000, desktop: true },
        { start: Math.floor(started / 1000) * 1000, desktop: true },
        { start: Math.floor(started / 1000) * 1000, desktop: true },
      ],
    });
  });

  test("leaves Agent Lookout's own process out, and says whether it was listed", () => {
    expect(dshInTable(psLine(OWN_PID, NOW, "node"), OWN_PID)).toEqual({
      ok: true,
      ownListed: true,
      programs: [],
    });
    expect(dshInTable(psLine(7, NOW, "node"), OWN_PID)).toMatchObject({ ownListed: false });
  });

  test("passes over lines not in the table's shape, and an empty table lists nothing", () => {
    expect(dshInTable("", OWN_PID)).toEqual({ ok: true, ownListed: false, programs: [] });
    expect(dshInTable("garbage node\n12 node\n  \n", OWN_PID)).toMatchObject({ programs: [] });
  });

  test("keeps a start it cannot read as none", () => {
    expect(dshInTable("  12 Foo Bar 17 10:00:00 2026 node", OWN_PID)).toMatchObject({
      programs: [{ start: null, desktop: false }],
    });
  });
});

describe("whether a program that could write a session may still run", () => {
  test("none could when every one started more than a minute after its last write", () => {
    expect(writer(table())).toBe("gone");
    expect(writer(table(psLine(11, WRITTEN + 61 * SECOND, "node")))).toBe("gone");
  });

  test("one may when one started before it, or within a minute after", () => {
    expect(writer(table(psLine(11, WRITTEN - MINUTE, "node")))).toBe("maybe");
    expect(writer(table(psLine(11, WRITTEN + 30 * SECOND, "node")))).toBe("maybe");
    expect(
      writer(
        dshInTable(`${psLine(OWN_PID, NOW, "node")}\n  12 Foo Bar 17 10:00:00 2026 node`, OWN_PID),
      ),
    ).toBe("maybe");
  });

  test("Agent Lookout's own node, which started before the write, is not one", () => {
    expect(writer(dshInTable(psLine(OWN_PID, WRITTEN - 60 * MINUTE, "node"), OWN_PID))).toBe(
      "gone",
    );
  });

  test("a node that is Agent Lookout's parent's parent, as npx runs it, still may be one", () => {
    // Only Agent Lookout's own process is left out: one it was started by is as likely DeepSeek Harness's.
    expect(
      writer(
        table(
          psLine(1200, WRITTEN - 90 * MINUTE, "node"),
          psLine(1201, WRITTEN - 90 * MINUTE, "node"),
        ),
      ),
    ).toBe("maybe");
  });

  test("the desktop app backs a session it started before writing", () => {
    expect(writer(table(psLine(13, WRITTEN - MINUTE, "DeepSeek Harness")))).toBe("backed");
    expect(writer(table(psLine(13, WRITTEN + 2 * MINUTE, "DeepSeek Harness")))).toBe("gone");
  });

  test("a table taken before the last write says nothing of a program started since", () => {
    expect(writer(table(), { answerAt: WRITTEN - SECOND })).toBe("maybe");
  });

  test("a table that does not list Agent Lookout's own process, or no answer, cannot say", () => {
    expect(writer(dshInTable("", OWN_PID))).toBe("maybe");
    expect(writer({ ok: false })).toBe("maybe");
    expect(writer(null)).toBe("maybe");
    expect(usable(dshInTable("", OWN_PID))).toBe(false);
    expect(usable(table())).toBe(true);
  });

  test("a session last written more than a minute before the computer started has none, on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(writer(null, { platform, bootAt: WRITTEN + 61 * SECOND }), platform).toBe("gone");
      expect(writer(null, { platform, bootAt: WRITTEN + 59 * SECOND }), platform).toBe("maybe");
    }
  });

  test("on Windows, or with no last write that can be right, nothing is told", () => {
    expect(writer(table(), { platform: "win32", bootAt: WRITTEN + 2 * MINUTE })).toBe("maybe");
    expect(writer(table(), { writtenAt: null })).toBe("maybe");
  });
});
