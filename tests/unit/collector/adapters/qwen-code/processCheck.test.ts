import { describe, expect, test } from "vitest";

import {
  createRecordProcessCheck,
  recordProcessMatch,
} from "@collector/adapters/qwen-code/processCheck";
import { START_CHECK_TTL_MS } from "@collector/processes/processStart";
import { lstart } from "@tests/fixtures/antigravity";
import { MINUTE, NOW, SECOND } from "@tests/fixtures/qwen-code/qwenCode";
import { standInStarts } from "@tests/support/adapters/qwenCodeAdapter";

const REGISTERED = NOW - 30 * MINUTE;

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
    const confirmed = await records.confirmed([own, reused]);

    expect([...confirmed]).toEqual([own]);
    expect(ps.runs).toEqual([[41001, 41002]]);
  });

  test("asks ps again only after 30 seconds", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    for (let at = 0; at < START_CHECK_TTL_MS; at += 2_000) {
      expect((await records.confirmed([own])).has(own)).toBe(true);
      clock.now += 2_000;
    }
    expect(ps.runs).toHaveLength(1);

    // The pid has gone to another program since.
    ps.starts.set(41001, NOW + 20 * SECOND);
    expect((await records.confirmed([own])).has(own)).toBe(false);
    expect(ps.runs).toHaveLength(2);
  });

  test("confirms nothing when ps fails, does not list the process, or the record has no time", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    ps.fails = true;
    expect((await records.confirmed([own])).size).toBe(0);

    ps.fails = false;
    clock.now += START_CHECK_TTL_MS;
    expect((await records.confirmed([{ pid: 41003, startedAt: REGISTERED }])).size).toBe(0);

    const untimed = { pid: 41001, startedAt: null };
    const runs = ps.runs.length;
    expect((await records.confirmed([untimed])).size).toBe(0);
    // A record with no time is not asked about.
    expect(ps.runs).toHaveLength(runs);
  });

  test("tells two records of one pid apart by when each was written", async () => {
    const { check: records } = check({ 41001: REGISTERED + 10 * MINUTE });
    const earlier = { pid: 41001, startedAt: REGISTERED };
    const later = { pid: 41001, startedAt: REGISTERED + 10 * MINUTE + SECOND };
    const confirmed = await records.confirmed([earlier, later]);

    expect([...confirmed]).toEqual([later]);
  });

  test("with no record, ps is not run", async () => {
    const { ps, check: records } = check({});
    expect((await records.confirmed([])).size).toBe(0);
    expect(ps.runs).toEqual([]);
  });

  test("a clock that was set back asks ps again", async () => {
    const { ps, clock, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    expect((await records.confirmed([own])).has(own)).toBe(true);

    // The clock was set back 20 minutes, and since then the pid has gone to
    // another program, which started after the record was written.
    clock.now -= 20 * MINUTE;
    ps.starts.set(41001, clock.now - MINUTE);
    expect((await records.confirmed([own])).has(own)).toBe(false);
    expect(ps.runs).toHaveLength(2);
  });

  test("does not confirm a record written ahead of the clock", async () => {
    const ahead = { pid: 41001, startedAt: NOW + 60 * MINUTE };
    const { ps, check: records } = check({ 41001: NOW });

    expect((await records.confirmed([ahead])).size).toBe(0);
    expect(ps.runs).toEqual([[41001]]);
  });

  test("forgets a record it is no longer asked about, and asks again when it comes back", async () => {
    const { ps, check: records } = check({ 41001: REGISTERED - 2 * SECOND });
    await records.confirmed([own]);
    await records.confirmed([]);
    await records.confirmed([own]);

    expect(ps.runs).toHaveLength(2);
  });
});
