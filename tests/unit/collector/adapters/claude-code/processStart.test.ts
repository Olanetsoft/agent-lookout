import { describe, expect, test } from "vitest";

import {
  compareProcessStart,
  createProcessStartCheck,
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
} from "@collector/adapters/claude-code/processStart";

const recorded = "Tue Nov 14 22:13:20 2023";

describe("compareProcessStart", () => {
  test("the same start time is the same process", () => {
    expect(compareProcessStart(recorded, recorded)).toBe("same");
  });

  test("spacing does not matter: ps pads a one-digit day and the end of the line", () => {
    expect(compareProcessStart("Sat Oct  3 09:12:00 2026", "Sat Oct 3 09:12:00 2026    \n")).toBe(
      "same",
    );
  });

  test("two different start times are a different process", () => {
    expect(compareProcessStart(recorded, "Tue Nov 14 22:13:21 2023")).toBe("different");
    expect(compareProcessStart(recorded, "Sat Oct  3 09:12:00 2026")).toBe("different");
  });

  test("a missing value on either side is unknown, never different", () => {
    expect(compareProcessStart(undefined, recorded)).toBe("unknown");
    expect(compareProcessStart(recorded, undefined)).toBe("unknown");
    expect(compareProcessStart("", recorded)).toBe("unknown");
    expect(compareProcessStart(recorded, "   ")).toBe("unknown");
  });

  test("a recorded value in a form ps does not print is unknown, never different", () => {
    // A later Claude Code could record the time another way. That must not make
    // every real session look like a leftover.
    expect(compareProcessStart("1700000000000", recorded)).toBe("unknown");
    expect(compareProcessStart("2023-11-14T22:13:20Z", recorded)).toBe("unknown");
    expect(compareProcessStart("Di Nov 14 22:13:20 2023 CET", recorded)).toBe("unknown");
    expect(compareProcessStart(recorded, "ps: unexpected output")).toBe("unknown");
  });
});

describe("createProcessStartCheck", () => {
  function fakePs(starts: Record<number, string>) {
    const asked: number[][] = [];
    const read: ReadProcessStarts = async (pids) => {
      asked.push([...pids]);
      return new Map(Object.entries(starts).map(([pid, start]) => [Number(pid), start]));
    };
    return { read, asked };
  }

  test("names the pids that now belong to another process", async () => {
    const { read } = fakePs({ 4241: recorded, 4242: "Sat Oct  3 09:12:00 2026" });
    const check = createProcessStartCheck(read, () => 0);
    const reused = await check.reused([
      { pid: 4241, procStart: recorded },
      { pid: 4242, procStart: recorded },
    ]);
    expect([...reused]).toEqual([4242]);
  });

  test("an entry with no recorded start, or a pid ps says nothing about, is kept", async () => {
    const { read, asked } = fakePs({});
    const check = createProcessStartCheck(read, () => 0);
    const reused = await check.reused([{ pid: 4241 }, { pid: 4242, procStart: recorded }]);
    expect(reused.size).toBe(0);
    // Only the entry that can be checked is asked about.
    expect(asked).toEqual([[4242]]);
  });

  test("a ps that fails keeps every entry", async () => {
    const check = createProcessStartCheck(
      async () => {
        throw new Error("ps is not here");
      },
      () => 0,
    );
    expect((await check.reused([{ pid: 4242, procStart: recorded }])).size).toBe(0);
  });

  test("an answer is remembered, so ps is not run on every poll", async () => {
    let clock = 0;
    const { read, asked } = fakePs({ 4242: "Sat Oct  3 09:12:00 2026" });
    const check = createProcessStartCheck(read, () => clock);
    const entries = [{ pid: 4242, procStart: recorded }];

    expect([...(await check.reused(entries))]).toEqual([4242]);
    clock += 2_000;
    expect([...(await check.reused(entries))]).toEqual([4242]);
    expect(asked).toHaveLength(1);

    clock += START_CHECK_TTL_MS;
    await check.reused(entries);
    expect(asked).toHaveLength(2);
  });

  test("a registry file rewritten with a new start time is checked again at once", async () => {
    const { read, asked } = fakePs({ 4242: "Sat Oct  3 09:12:00 2026" });
    const check = createProcessStartCheck(read, () => 0);
    expect((await check.reused([{ pid: 4242, procStart: recorded }])).size).toBe(1);
    expect((await check.reused([{ pid: 4242, procStart: "Sat Oct  3 09:12:00 2026" }])).size).toBe(
      0,
    );
    expect(asked).toHaveLength(2);
  });

  test("a pid whose entry has gone is forgotten", async () => {
    const { read, asked } = fakePs({ 4242: recorded });
    const check = createProcessStartCheck(read, () => 0);
    await check.reused([{ pid: 4242, procStart: recorded }]);
    await check.reused([]);
    await check.reused([{ pid: 4242, procStart: recorded }]);
    expect(asked).toHaveLength(2);
  });
});
