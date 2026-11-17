import { describe, expect, test } from "vitest";

import { createHolderCheck, parsePsRows } from "@collector/adapters/prime-agent/holders";
import type { Lease } from "@collector/adapters/prime-agent/leases";
import {
  DAY,
  lstartOf,
  PID,
  PROC_START_ID,
  PROCESS_STARTED_AT,
  PS_START_ID,
  SECOND,
  STARTED_AT,
  START_TICKS,
  statLine,
} from "@tests/fixtures/prime-agent/primeAgent";
import {
  handClock,
  standInAlive,
  standInProc,
  standInPs,
} from "@tests/support/adapters/prime-agent/primeAgentAdapter";

const NOW = STARTED_AT + 60 * SECOND;

const lease = (changes: Partial<Lease> = {}): Lease => ({
  pid: PID,
  createdAt: STARTED_AT,
  processStartId: PS_START_ID,
  activeSessionId: "a1b2c3d40001",
  ...changes,
});

function checkFor(platform: NodeJS.Platform, alive = [PID], uptimeMs = 30 * DAY) {
  const clock = handClock(NOW);
  const signals = standInAlive(alive);
  const ps = standInPs(
    new Map([
      [
        PID,
        {
          lstart: lstartOf(PROCESS_STARTED_AT),
          program: "/opt/demo/share/prime-agent/prime-agent",
        },
      ],
    ]),
  );
  const proc = standInProc(new Map([[`/proc/${PID}/stat`, statLine(PID, START_TICKS)]]));
  const check = createHolderCheck({
    platform,
    isAlive: signals.isAlive,
    uptimeMs: () => uptimeMs,
    runPs: ps.run,
    readProcFile: proc.readProcFile,
    now: clock.now,
  });
  return { check, clock, signals, ps, proc };
}

describe("on a Mac", () => {
  test("a lease whose start ps gives as Prime Agent wrote it is held", async () => {
    const { check, ps } = checkFor("darwin");
    const one = lease();
    const answer = await check.check([one], NOW);
    expect(answer.processes.get(one)).toBe("runs");
    expect(ps.runs).toEqual([{ args: ["-o", "pid=,lstart=,comm=", "-p", String(PID)], utc: true }]);
  });

  test("a start more than a minute away means the pid went to another process", async () => {
    const { check } = checkFor("darwin");
    const one = lease({ processStartId: `ps:${lstartOf(PROCESS_STARTED_AT - 5 * 60 * SECOND)}` });
    expect((await check.check([one], NOW)).processes.get(one)).toBe("gone");
  });

  test("with no start to compare, the program's name decides", async () => {
    const { check, ps } = checkFor("darwin");
    const one = lease({ processStartId: undefined });
    expect((await check.check([one], NOW)).processes.get(one)).toBe("runs");
    const other = checkFor("darwin");
    other.ps.processes.set(PID, { lstart: lstartOf(PROCESS_STARTED_AT), program: "/usr/bin/vim" });
    expect((await other.check.check([one], NOW)).processes.get(one)).toBe("unknown");
    expect(ps.runs).toHaveLength(1);
  });

  test("with no start to compare, a lease from before the boot is gone without asking ps", async () => {
    const { check, ps } = checkFor("darwin", [PID], 30 * SECOND);
    const one = lease({ processStartId: undefined });
    expect((await check.check([one], NOW)).processes.get(one)).toBe("gone");
    expect(ps.runs).toEqual([]);
  });

  test("a process ps does not list, or a ps that fails, cannot be told, and the failure is said", async () => {
    const { check, ps } = checkFor("darwin", [PID, PID + 1]);
    const listed = lease();
    const one = lease({ pid: PID + 1 });
    const unlisted = await check.check([listed, one], NOW);
    expect(unlisted.processes.get(listed)).toBe("runs");
    expect(unlisted.processes.get(one)).toBe("unknown");
    // ps exits with an error for the pid it could not find, and still prints the other.
    expect(unlisted.psFailed).toBe(false);
    const failing = checkFor("darwin");
    failing.ps.fail();
    const failed = await failing.check.check([lease()], NOW);
    expect([...failed.processes.values()]).toEqual(["unknown"]);
    expect(failed.psFailed).toBe(true);
    expect(ps.runs).toHaveLength(1);
  });

  test("a process signal 0 does not find is gone, and ps is not asked about it", async () => {
    const { check, ps } = checkFor("darwin", []);
    const one = lease();
    expect((await check.check([one], NOW)).processes.get(one)).toBe("gone");
    expect(ps.runs).toEqual([]);
  });

  test("ps is asked at most every 30 seconds, and at once for a new lease", async () => {
    const { check, ps, clock } = checkFor("darwin");
    const one = lease();
    await check.check([one], clock.now());
    clock.advance(2 * SECOND);
    await check.check([one], clock.now());
    expect(ps.runs).toHaveLength(1);
    const another = lease({ createdAt: STARTED_AT + SECOND });
    await check.check([one, another], clock.now());
    expect(ps.runs).toHaveLength(2);
    clock.advance(30 * SECOND);
    await check.check([one, another], clock.now());
    expect(ps.runs).toHaveLength(3);
    // One run covers both, which share a process.
    expect(ps.runs.at(-1)?.args).toEqual(["-o", "pid=,lstart=,comm=", "-p", String(PID)]);
  });

  test("/proc is never read", async () => {
    const { check, proc } = checkFor("darwin");
    await check.check([lease({ processStartId: PROC_START_ID })], NOW);
    expect(proc.read).toEqual([]);
  });
});

describe("on Linux", () => {
  test("a proc: start is compared with field 22 of /proc/<pid>/stat, and ps is not asked", async () => {
    const { check, ps, proc } = checkFor("linux", [PID], 30 * SECOND);
    const one = lease({ processStartId: PROC_START_ID });
    // The same start holds even for a lease that looks older than the boot.
    expect((await check.check([one], NOW)).processes.get(one)).toBe("runs");
    expect(proc.read).toEqual([`/proc/${PID}/stat`]);
    expect(ps.runs).toEqual([]);
    const moved = lease({ processStartId: "proc:999" });
    expect((await check.check([moved], NOW)).processes.get(moved)).toBe("gone");
  });

  test("a lease whose start /proc cannot give is asked of ps", async () => {
    const { check, ps, proc } = checkFor("linux");
    proc.files.clear();
    const one = lease({ processStartId: PROC_START_ID });
    expect((await check.check([one], NOW)).processes.get(one)).toBe("runs");
    expect(ps.runs).toHaveLength(1);
  });

  test("/proc is read again only after 30 seconds, and of a lease's process alone", async () => {
    const { check, proc, clock } = checkFor("linux");
    const one = lease({ processStartId: PROC_START_ID });
    await check.check([one], clock.now());
    clock.advance(10 * SECOND);
    await check.check([one], clock.now());
    clock.advance(25 * SECOND);
    await check.check([one], clock.now());
    expect(proc.read).toEqual([`/proc/${PID}/stat`, `/proc/${PID}/stat`]);
  });
});

describe("on Windows", () => {
  test("a held lease cannot be told, nothing is asked, and one from before the boot is gone", async () => {
    const { check, ps, proc } = checkFor("win32");
    const one = lease({ processStartId: "win:133000000000000000" });
    expect((await check.check([one], NOW)).processes.get(one)).toBe("unknown");
    const old = checkFor("win32", [PID], 30 * SECOND);
    expect((await old.check.check([one], NOW)).processes.get(one)).toBe("gone");
    expect(ps.runs).toEqual([]);
    expect(proc.read).toEqual([]);
  });
});

test("ps's lines give each pid's start and program, whatever the padding, and a program with spaces", () => {
  const rows = parsePsRows(
    `  4242 Tue Oct  6 04:09:12 2026 /Applications/Demo App/prime-agent\n101 Sun Jan 11 23:01:02 2026 prime-agent\nnot a line\n`,
  );
  expect(rows).toEqual(
    new Map([
      [4242, { lstart: "Tue Oct  6 04:09:12 2026", program: "/Applications/Demo App/prime-agent" }],
      [101, { lstart: "Sun Jan 11 23:01:02 2026", program: "prime-agent" }],
    ]),
  );
});
