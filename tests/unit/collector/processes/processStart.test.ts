import { describe, expect, test } from "vitest";

import {
  compareProcessStart,
  createProcessStartCheck,
  parseProcessStarts,
  psStartArgs,
  START_CHECK_TTL_MS,
  type ReadProcessStarts,
} from "@collector/processes/processStart";

const recorded = "Tue Nov 14 22:13:20 2023";

describe("psStartArgs", () => {
  test("asks for each pid's start time and nothing else, with the pids in one list", () => {
    expect(psStartArgs([4241, 4242])).toEqual(["-o", "pid=,lstart=", "-p", "4241,4242"]);
  });
});

describe("parseProcessStarts", () => {
  test("reads the ps of macOS, which pads the pid to five places and the time at its end", () => {
    const stdout = "    1 Mon Aug 24 10:10:20 2026    \n57256 Tue Oct  6 04:52:23 2026    \n";
    expect([...parseProcessStarts(stdout)]).toEqual([
      [1, "Mon Aug 24 10:10:20 2026"],
      [57256, "Tue Oct  6 04:52:23 2026"],
    ]);
  });

  test("reads the ps of Linux, procps, which pads the pid to the width of the largest one", () => {
    const stdout = "      1 Mon Aug 24 10:10:20 2026\n4194303 Tue Oct  6 04:52:23 2026\n";
    expect([...parseProcessStarts(stdout)]).toEqual([
      [1, "Mon Aug 24 10:10:20 2026"],
      [4194303, "Tue Oct  6 04:52:23 2026"],
    ]);
  });

  test("the same start time from either ps compares as the same process", () => {
    const mac = parseProcessStarts("  4242 Tue Oct  6 04:52:23 2026    \n").get(4242);
    const linux = parseProcessStarts("   4242 Tue Oct  6 04:52:23 2026\n").get(4242);
    expect(compareProcessStart(mac, linux)).toBe("same");
    expect(compareProcessStart(recorded, linux)).toBe("different");
  });

  test("a line that is not a pid and a time is left out", () => {
    const stdout = ["  PID STARTED", "", "4242", "abc Tue Oct  6 04:52:23 2026", " 4243 x"].join(
      "\n",
    );
    expect([...parseProcessStarts(stdout).keys()]).toEqual([]);
  });
});

describe("compareProcessStart", () => {
  test("the same start time is the same process", () => {
    expect(compareProcessStart(recorded, recorded)).toBe("same");
  });

  test("spacing does not matter: ps pads a one-digit day and the end of the line", () => {
    expect(compareProcessStart("Sat Oct  3 09:12:00 2026", "Sat Oct 3 09:12:00 2026    \n")).toBe(
      "same",
    );
  });

  test("start times a minute or less apart are the same process, as procps prints after the clock is set", () => {
    expect(compareProcessStart(recorded, "Tue Nov 14 22:13:21 2023")).toBe("same");
    expect(compareProcessStart(recorded, "Tue Nov 14 22:13:19 2023")).toBe("same");
    expect(compareProcessStart(recorded, "Tue Nov 14 22:14:20 2023")).toBe("same");
    // Across midnight and the end of a month and a year.
    expect(compareProcessStart("Sun Dec 31 23:59:58 2023", "Mon Jan  1 00:00:03 2024")).toBe(
      "same",
    );
  });

  test("start times more than a minute apart are a different process", () => {
    expect(compareProcessStart(recorded, "Tue Nov 14 22:14:21 2023")).toBe("different");
    expect(compareProcessStart(recorded, "Tue Nov 14 22:12:19 2023")).toBe("different");
    expect(compareProcessStart(recorded, "Wed Nov 15 22:13:20 2023")).toBe("different");
    expect(compareProcessStart(recorded, "Sat Oct  3 09:12:00 2026")).toBe("different");
  });

  test("a month name ps does not print is unknown, never different", () => {
    expect(compareProcessStart(recorded, "Tue Xyz 14 22:13:20 2023")).toBe("unknown");
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

  test("a session whose start ps prints a second later, after the clock was set, is kept", async () => {
    const { read } = fakePs({ 4242: "Tue Nov 14 22:13:21 2023" });
    const check = createProcessStartCheck(read, () => 0);
    expect((await check.reused([{ pid: 4242, procStart: recorded }])).size).toBe(0);
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

  test("sessions that started at different times share one ps every 30 seconds, not one each", async () => {
    let clock = 0;
    const { read, asked } = fakePs({ 4241: recorded, 4242: recorded });
    const check = createProcessStartCheck(read, () => clock);

    await check.reused([{ pid: 4241, procStart: recorded }]);
    expect(asked).toEqual([[4241]]);

    // A second session turns up 8 seconds later: it is due at once, and the first is asked too.
    clock = 8_000;
    await check.reused([
      { pid: 4241, procStart: recorded },
      { pid: 4242, procStart: recorded },
    ]);
    expect(asked).toEqual([[4241], [4241, 4242]]);

    // Their answers fall due together: one read at 38 seconds covers both, and none at 30.
    const both = [
      { pid: 4241, procStart: recorded },
      { pid: 4242, procStart: recorded },
    ];
    for (const at of [10_000, 20_000, 30_000, 36_000]) {
      clock = at;
      await check.reused(both);
    }
    expect(asked).toHaveLength(2);
    clock = 8_000 + START_CHECK_TTL_MS;
    await check.reused(both);
    expect(asked).toEqual([[4241], [4241, 4242], [4241, 4242]]);
    clock += 2_000;
    await check.reused(both);
    expect(asked).toHaveLength(3);
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
