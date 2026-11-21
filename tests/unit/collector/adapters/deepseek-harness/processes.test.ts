import { describe, expect, test } from "vitest";

import {
  createDshProcessReader,
  DSH_TABLE_ARGS,
  dshInTable,
  dshWriter,
  guardDshClock,
  startDshClockGuard,
  usable,
  type DshPrograms,
} from "@collector/adapters/deepseek-harness/processes";
import { MINUTE, NOW, SECOND } from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  OWN_PID,
  psLine,
  standInPs,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import { backs } from "@collector/adapters/deepseek-harness/processes";
import {
  createDshProcessAsker,
  DESKTOP_PROGRAMS,
  DSH_NAMES,
  NODE_PROGRAMS,
  PROMPT_PROCESS_CHECK_MS,
  type DshProcessReader,
} from "@collector/adapters/deepseek-harness/processes";

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
    startFloor: -Infinity,
    lowAt: Infinity,
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

  test("a table taken before the last write, or less than 2 seconds after it, as a disk can round a write's time down, says nothing of a program started since", () => {
    expect(writer(table(), { answerAt: WRITTEN - SECOND })).toBe("maybe");
    expect(writer(table(), { answerAt: WRITTEN + SECOND })).toBe("maybe");
    expect(writer(table(), { answerAt: WRITTEN + 2 * SECOND - 1 })).toBe("maybe");
    expect(writer(table(), { answerAt: WRITTEN + 2 * SECOND })).toBe("gone");
  });

  test("a table asked because the clock was set back allows nothing for a rounded write time", () => {
    expect(writer(table(), { answerAt: WRITTEN + SECOND, clockSetBack: true })).toBe("gone");
    expect(writer(table(), { answerAt: WRITTEN - SECOND, clockSetBack: true })).toBe("maybe");
  });

  test("on macOS, after the clock was set back, a write stamped between the time it was set back to and the latest time a poll saw is not finished by a program's start", () => {
    const answer = table(psLine(11, WRITTEN + 8 * MINUTE, "node"));
    expect(writer(answer)).toBe("gone");
    const back = { startFloor: WRITTEN + 10 * MINUTE, lowAt: WRITTEN - MINUTE };
    expect(writer(answer, back)).toBe("maybe");
    expect(writer(answer, { ...back, lowAt: WRITTEN })).toBe("maybe");
    expect(writer(answer, { ...back, startFloor: WRITTEN })).toBe("gone");
    // One stamped before the time it was set back to was written before, on the clock the starts were taken on.
    expect(writer(answer, { ...back, lowAt: WRITTEN + MINUTE })).toBe("gone");
    // With no such program at all, none could write it, whatever the clock did.
    expect(writer(table(), back)).toBe("gone");
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

describe("the clock guard", () => {
  test("starts with no write kept from the start rule", () => {
    expect(startDshClockGuard()).toEqual({
      startFloor: -Infinity,
      lowAt: Infinity,
      highAt: -Infinity,
      last: null,
    });
  });

  test("on macOS, a poll more than a minute behind the latest one keeps writes stamped between the time the clock was set back to and that latest time from the start rule", () => {
    const seen = guardDshClock(startDshClockGuard(), "darwin", NOW, 0);
    expect(seen).toEqual({
      startFloor: -Infinity,
      lowAt: Infinity,
      highAt: NOW,
      last: { wall: NOW, mono: 0 },
    });
    // Set back 10 minutes within the 2 seconds since: the clock read no less than this when it was.
    const back = guardDshClock(seen, "darwin", NOW - 10 * MINUTE, 2 * SECOND);
    expect(back).toEqual({
      startFloor: NOW,
      lowAt: NOW - 10 * MINUTE - 2 * SECOND,
      highAt: NOW,
      last: { wall: NOW - 10 * MINUTE, mono: 2 * SECOND },
    });
    // Both stay, as the clock comes back.
    const ahead = guardDshClock(back, "darwin", NOW + MINUTE, 11 * MINUTE + 2 * SECOND);
    expect(ahead).toEqual({
      startFloor: NOW,
      lowAt: NOW - 10 * MINUTE - 2 * SECOND,
      highAt: NOW + MINUTE,
      last: { wall: NOW + MINUTE, mono: 11 * MINUTE + 2 * SECOND },
    });
    // A later set-back raises the floor to the latest time and only lowers the low.
    const lesser = guardDshClock(ahead, "darwin", NOW - 5 * MINUTE, 11 * MINUTE + 4 * SECOND);
    expect(lesser).toMatchObject({
      startFloor: NOW + MINUTE,
      lowAt: NOW - 10 * MINUTE - 2 * SECOND,
    });
    const further = guardDshClock(lesser, "darwin", NOW - 30 * MINUTE, 11 * MINUTE + 6 * SECOND);
    expect(further).toMatchObject({
      startFloor: NOW + MINUTE,
      lowAt: NOW - 30 * MINUTE - 2 * SECOND,
    });
    // A clock that seems to run backwards between polls takes nothing off.
    expect(guardDshClock(seen, "darwin", NOW - 10 * MINUTE, -SECOND).lowAt).toBe(NOW - 10 * MINUTE);
    expect(guardDshClock(seen, "darwin", NOW - 59 * SECOND, SECOND)).toEqual({
      startFloor: -Infinity,
      lowAt: Infinity,
      highAt: NOW,
      last: { wall: NOW - 59 * SECOND, mono: SECOND },
    });
  });

  test("on Linux, nothing is raised", () => {
    const seen = guardDshClock(startDshClockGuard(), "linux", NOW, 0);
    expect(guardDshClock(seen, "linux", NOW - 10 * MINUTE, 2 * SECOND)).toMatchObject({
      startFloor: -Infinity,
      lowAt: Infinity,
    });
  });
});

describe("the names a table is read for", () => {
  test("are DeepSeek Harness's when none are given", async () => {
    expect(DSH_NAMES).toEqual({ backing: DESKTOP_PROGRAMS, maybe: NODE_PROGRAMS });
    const lines = [psLine(OWN_PID, NOW, "node"), psLine(11, NOW - MINUTE, "DeepSeek Harness")];
    expect(dshInTable(lines.join("\n"), OWN_PID)).toEqual(
      dshInTable(lines.join("\n"), OWN_PID, DSH_NAMES),
    );
  });

  test("can be another agent's, backing and maybe alike", async () => {
    const names = { backing: new Set(["omp"]), maybe: new Set(["bun"]) };
    const lines = [
      psLine(OWN_PID, NOW, "node"),
      psLine(11, NOW - MINUTE, "/usr/local/bin/omp"),
      psLine(12, NOW - 2 * MINUTE, "bun"),
      psLine(13, NOW - 3 * MINUTE, "DeepSeek Harness"),
      psLine(14, NOW - 4 * MINUTE, "omp daemon"),
    ];
    expect(dshInTable(lines.join("\n"), OWN_PID, names)).toEqual({
      ok: true,
      ownListed: true,
      programs: [
        { start: NOW - MINUTE, desktop: true },
        { start: NOW - 2 * MINUTE, desktop: false },
      ],
    });
    const ps = standInPs([psLine(11, NOW - MINUTE, "omp")]);
    const read = await createDshProcessReader({
      platform: "darwin",
      run: ps.run,
      ownPid: OWN_PID,
      names,
    }).read();
    expect(read).toMatchObject({ ok: true, programs: [{ desktop: true }] });
  });
});

describe("a prefix of backing names, as Muse Code's adapter gives one", () => {
  const prefixed = {
    backing: new Set(["muse", "muse.exe"]),
    backingPrefix: "muse-",
    maybe: new Set<string>(),
  };

  test("backs a name that begins with it and has more after it, and not the prefix alone", () => {
    expect(backs("muse-bin-1.4.24", prefixed)).toBe(true);
    expect(backs("muse-aarch64-li", prefixed)).toBe(true);
    expect(backs("muse-", prefixed)).toBe(false);
    expect(backs("muse", prefixed)).toBe(true);
    expect(backs("muse.exe", prefixed)).toBe(true);
    expect(backs("Muse", prefixed)).toBe(false);
    expect(backs("xmuse-bin", prefixed)).toBe(false);
    expect(backs("tbh-linux-sandbox", prefixed)).toBe(false);
  });

  test("is read from a table's lines, by the last part of a program's path", () => {
    const lines = [
      psLine(OWN_PID, NOW, "node"),
      psLine(11, NOW - MINUTE, "/opt/homebrew/bin/muse-aarch64-darwin"),
      psLine(12, NOW - 2 * MINUTE, "muse-"),
      psLine(13, NOW - 3 * MINUTE, "muse"),
      psLine(14, NOW - 4 * MINUTE, "musescore"),
    ];
    expect(dshInTable(lines.join("\n"), OWN_PID, prefixed)).toEqual({
      ok: true,
      ownListed: true,
      programs: [
        { start: NOW - MINUTE, desktop: true },
        { start: NOW - 3 * MINUTE, desktop: true },
      ],
    });
  });

  test("with none set, as DeepSeek Harness's and Oh My Pi's names have, nothing changes", () => {
    const lines = [
      psLine(OWN_PID, NOW, "node"),
      psLine(11, NOW - MINUTE, "omp-x"),
      psLine(12, NOW - 2 * MINUTE, "DeepSeek Harness-x"),
      psLine(13, NOW - 3 * MINUTE, "omp"),
    ].join("\n");
    const omp = { backing: new Set(["omp"]), maybe: new Set(["bun"]) };
    expect(dshInTable(lines, OWN_PID, omp)).toEqual(
      dshInTable(lines, OWN_PID, { ...omp, backingPrefix: undefined }),
    );
    expect(dshInTable(lines, OWN_PID, omp).ok && dshInTable(lines, OWN_PID, omp)).toMatchObject({
      programs: [{ start: NOW - 3 * MINUTE, desktop: true }],
    });
    expect(dshInTable(lines, OWN_PID)).toMatchObject({ programs: [] });
  });
});

describe("when ps is asked, as DeepSeek Harness's and Oh My Pi's adapters ask it", () => {
  const STEP = 10 * SECOND;

  /** A reader that answers what a test sets and counts its runs. */
  function standIn(initial: DshPrograms) {
    let answer = initial;
    const asked = { count: 0 };
    const processes: DshProcessReader = {
      async read() {
        asked.count += 1;
        return answer;
      },
    };
    return { processes, asked, set: (next: DshPrograms) => (answer = next) };
  }

  const none: DshPrograms = { ok: true, ownListed: true, programs: [] };
  const one: DshPrograms = {
    ok: true,
    ownListed: true,
    programs: [{ start: NOW - MINUTE, desktop: true }],
  };
  const file = (mtimeMs: number) => ({ path: "/x/a.jsonl", info: { ino: 1, size: 10, mtimeMs } });

  function askerOf(
    initial: DshPrograms,
    platform: NodeJS.Platform = "darwin",
    uptimeMs = () => MINUTE,
  ) {
    const reader = standIn(initial);
    return {
      ...reader,
      asker: createDshProcessAsker({
        processes: reader.processes,
        platform,
        processCheckMs: STEP,
        uptimeMs,
      }),
    };
  }

  test("asks at the first poll, then every 10 seconds, keeping the answer and when it was asked", async () => {
    const { asker, asked } = askerOf(one);
    expect(asker.lastAnswer).toBeNull();
    expect(await asker.programsFor(NOW, [NOW - MINUTE], [])).toBe(one);
    expect(asker).toMatchObject({ lastAnswer: one, answerAt: NOW, clockSetBack: false });
    await asker.programsFor(NOW + STEP - 1, [NOW + STEP - 2], []);
    expect(asked.count).toBe(1);
    await asker.programsFor(NOW + STEP, [], []);
    expect(asked.count).toBe(2);
    expect(asker.answerAt).toBe(NOW + STEP);
  });

  test("asks sooner, not within 2 seconds, for a write after, or up to 2 seconds before, an answer that listed none", async () => {
    const { asker, asked } = askerOf(none);
    await asker.programsFor(NOW, [NOW - MINUTE], []);
    // A write 2 seconds or more before the answer was seen by it.
    await asker.programsFor(
      NOW + PROMPT_PROCESS_CHECK_MS,
      [NOW - PROMPT_PROCESS_CHECK_MS, null],
      [],
    );
    expect(asked.count).toBe(1);
    await asker.programsFor(NOW + PROMPT_PROCESS_CHECK_MS - 1, [NOW + SECOND], []);
    expect(asked.count).toBe(1);
    await asker.programsFor(NOW + PROMPT_PROCESS_CHECK_MS, [NOW - PROMPT_PROCESS_CHECK_MS + 1], []);
    expect(asked.count).toBe(2);
  });

  test("not sooner after an answer that listed a program, or that cannot be trusted", async () => {
    for (const answer of [
      one,
      { ok: false } as const,
      { ok: true, ownListed: false, programs: [] },
    ]) {
      const { asker, asked } = askerOf(answer);
      await asker.programsFor(NOW, [], []);
      await asker.programsFor(NOW + 3 * SECOND, [NOW + 2 * SECOND], []);
      expect(asked.count).toBe(1);
    }
  });

  test("a clock set back asks again and keeps each file as that poll found it, until the next ask", async () => {
    const { asker, asked } = askerOf(none);
    await asker.programsFor(NOW, [], [file(NOW - MINUTE)]);
    expect(asker.asAsked(file(NOW - MINUTE))).toBe(false);
    await asker.programsFor(NOW - HOUR_MS, [], [file(NOW - MINUTE)]);
    expect(asked.count).toBe(2);
    expect(asker.clockSetBack).toBe(true);
    expect(asker.asAsked(file(NOW - MINUTE))).toBe(true);
    expect(asker.asAsked(file(NOW - MINUTE + 1))).toBe(false);
    expect(asker.asAsked({ ...file(NOW - MINUTE), path: "/x/b.jsonl" })).toBe(false);
    await asker.programsFor(NOW - HOUR_MS + STEP, [], [file(NOW - MINUTE)]);
    expect(asker.clockSetBack).toBe(false);
    expect(asker.asAsked(file(NOW - MINUTE))).toBe(false);
  });

  test("keeps the computer's start at the earliest worked out, and has none where ps is not asked", () => {
    let uptime = HOUR_MS;
    const { asker } = askerOf(none, "linux", () => uptime);
    expect(asker.bootAt(NOW)).toBe(NOW - HOUR_MS);
    uptime = 0;
    expect(asker.bootAt(NOW)).toBe(NOW - HOUR_MS);
    uptime = 2 * HOUR_MS;
    expect(asker.bootAt(NOW)).toBe(NOW - 2 * HOUR_MS);
    uptime = Number.NaN;
    expect(asker.bootAt(NOW)).toBe(NOW - 2 * HOUR_MS);
    let looked = 0;
    const windows = askerOf(none, "win32", () => {
      looked += 1;
      return 0;
    });
    expect(windows.asker.bootAt(NOW)).toBeNull();
    expect(looked).toBe(0);
  });
});

const HOUR_MS = 60 * MINUTE;
