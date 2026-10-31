import { describe, expect, test } from "vitest";

import { SQLITE_LOCATIONS, SQLITE_TIMEOUT_MS } from "@collector/adapters/antigravity/app/summaries";
import {
  createSqliteFinder,
  hasWalResetBug,
  HERMES_SQLITE_LOCATIONS,
  HOMEBREW_KEG_LOCATIONS,
  OUT_OF_TIME,
  parseSqliteVersion,
  readTimeUntil,
  runWithin,
  timeoutWithin,
  VERSION_ARGS,
  versionText,
  type SqliteVersion,
} from "@collector/adapters/hermes-agent/sqlite";
import {
  handClock,
  readTime,
  standInSqlite,
  versionLine,
} from "@tests/support/adapters/hermesAgentAdapter";

const KEG = "/opt/homebrew/opt/sqlite/bin/sqlite3";

describe("hasWalResetBug, Hermes Agent's own test", () => {
  // Hermes Agent counts SQLite from 3.7.0 up to, not including, 3.51.3 as
  // having the bug, except 3.44.6 and the later 3.44 releases, and 3.50.7 and
  // the later 3.50 releases (`hermes_cli/sqlite_runtime.py`).
  test.each<[string, boolean]>([
    ["3.6.23", false],
    ["3.7.0", true],
    ["3.31.1", true],
    ["3.44.5", true],
    ["3.44.6", false],
    ["3.44.9", false],
    ["3.45.0", true],
    ["3.45.1", true],
    ["3.50.4", true],
    ["3.50.6", true],
    ["3.50.7", false],
    ["3.50.9", false],
    ["3.51.0", true],
    ["3.51.2", true],
    ["3.51.3", false],
    ["3.52.0", false],
    ["3.53.0", false],
    ["4.0.0", false],
  ])("%s: %s", (written, vulnerable) => {
    const version = parseSqliteVersion(versionLine(written));
    expect(version).not.toBeNull();
    expect(hasWalResetBug(version as SqliteVersion)).toBe(vulnerable);
  });
});

describe("parseSqliteVersion", () => {
  test("reads the version sqlite3 --version prints first", () => {
    expect(parseSqliteVersion(versionLine("3.51.0"))).toEqual([3, 51, 0]);
    expect(parseSqliteVersion("  3.53.0\n")).toEqual([3, 53, 0]);
    // A version with no patch is the first of its line, as Hermes Agent reads it.
    expect(parseSqliteVersion("3.51 2025-06-12")).toEqual([3, 51, 0]);
    expect(versionText([3, 51, 0])).toBe("3.51.0");
  });

  test("reads nothing from anything else, which then fails the test", () => {
    for (const printed of [
      "",
      "\n",
      "SQLite version 3.51.0",
      "v3.51.0",
      "3",
      "3.",
      "3.51.0-beta",
      "3.51.0.1 2026-01-01",
      "Error: unknown option: --version",
      "12345.1.1",
    ]) {
      expect(parseSqliteVersion(printed), printed).toBeNull();
    }
  });
});

test("Hermes Agent's places are the other adapters', then Homebrew's own, which the other adapters leave alone", () => {
  expect(HOMEBREW_KEG_LOCATIONS).toEqual([
    "/opt/homebrew/opt/sqlite/bin/sqlite3",
    "/usr/local/opt/sqlite/bin/sqlite3",
  ]);
  expect(HERMES_SQLITE_LOCATIONS).toEqual([...SQLITE_LOCATIONS, ...HOMEBREW_KEG_LOCATIONS]);
  expect([...SQLITE_LOCATIONS]).toEqual([
    "/usr/bin/sqlite3",
    "/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/opt/local/bin/sqlite3",
  ]);
  for (const keg of HOMEBREW_KEG_LOCATIONS) expect(SQLITE_LOCATIONS).not.toContain(keg);
  // Never on PATH: every place is a whole path.
  for (const place of HERMES_SQLITE_LOCATIONS) expect(place.startsWith("/")).toBe(true);
});

describe("createSqliteFinder", () => {
  test("for any database, the first sqlite3 at the fixed places, asked nothing", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const finder = sqlite.finder();
    expect(await finder.pick("any")).toEqual({
      kind: "found",
      path: "/usr/bin/sqlite3",
      version: null,
    });
    expect(sqlite.versionRuns).toEqual([]);
    expect(finder.lastWalSafe()).toBeNull();
  });

  test("for a live -wal, the first that passes Hermes Agent's test, each place asked in order", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install("/usr/local/bin/sqlite3", "3.45.1");
    sqlite.install(KEG, "3.53.0");
    const finder = sqlite.finder();
    const picked = await finder.pick("wal-safe");
    expect(picked).toEqual({ kind: "found", path: KEG, version: [3, 53, 0] });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", "/usr/local/bin/sqlite3", KEG]);
    expect(finder.lastWalSafe()).toEqual(picked);
    // The version is asked with -init /dev/null before --version, so no ~/.sqliterc runs before it.
    expect(VERSION_ARGS).toEqual(["-init", "/dev/null", "--version"]);
  });

  test("stops at the first that passes", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.53.0");
    sqlite.install(KEG, "3.53.0");
    expect(await sqlite.finder().pick("wal-safe")).toMatchObject({ path: "/usr/bin/sqlite3" });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3"]);
  });

  test("when none passes, names the first found and its version", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install("/opt/homebrew/bin/sqlite3", "3.45.0");
    const finder = sqlite.finder();
    const picked = await finder.pick("wal-safe");
    expect(picked).toEqual({ kind: "vulnerable", path: "/usr/bin/sqlite3", version: [3, 51, 0] });
    expect(finder.lastWalSafe()).toEqual(picked);
  });

  test("a version it cannot read fails the test, and is named as none", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", null);
    expect(await sqlite.finder().pick("wal-safe")).toEqual({
      kind: "vulnerable",
      path: "/usr/bin/sqlite3",
      version: null,
    });
  });

  test("with none at the fixed places, there is none, for either need", async () => {
    const sqlite = standInSqlite();
    sqlite.uninstall("/usr/bin/sqlite3");
    const finder = sqlite.finder();
    expect(await finder.pick("any")).toEqual({ kind: "none" });
    expect(await finder.pick("wal-safe")).toEqual({ kind: "none" });
    expect(finder.lastWalSafe()).toEqual({ kind: "none" });
    expect(sqlite.versionRuns).toEqual([]);
  });

  test("asks each program its version once, and again only when the program there changes", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    const finder = sqlite.finder();
    for (let poll = 0; poll < 3; poll += 1) {
      expect((await finder.pick("wal-safe")).kind).toBe("vulnerable");
    }
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3"]);

    // The system's sqlite3 is updated in place: a new program, asked again.
    sqlite.install("/usr/bin/sqlite3", "3.51.3");
    expect(await finder.pick("wal-safe")).toEqual({
      kind: "found",
      path: "/usr/bin/sqlite3",
      version: [3, 51, 3],
    });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", "/usr/bin/sqlite3"]);
    await finder.pick("wal-safe");
    expect(sqlite.versionRuns).toHaveLength(2);
  });

  test("a program that cannot be looked at is asked its version every time, since a change could not be seen", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.unreadable("/usr/bin/sqlite3");
    const finder = sqlite.finder();
    await finder.pick("wal-safe");
    await finder.pick("wal-safe");
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", "/usr/bin/sqlite3"]);
  });

  test("a finder that throws inside answers none", async () => {
    const finder = createSqliteFinder({
      locations: ["/usr/bin/sqlite3"],
      isExecutable: () => Promise.reject(new Error("A check that throws.")),
    });
    expect(await finder.pick("any")).toEqual({ kind: "none" });
    expect(await finder.pick("wal-safe")).toEqual({ kind: "none" });
  });

  test("looks only at the places it is given", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/elsewhere/sqlite3", "3.53.0");
    expect(await sqlite.finder().pick("any")).toMatchObject({ path: "/usr/bin/sqlite3" });
    expect(await sqlite.finder(["/elsewhere/sqlite3"]).pick("wal-safe")).toMatchObject({
      kind: "found",
      path: "/elsewhere/sqlite3",
    });
  });
});

describe("runWithin, a run of sqlite3 within the time left", () => {
  test("after the first run, gets its own 5 seconds or what is left, whichever is less, rounded up to a whole millisecond", async () => {
    const given: number[] = [];
    const run = async (timeoutMs: number) => (given.push(timeoutMs), { ok: true, stdout: "" });
    for (const left of [Number.POSITIVE_INFINITY, 60_000, SQLITE_TIMEOUT_MS, 1_200, 1, 0.25]) {
      expect(
        await runWithin(
          readTime(() => left),
          run,
        ),
      ).toEqual({ ok: true, stdout: "" });
    }
    expect(given).toEqual([SQLITE_TIMEOUT_MS, SQLITE_TIMEOUT_MS, SQLITE_TIMEOUT_MS, 1_200, 1, 1]);
  });

  test("the first run of its time gets its whole 5 seconds, however little is left, and marks the time as started", async () => {
    const given: number[] = [];
    const run = async (timeoutMs: number) => (given.push(timeoutMs), { ok: true, stdout: "" });
    const time = readTime(() => 1_200, false);
    await runWithin(time, run);
    expect(time.started).toBe(true);
    await runWithin(time, run);
    expect(given).toEqual([SQLITE_TIMEOUT_MS, 1_200]);
    expect(timeoutWithin(readTime(() => 1, false))).toBe(SQLITE_TIMEOUT_MS);
    expect(timeoutWithin(readTime(() => 0, false))).toBeNull();
  });

  test("starts nothing once nothing is left, first run or not", async () => {
    let started = 0;
    const run = async () => (started++, { ok: true as const, stdout: "" });
    for (const left of [0, -1, -60_000, Number.NaN]) {
      for (const first of [true, false]) {
        const time = readTime(() => left, !first);
        expect(await runWithin(time, run)).toBe(OUT_OF_TIME);
        expect(time.started).toBe(!first);
      }
    }
    expect(started).toBe(0);
  });

  test("an answer that did not come is cut short only when the time left made its timeout shorter and nothing is left after it", async () => {
    const clock = handClock(0);
    const left = () => 5_000 - clock.now();
    const takes = (ms: number, ok: boolean) => async (timeoutMs: number) => {
      clock.advance(Math.min(ms, timeoutMs));
      return ok && ms <= timeoutMs
        ? { ok: true as const, stdout: "3.53.0" }
        : { ok: false as const };
    };
    // Given its whole 5 seconds, failed at once.
    expect(await runWithin(readTime(left), takes(1_000, false))).toEqual({ ok: false });
    // Given the 4 left, and stopped at them.
    expect(await runWithin(readTime(left), takes(9_000, true))).toBe(OUT_OF_TIME);
    // Given the 2 left, failed with 1 still left.
    clock.set(3_000);
    expect(await runWithin(readTime(left), takes(1_000, false))).toEqual({ ok: false });
    // One that answered is taken, however late.
    clock.set(4_000);
    const late = async () => (clock.advance(9_000), { ok: true as const, stdout: "3.53.0" });
    expect(await runWithin(readTime(left), late)).toEqual({ ok: true, stdout: "3.53.0" });
  });

  test("a run that had its whole 5 seconds and did not answer in them did not work, though nothing is left after it", async () => {
    for (const first of [true, false]) {
      const clock = handClock(0);
      const time = readTime(() => SQLITE_TIMEOUT_MS - clock.now(), !first);
      const hangs = async (timeoutMs: number) => (clock.advance(timeoutMs), { ok: false as const });
      expect(await runWithin(time, hangs)).toEqual({ ok: false });
      expect(time.left()).toBe(0);
    }
    // The first run of a poll begun late is given its whole 5 seconds too, and so is not cut short.
    const clock = handClock(0);
    const time = readTime(() => 300 - clock.now(), false);
    const hangs = async (timeoutMs: number) => (clock.advance(timeoutMs), { ok: false as const });
    expect(await runWithin(time, hangs)).toEqual({ ok: false });
    expect(clock.now()).toBe(SQLITE_TIMEOUT_MS);
  });
});

describe("createSqliteFinder, within the time left", () => {
  test("each version is asked with its own 5 seconds or what is left, whichever is less", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    expect(
      await sqlite.finder().pick(
        "wal-safe",
        readTime(() => 3_000),
      ),
    ).toMatchObject({
      path: KEG,
    });
    expect(sqlite.timed.map((run) => [run.kind, run.timeoutMs])).toEqual([
      ["version", 3_000],
      ["version", 3_000],
    ]);
  });

  test("with no time given, each version gets the whole 5 seconds", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    await sqlite.finder().pick("wal-safe");
    expect(sqlite.timed.map((run) => run.timeoutMs)).toEqual([
      SQLITE_TIMEOUT_MS,
      SQLITE_TIMEOUT_MS,
    ]);
  });

  test("with nothing left, a version that has to be asked is not, and the pick is out of time, not none", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    const finder = sqlite.finder();
    expect(
      await finder.pick(
        "wal-safe",
        readTime(() => 0),
      ),
    ).toEqual({ kind: "out-of-time" });
    expect(sqlite.versionRuns).toEqual([]);
    expect(finder.lastWalSafe()).toBeNull();
  });

  test("for any database, the first found, whatever is left, since nothing is asked", async () => {
    const sqlite = standInSqlite();
    expect(
      await sqlite.finder().pick(
        "any",
        readTime(() => 0),
      ),
    ).toEqual({
      kind: "found",
      path: "/usr/bin/sqlite3",
      version: null,
    });
    expect(sqlite.timed).toEqual([]);
  });

  test("a version cut short is not kept as none printed, so the place is asked again, and what Sources shows stands", async () => {
    const clock = handClock(0);
    const sqlite = standInSqlite({}, { slow: { clock, takesMs: 2_000 } });
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const finder = sqlite.finder();
    // 1 second is left: the first place's version is cut short.
    expect(
      await finder.pick(
        "wal-safe",
        readTime(() => 1_000 - clock.now()),
      ),
    ).toEqual({
      kind: "out-of-time",
    });
    expect(finder.lastWalSafe()).toBeNull();
    // With time, the first place is asked again, and the next after it.
    const found = await finder.pick("wal-safe");
    expect(found).toEqual({ kind: "found", path: KEG, version: [3, 53, 0] });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", "/usr/bin/sqlite3", KEG]);

    // Homebrew's sqlite3 is updated, and asked again with no time left: the last pick stands.
    sqlite.install(KEG, "3.54.0");
    expect(
      await finder.pick(
        "wal-safe",
        readTime(() => 0),
      ),
    ).toEqual({ kind: "out-of-time" });
    expect(finder.lastWalSafe()).toEqual(found);
    // Of a partly asked list, no place is named as the first with the bug either.
    sqlite.uninstall(KEG);
    sqlite.install("/usr/local/bin/sqlite3", "3.53.0");
    expect(
      await finder.pick(
        "wal-safe",
        readTime(() => 0),
      ),
    ).toEqual({ kind: "out-of-time" });
    expect(finder.lastWalSafe()).toEqual(found);
  });

  test("a version that did not answer in its whole 5 seconds is kept as none printed, so the next place is asked on the next pick, and that one is not asked again", async () => {
    const clock = handClock(0);
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    // The first place's program never answers its version, and is stopped at its timeout.
    const runVersion = async (candidate: string, timeoutMs: number) => {
      if (candidate === "/usr/bin/sqlite3") {
        sqlite.versionRuns.push(candidate);
        clock.advance(timeoutMs);
        return { ok: false as const };
      }
      return sqlite.runVersion(candidate, timeoutMs);
    };
    const finder = createSqliteFinder({
      locations: ["/usr/bin/sqlite3", KEG],
      isExecutable: sqlite.isExecutable,
      identity: sqlite.identity,
      runVersion,
    });
    const poll = () => readTimeUntil(clock.now() + SQLITE_TIMEOUT_MS, clock.now);
    // As a poll's first run it has its whole 5 seconds, which leaves nothing for the next place.
    expect(await finder.pick("wal-safe", poll())).toEqual({ kind: "out-of-time" });
    expect(clock.now()).toBe(SQLITE_TIMEOUT_MS);
    // The next poll asks the next place, and not the first again.
    expect(await finder.pick("wal-safe", poll())).toEqual({
      kind: "found",
      path: KEG,
      version: [3, 53, 0],
    });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", KEG]);
    expect(await finder.pick("wal-safe", poll())).toMatchObject({ kind: "found", path: KEG });
    expect(sqlite.versionRuns).toHaveLength(2);
  });

  test("a pick that needs no version asked answers with no time left: one already known, one refused, or none there", async () => {
    const sqlite = standInSqlite();
    sqlite.install("/usr/bin/sqlite3", "3.51.0");
    sqlite.install(KEG, "3.53.0");
    const finder = sqlite.finder();
    const found = await finder.pick("wal-safe");
    expect(found).toEqual({ kind: "found", path: KEG, version: [3, 53, 0] });
    expect(sqlite.versionRuns).toEqual(["/usr/bin/sqlite3", KEG]);

    const none = () => readTime(() => 0);
    expect(await finder.pick("wal-safe", none())).toEqual(found);
    sqlite.uninstall(KEG);
    const refused = { kind: "vulnerable", path: "/usr/bin/sqlite3", version: [3, 51, 0] };
    expect(await finder.pick("wal-safe", none())).toEqual(refused);
    expect(finder.lastWalSafe()).toEqual(refused);
    sqlite.uninstall("/usr/bin/sqlite3");
    expect(await finder.pick("wal-safe", none())).toEqual({ kind: "none" });
    expect(finder.lastWalSafe()).toEqual({ kind: "none" });
    // No version was asked again.
    expect(sqlite.versionRuns).toHaveLength(2);
  });
});
