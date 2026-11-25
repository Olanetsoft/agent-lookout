import { describe, expect, test } from "vitest";

import {
  createStatusFileProcesses,
  type NamedProcess,
} from "@collector/adapters/status-files/processes";
import { DAY, HOUR, MINUTE, NOW, SECOND } from "@tests/fixtures/statusFiles";

/** A time as `ps -o lstart=` prints it in UTC. */
function lstart(at: number): string {
  const [day, date, month, year, time] = new Date(at).toUTCString().replace(",", "").split(" ");
  return `${day} ${month} ${date} ${time} ${year}`;
}

/**
 * The processes of a folder of status files: a clock, the files, and the
 * processes that run with when each started, all of which the test changes.
 */
function setUp({ asksPs = true }: { asksPs?: boolean } = {}) {
  const clock = { now: NOW };
  const files = new Map<string, NamedProcess>();
  const running = new Map<number, number>();
  const ps = { runs: [] as number[][], answers: true };
  const processes = createStatusFileProcesses({
    isAlive: (pid) => running.has(pid),
    readStarts: asksPs
      ? async (pids) => {
          ps.runs.push([...pids]);
          if (!ps.answers) throw new Error("ps could not be run");
          return new Map(
            pids.flatMap((pid) => {
              const start = running.get(pid);
              return start === undefined ? [] : [[pid, lstart(start)] as const];
            }),
          );
        }
      : null,
    now: () => clock.now,
  });
  return {
    clock,
    files,
    running,
    ps,
    processes,
    /** Writes a file, with the clock's time unless it keeps another. */
    write(fileName: string, pid: number, fields: Partial<NamedProcess> = {}) {
      files.set(fileName, { fileName, pid, mtimeMs: clock.now, ...fields });
    },
    /** Polls, and gives the files whose process still runs, of all that are listed or of those it read. */
    async poll(afterMs = 2 * SECOND, read = [...files.keys()]): Promise<string[]> {
      clock.now += afterMs;
      const named = [...files.values()].filter(({ fileName }) => read.includes(fileName));
      const found = await processes.running(named, new Set(files.keys()));
      return [...found];
    },
  };
}

describe("a process found gone", () => {
  test.each([true, false])(
    "does not come back with another program, asking ps or not (%s), until its file is written again",
    async (asksPs) => {
      const { files, running, write, poll } = setUp({ asksPs });
      write("a.json", 100, { mtimeMs: NOW - MINUTE });
      expect(await poll()).toEqual([]);

      // Within a minute of the write, so no start time would tell it.
      running.set(100, NOW - 30 * SECOND);
      expect(await poll()).toEqual([]);
      expect(await poll(HOUR)).toEqual([]);

      write("a.json", 100);
      expect(await poll()).toEqual(["a.json"]);

      // Another process ID in a file with the same time is another process.
      running.delete(100);
      expect(await poll()).toEqual([]);
      running.set(101, NOW);
      files.set("a.json", { ...(files.get("a.json") as NamedProcess), pid: 101 });
      expect(await poll()).toEqual(["a.json"]);
    },
  );

  test("stays gone while its file is listed and not read, and is forgotten with the file", async () => {
    const { clock, running, processes } = setUp({ asksPs: false });
    const file = { fileName: "a.json", pid: 100, mtimeMs: NOW - DAY };
    const listed = new Set(["a.json"]);
    expect([...(await processes.running([file], listed))]).toEqual([]);
    running.set(100, NOW);
    // Past the limit of 200 for a while, or unreadable.
    expect([...(await processes.running([], listed))]).toEqual([]);
    expect([...(await processes.running([file], listed))]).toEqual([]);
    processes.notListed();
    clock.now += HOUR;
    expect([...(await processes.running([file], listed))]).toEqual([]);

    expect([...(await processes.running([], new Set()))]).toEqual([]);
    expect([...(await processes.running([file], listed))]).toEqual(["a.json"]);
  });

  test("is forgotten for one file alone when two name it", async () => {
    const { running, write, poll } = setUp();
    write("a.json", 100);
    write("b.json", 100);
    expect(await poll()).toEqual([]);
    running.set(100, NOW);
    write("b.json", 100);
    expect(await poll()).toEqual(["b.json"]);
  });
});

describe("a process ID another program had at the first poll", () => {
  test("is told by a start more than a minute after the last write, and stays told", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("left.json", 100, { mtimeMs: NOW - HOUR - MINUTE - SECOND });
    write("live.json", 100, { mtimeMs: NOW - HOUR - MINUTE });
    expect(await poll()).toEqual(["live.json"]);
    // A run of ps with no answer does not bring it back.
    ps.answers = false;
    expect(await poll(MINUTE)).toEqual(["live.json"]);
  });

  test("goes by the file's since when that is later than its time, as of a copy, and could be right", async () => {
    const { running, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("copy.json", 100, { mtimeMs: NOW - DAY, since: NOW - HOUR });
    write("old-since.json", 100, { mtimeMs: NOW - DAY, since: NOW - 2 * HOUR });
    write("tomorrow.json", 100, { mtimeMs: NOW - DAY, since: NOW + DAY });
    write("no-time.json", 100, { mtimeMs: 0 });
    write("ahead.json", 100, { mtimeMs: NOW + DAY });
    expect(await poll()).toEqual(["copy.json", "no-time.json", "ahead.json"]);
  });

  test("is not told while ps has no answer, and is once it has one", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("left.json", 100, { mtimeMs: NOW - DAY });
    ps.answers = false;
    expect(await poll()).toEqual(["left.json"]);
    ps.answers = true;
    expect(await poll()).toEqual(["left.json"]);
    expect(await poll(30 * SECOND)).toEqual([]);
  });

  test("is not told where ps is not asked", async () => {
    const { running, ps, write, poll } = setUp({ asksPs: false });
    running.set(100, NOW - HOUR);
    write("left.json", 100, { mtimeMs: NOW - DAY });
    expect(await poll()).toEqual(["left.json"]);
    expect(ps.runs).toEqual([]);
  });
});

describe("a running agent is never taken for another program", () => {
  test("when the clock was set back after it started, before and after the clock passes its start", async () => {
    const { clock, running, ps, write, poll } = setUp();
    // Started at NOW + 1 h by a fast clock, its file written once the clock was right.
    running.set(100, NOW + HOUR);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    for (let minutes = 0; minutes < 90; minutes += 1) {
      // One run of ps fails as the clock passes the start.
      ps.answers = minutes !== 60;
      expect(await poll(MINUTE)).toEqual(["a.json"]);
    }
    expect(clock.now).toBeGreaterThan(NOW + HOUR);

    // A program given its ID later is told, as the start is another.
    running.set(100, clock.now);
    expect(await poll(30 * SECOND)).toEqual([]);
  });

  test("when its file is not read for a while after the clock passed a start seen ahead of it", async () => {
    const { running, processes, write, poll } = setUp();
    running.set(100, NOW + HOUR);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    expect(await poll(2 * HOUR)).toEqual(["a.json"]);
    // It cannot be opened, or the folder cannot be listed.
    expect(await poll(2 * SECOND, [])).toEqual([]);
    expect(await poll()).toEqual(["a.json"]);
    expect(await poll(HOUR, [])).toEqual([]);
    processes.notListed();
    expect(await poll()).toEqual(["a.json"]);
    expect(await poll(HOUR)).toEqual(["a.json"]);
  });

  test("when the clock is set back while its file is watched", async () => {
    const { clock, running, write, poll } = setUp();
    running.set(100, NOW);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    clock.now -= 3 * MINUTE;
    write("a.json", 100);
    for (let passed = 0; passed < 10 * MINUTE; passed += 2 * SECOND) {
      expect(await poll()).toEqual(["a.json"]);
    }
  });

  test("when its file is written with an older time, as a copy that keeps one is, and the write was seen", async () => {
    const { running, write, processes, poll } = setUp();
    write("there.json", 100, { mtimeMs: NOW - 2 * DAY });
    running.set(100, NOW - HOUR);
    expect(await poll()).toEqual([]);

    write("there.json", 100, { mtimeMs: NOW - DAY });
    write("new.json", 100, { mtimeMs: NOW - DAY });
    expect(await poll()).toEqual(["there.json", "new.json"]);
    expect(await poll(HOUR)).toEqual(["there.json", "new.json"]);

    // Another process that has the ID by then is not the one that wrote them.
    running.set(100, NOW + 2 * MINUTE);
    expect(await poll(MINUTE)).toEqual([]);

    // After a poll that could not list the folder, a file that appears may have
    // been there, and one that changed may have done so under another process.
    running.set(101, NOW - HOUR);
    write("changed.json", 101);
    expect(await poll()).toEqual(["changed.json"]);
    processes.notListed();
    write("shown.json", 100, { mtimeMs: NOW - DAY });
    write("changed.json", 101, { mtimeMs: NOW - 2 * DAY });
    expect(await poll()).toEqual([]);
  });

  test("when its file was deleted and made again with an older time", async () => {
    const { files, running, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    files.delete("a.json");
    expect(await poll()).toEqual([]);
    write("a.json", 100, { mtimeMs: NOW - DAY });
    expect(await poll()).toEqual(["a.json"]);
    expect(await poll(HOUR)).toEqual(["a.json"]);
  });

  test("when it started long before it wrote, or within the minute after its file's time", async () => {
    const { running, write, poll } = setUp();
    running.set(100, NOW - 7 * DAY).set(101, NOW - 4 * SECOND);
    write("a.json", 100, { mtimeMs: NOW - 6 * DAY });
    write("b.json", 101, { mtimeMs: NOW - 5 * SECOND });
    expect(await poll()).toEqual(["a.json", "b.json"]);
  });
});

describe("how often ps is run", () => {
  test("once in 30 seconds, however often an agent writes its file", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR).set(101, NOW - HOUR);
    for (let polls = 0; polls < 30; polls += 1) {
      write("a.json", 100);
      write("b.json", 101);
      expect(await poll()).toEqual(["a.json", "b.json"]);
    }
    expect(ps.runs).toEqual([
      [100, 101],
      [100, 101],
    ]);
  });

  test("once in 30 seconds too while a file can be read on only every other poll", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("a.json", 100);
    for (let polls = 0; polls < 30; polls += 1) {
      expect(await poll(2 * SECOND, polls % 2 === 0 ? ["a.json"] : [])).toHaveLength(
        polls % 2 === 0 ? 1 : 0,
      );
    }
    expect(ps.runs).toEqual([[100], [100]]);
  });

  test("at once for a process whose ID a file names again after it was found gone", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    running.delete(100);
    expect(await poll()).toEqual([]);
    // Another agent, with the ID and the file of the one that stopped.
    running.set(100, NOW + 5 * SECOND);
    write("a.json", 100);
    expect(await poll()).toEqual(["a.json"]);
    expect(ps.runs).toEqual([[100], [100]]);
  });

  test("at once for a process it knows nothing of, for all of them in one run", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR).set(101, NOW - HOUR);
    write("a.json", 100);
    await poll();
    write("b.json", 101);
    write("c.json", 101);
    await poll();
    await poll();
    expect(ps.runs).toEqual([[100], [100, 101]]);
  });

  test("at once when the clock is set back, and not once more for that", async () => {
    const { clock, running, ps, write, poll } = setUp();
    running.set(100, NOW - DAY);
    write("a.json", 100);
    await poll();
    clock.now -= HOUR;
    await poll();
    await poll();
    expect(ps.runs).toEqual([[100], [100]]);
  });

  test("not while no file names a process that runs, and not for one found gone", async () => {
    const { running, ps, write, poll } = setUp();
    write("a.json", 100, { mtimeMs: NOW - DAY });
    await poll();
    running.set(100, NOW);
    for (let polls = 0; polls < 40; polls += 1) await poll();
    expect(ps.runs).toEqual([]);
  });

  test("once for a file left behind, which it then goes on knowing", async () => {
    const { running, ps, write, poll } = setUp();
    running.set(100, NOW - HOUR);
    write("a.json", 100, { mtimeMs: NOW - DAY });
    for (let polls = 0; polls < 40; polls += 1) expect(await poll()).toEqual([]);
    expect(ps.runs).toEqual([[100]]);
  });
});
