import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runSqlite, SQLITE_TIMEOUT_MS } from "@collector/adapters/antigravity/app/summaries";
import {
  createSqliteFinder,
  HERMES_SQLITE_LOCATIONS,
  parseSqliteVersion,
  VERSION_ARGS,
} from "@collector/adapters/hermes-agent/sqlite";
import { isExecutableFile } from "@collector/files/paths";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

// How the adapter asks a sqlite3 its version, run for real. sqlite3 runs the
// person's own ~/.sqliterc before it answers even --version, and finds the
// home folder from the account, not from HOME, so a test that set HOME to an
// empty folder would still run the real one. Every run here names its own
// init file, /dev/null or one this test writes. Where there is no sqlite3, as
// on Windows, there is nothing to run.

/** Every sqlite3 at the places the adapter looks for one to read Hermes Agent, in order. */
const found = await (async () => {
  if (process.platform === "win32") return [];
  const each: string[] = [];
  for (const place of HERMES_SQLITE_LOCATIONS) {
    if (await isExecutableFile(place)) each.push(place);
  }
  return each;
})();

// A stand-in sqlite3 is a POSIX sh script, which Windows cannot run.
describe.skipIf(process.platform === "win32")("the adapter's own finder", () => {
  test("asks a sqlite3 its version with -init /dev/null before --version, and reads what it prints", async () => {
    const written = path.join(await tempDir(), "arguments");
    const stub = await writeStub(
      [
        `printf '%s\\n' "$@" > '${written}'`,
        "echo '3.53.0 2026-04-09 11:41:38 0000000000000000000000000000000000000000000000000000000000000000 (64-bit)'",
      ].join("\n"),
    );
    const finder = createSqliteFinder({ locations: [stub] });
    expect(await finder.pick("wal-safe")).toEqual({
      kind: "found",
      path: stub,
      version: [3, 53, 0],
    });
    expect((await readFile(written, "utf8")).split("\n").filter(Boolean)).toEqual([
      "-init",
      "/dev/null",
      "--version",
    ]);
  });

  test("gives the program it asks its version, after a poll's first run, no more than the time left, so one that hangs is stopped then, and nothing of it is kept", async () => {
    const stub = await writeStub("exec /bin/sleep 30");
    const finder = createSqliteFinder({ locations: [stub] });
    const from = Date.now();
    const deadline = from + 1_000;
    const time = { left: () => deadline - Date.now(), started: true };
    expect(await finder.pick("wal-safe", time)).toEqual({
      kind: "out-of-time",
    });
    const elapsed = Date.now() - from;
    // Stopped at the second it was given, not at once and not at its own 5.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(SQLITE_TIMEOUT_MS - 1_000);
    expect(finder.lastWalSafe()).toBeNull();
  });
});

describe.skipIf(found.length === 0)("each real sqlite3 at the fixed places", () => {
  test("runs the init file it is given before it answers --version, so one that printed would make the version unreadable", async () => {
    // What the person's own ~/.sqliterc would do, were -init /dev/null not given.
    const init = path.join(await tempDir(), "init.sql");
    await writeFile(init, ".print printed-by-an-init-file\n");
    for (const sqlite of found) {
      const answer = await runSqlite(sqlite, ["-init", init, "--version"]);
      expect(answer.ok, sqlite).toBe(true);
      if (!answer.ok) continue;
      expect(answer.stdout.split("\n")[0], sqlite).toBe("printed-by-an-init-file");
      expect(parseSqliteVersion(answer.stdout), sqlite).toBeNull();
    }
  });

  test("prints only its version for the adapter's arguments, which is read", async () => {
    for (const sqlite of found) {
      const answer = await runSqlite(sqlite, VERSION_ARGS);
      expect(answer.ok, sqlite).toBe(true);
      if (!answer.ok) continue;
      expect(answer.stdout.trim().split("\n"), sqlite).toHaveLength(1);
      expect(parseSqliteVersion(answer.stdout), sqlite).not.toBeNull();
    }
  });
});
