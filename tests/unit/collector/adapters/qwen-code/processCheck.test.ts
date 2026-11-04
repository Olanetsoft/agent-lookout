import { describe, expect, test } from "vitest";

import {
  createRecordProcessCheck,
  createRecordTokenCheck,
  recordProcessMatch,
  recordTokenMatch,
  type RecordProcess,
  type RecordProcessCheck,
} from "@collector/adapters/qwen-code/processCheck";
import { START_CHECK_TTL_MS } from "@collector/processes/processStart";
import { lstart } from "@tests/fixtures/antigravity";
import { BOOT_ID, MINUTE, NOW, SECOND, startToken } from "@tests/fixtures/qwen-code/qwenCode";
import { standInStarts, standInTokens } from "@tests/support/adapters/qwenCodeAdapter";

const REGISTERED = NOW - 30 * MINUTE;

/** The records, of these, the check says were written by the process that has their pid now. */
async function confirmed<T extends RecordProcess>(
  check: RecordProcessCheck,
  records: readonly T[],
) {
  const matches = await check.matches(records);
  return new Set(records.filter((record) => matches.get(record) === "same"));
}

describe("recordProcessMatch", () => {
  test("a process that started before its record was written is the record's own", () => {
    expect(recordProcessMatch(REGISTERED, lstart(REGISTERED - 2 * SECOND), NOW)).toBe("same");
    expect(recordProcessMatch(REGISTERED, lstart(REGISTERED - 3 * MINUTE), NOW)).toBe("same");
    expect(recordProcessMatch(REGISTERED, lstart(REGISTERED), NOW)).toBe("same");
  });

  test("one that started more than a minute after is another, given the pid since", () => {
    expect(recordProcessMatch(REGISTERED, lstart(REGISTERED + MINUTE + SECOND), NOW)).toBe(
      "different",
    );
    expect(recordProcessMatch(REGISTERED, lstart(NOW - MINUTE), NOW)).toBe("different");
  });

  test("a start up to a minute after still counts, for a clock that was set since", () => {
    expect(recordProcessMatch(REGISTERED, lstart(REGISTERED + 40 * SECOND), NOW)).toBe("same");
  });

  test.each([
    ["no start time from ps", REGISTERED, undefined],
    ["a start time not in the form ps prints", REGISTERED, "yesterday"],
    ["no registration time in the record", null, lstart(REGISTERED - MINUTE)],
  ])("with %s, it cannot be told", (_what, startedAt, start) => {
    expect(recordProcessMatch(startedAt, start, NOW)).toBe("unknown");
  });

  test("a record written ahead of the clock cannot be told, though a process started before it", () => {
    // As when the clock was fast as the record was written, and was set back since.
    expect(recordProcessMatch(NOW + 60 * MINUTE, lstart(NOW), NOW)).toBe("unknown");
    expect(recordProcessMatch(NOW + 2 * MINUTE, lstart(NOW - MINUTE), NOW)).toBe("unknown");
    // Up to a minute ahead is room for a poll's own time.
    expect(recordProcessMatch(NOW + 30 * SECOND, lstart(NOW), NOW)).toBe("same");
  });
});

describe("createRecordProcessCheck", () => {
  function check(started: Record<number, number>) {
    const ps = standInStarts(started);
    const clock = { now: NOW };
    return { ps, clock, check: createRecordProcessCheck(ps.read, () => clock.now) };
  }

  const own = { pid: 41001, startedAt: REGISTERED };
  const reused = { pid: 41002, startedAt: REGISTERED };

  test("confirms the records whose process is their own, with one ps for them all", async () => {
    const { ps, check: records } = check({
      41001: REGISTERED - 2 * SECOND,
      41002: NOW - 5 * MINUTE,
    });
    const same = await confirmed(records, [own, reused]);

    expect([...same]).toEqual([own]);
    expect(ps.runs).toEqual([[41001, 41002]]);
  });

  test("asks ps again only after 30 seconds", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    for (let at = 0; at < START_CHECK_TTL_MS; at += 2_000) {
      expect((await confirmed(records, [own])).has(own)).toBe(true);
      clock.now += 2_000;
    }
    expect(ps.runs).toHaveLength(1);

    // The pid has gone to another program since.
    ps.starts.set(41001, NOW + 20 * SECOND);
    expect((await confirmed(records, [own])).has(own)).toBe(false);
    expect(ps.runs).toHaveLength(2);
  });

  test("confirms nothing when ps fails, does not list the process, or the record has no time", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    ps.fails = true;
    expect((await confirmed(records, [own])).size).toBe(0);

    ps.fails = false;
    clock.now += START_CHECK_TTL_MS;
    expect((await confirmed(records, [{ pid: 41003, startedAt: REGISTERED }])).size).toBe(0);

    const untimed = { pid: 41001, startedAt: null };
    const runs = ps.runs.length;
    expect((await confirmed(records, [untimed])).size).toBe(0);
    // A record with no time is not asked about.
    expect(ps.runs).toHaveLength(runs);
  });

  test("tells two records of one pid apart by when each was written", async () => {
    const { check: records } = check({ 41001: REGISTERED + 10 * MINUTE });
    const earlier = { pid: 41001, startedAt: REGISTERED };
    const later = { pid: 41001, startedAt: REGISTERED + 10 * MINUTE + SECOND };
    const same = await confirmed(records, [earlier, later]);

    expect([...same]).toEqual([later]);
  });

  test("with no record, ps is not run", async () => {
    const { ps, check: records } = check({});
    expect((await confirmed(records, [])).size).toBe(0);
    expect(ps.runs).toEqual([]);
  });

  test("a clock that was set back asks ps again", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    expect((await confirmed(records, [own])).has(own)).toBe(true);

    // The clock was set back 20 minutes, and since then the pid has gone to
    // another program, which started after the record was written.
    clock.now -= 20 * MINUTE;
    ps.starts.set(41001, clock.now - MINUTE);
    expect((await confirmed(records, [own])).has(own)).toBe(false);
    expect(ps.runs).toHaveLength(2);
  });

  test("does not confirm a record written ahead of the clock", async () => {
    const ahead = { pid: 41001, startedAt: NOW + 60 * MINUTE };
    const { ps, check: records } = check({ 41001: NOW });

    expect((await confirmed(records, [ahead])).size).toBe(0);
    expect(ps.runs).toEqual([[41001]]);
  });

  test("forgets a record it is no longer asked about, and asks again when it comes back", async () => {
    const { ps, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    await confirmed(records, [own]);
    await confirmed(records, []);
    await confirmed(records, [own]);

    expect(ps.runs).toHaveLength(2);
  });

  test("answers same, different or unknown for each record it is given", async () => {
    const { check: records } = check({ 41001: REGISTERED - 2 * SECOND, 41002: NOW - 5 * MINUTE });
    const untimed = { pid: 41001, startedAt: null };
    const unlisted = { pid: 41003, startedAt: REGISTERED };
    const matches = await records.matches([own, reused, untimed, unlisted]);

    expect([...matches]).toEqual([
      [own, "same"],
      [reused, "different"],
      [untimed, "unknown"],
      [unlisted, "unknown"],
    ]);
  });
});

describe("recordTokenMatch", () => {
  test("a token the same as the record's is its process, and any other is not", () => {
    expect(recordTokenMatch(startToken(500), startToken(500))).toBe("same");
    expect(recordTokenMatch(startToken(500), startToken(900))).toBe("different");
  });

  test("a token from before a restart is another process, whatever its start", () => {
    const before = `00000000-0000-4000-8000-00000000b007:500`;
    expect(before).not.toContain(BOOT_ID);
    expect(recordTokenMatch(before, startToken(500))).toBe("different");
  });

  test.each([
    ["no token in the record", null, startToken(500)],
    ["no token for the process", startToken(500), undefined],
  ])("with %s, it cannot be told", (_what, procStart, token) => {
    expect(recordTokenMatch(procStart, token)).toBe("unknown");
  });
});

describe("createRecordTokenCheck", () => {
  function check(tokens: Record<number, string>) {
    const proc = standInTokens(tokens);
    const clock = { now: NOW };
    return { proc, clock, check: createRecordTokenCheck(proc.read, () => clock.now) };
  }

  const own = { pid: 41001, startedAt: REGISTERED, procStart: startToken(500) };
  const reused = { pid: 41002, startedAt: REGISTERED, procStart: startToken(600) };

  test("tells a record's own process from one given its pid since, with one read for them all", async () => {
    const { proc, check: records } = check({ 41001: startToken(500), 41002: startToken(9_000) });
    const matches = await records.matches([own, reused]);

    expect([...matches]).toEqual([
      [own, "same"],
      [reused, "different"],
    ]);
    expect(proc.reads).toEqual([[41001, 41002]]);
  });

  test("tells two records of one pid apart by their tokens", async () => {
    const { check: records } = check({ 41001: startToken(700) });
    const earlier = { pid: 41001, startedAt: REGISTERED, procStart: startToken(500) };
    const later = { pid: 41001, startedAt: REGISTERED, procStart: startToken(700) };

    expect([...(await records.matches([earlier, later]))]).toEqual([
      [earlier, "different"],
      [later, "same"],
    ]);
  });

  test("reads the tokens again only after 30 seconds", async () => {
    const { proc, clock, check: records } = check({ 41001: startToken(500) });
    for (let at = 0; at < START_CHECK_TTL_MS; at += 2_000) {
      expect((await records.matches([own])).get(own)).toBe("same");
      clock.now += 2_000;
    }
    expect(proc.reads).toHaveLength(1);

    // The process has ended, and another was given its pid.
    proc.tokens.set(41001, startToken(9_000));
    expect((await records.matches([own])).get(own)).toBe("different");
    expect(proc.reads).toHaveLength(2);
  });

  test("a token that cannot be read, or a record with none, cannot be told", async () => {
    const { proc, clock, check: records } = check({});
    expect((await records.matches([own])).get(own)).toBe("unknown");

    proc.fails = true;
    clock.now += START_CHECK_TTL_MS;
    expect((await records.matches([own])).get(own)).toBe("unknown");

    const untokened = { pid: 41001, startedAt: REGISTERED, procStart: null };
    const reads = proc.reads.length;
    expect((await records.matches([untokened])).get(untokened)).toBe("unknown");
    // A record with no token is not asked about.
    expect(proc.reads).toHaveLength(reads);
  });
});
