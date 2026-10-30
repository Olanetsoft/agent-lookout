import { describe, expect, test } from "vitest";

import { SQLITE_LOCATIONS } from "@collector/adapters/antigravity/app/summaries";
import {
  createSqliteFinder,
  hasWalResetBug,
  HERMES_SQLITE_LOCATIONS,
  HOMEBREW_KEG_LOCATIONS,
  parseSqliteVersion,
  VERSION_ARGS,
  versionText,
  type SqliteVersion,
} from "@collector/adapters/hermes-agent/sqlite";
import { standInSqlite, versionLine } from "@tests/support/adapters/hermesAgentAdapter";

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
