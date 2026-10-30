import { stat } from "node:fs/promises";

import { runSqlite, SQLITE_LOCATIONS, type SqliteAnswer } from "../antigravity/app/summaries.ts";
import { isExecutableFile } from "../../files/paths.ts";

/**
 * Which `sqlite3` reads Hermes Agent's databases. It is found and started as
 * for OpenCode and Antigravity (`../antigravity/app/summaries.ts`): at fixed
 * places only, never on `PATH`, directly with no shell, stdin closed and a
 * timeout. Two places are added for Hermes Agent alone, after those: the
 * folders Homebrew keeps its own `sqlite3` in, which it does not link into
 * `/opt/homebrew/bin` or `/usr/local/bin` because macOS has one.
 *
 * A database in WAL mode whose `-wal` holds something is read only with a
 * `sqlite3` that passes Hermes Agent's own test for SQLite's WAL-reset bug
 * (`hermes_cli/sqlite_runtime.py`). Hermes Agent refuses a `sqlite3` that fails
 * it even on a copy of a database: such a program, opening a live database,
 * can delete its `-wal` and `-shm` and split it in two, losing writes Hermes
 * Agent had already confirmed (`hermes_cli/session_lost_and_found.py`).
 * Each place is asked its version once, with `sqlite3 -init /dev/null
 * --version`, and again only when the program there changes. `-init
 * /dev/null` keeps it from running the person's own `~/.sqliterc`, which
 * `sqlite3` runs before it answers even `--version`. Any other database is read with the
 * first `sqlite3` found: the bug is in WAL mode alone.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** Where Homebrew keeps its own `sqlite3`, on Apple silicon and on Intel Macs. */
export const HOMEBREW_KEG_LOCATIONS = [
  "/opt/homebrew/opt/sqlite/bin/sqlite3",
  "/usr/local/opt/sqlite/bin/sqlite3",
] as const;

/** Where `sqlite3` is looked for to read Hermes Agent, in this order. Never on `PATH`. */
export const HERMES_SQLITE_LOCATIONS: readonly string[] = [
  ...SQLITE_LOCATIONS,
  ...HOMEBREW_KEG_LOCATIONS,
];

/**
 * The arguments that ask `sqlite3` its version, and nothing else: with no
 * `-init /dev/null`, it first runs `~/.sqliterc`, which can print, or run
 * commands, before the version.
 */
export const VERSION_ARGS = ["-init", "/dev/null", "--version"] as const;

/** A version of SQLite: major, minor and patch. */
export type SqliteVersion = readonly [number, number, number];

/** The version `sqlite3 --version` printed first, such as `3.51.0 2025-06-12 …`, or null. */
export function parseSqliteVersion(stdout: string): SqliteVersion | null {
  const match = /^(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?(?:\s|$)/.exec(stdout.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

/** The version as it is written: `3.51.0`. */
export function versionText(version: SqliteVersion): string {
  return version.join(".");
}

/** Whether one version comes before another. */
function before(a: SqliteVersion, b: SqliteVersion): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] as number) < (b[index] as number);
  }
  return false;
}

/**
 * Whether a SQLite has the WAL-reset bug, by Hermes Agent's own rule
 * (`is_sqlite_wal_reset_vulnerable` in `hermes_cli/sqlite_runtime.py`): from
 * 3.7.0 up to, not including, 3.51.3, except 3.44.6 and the later 3.44
 * releases, and 3.50.7 and the later 3.50 releases.
 */
export function hasWalResetBug(version: SqliteVersion): boolean {
  const safe =
    before(version, [3, 7, 0]) ||
    !before(version, [3, 51, 3]) ||
    (!before(version, [3, 50, 7]) && before(version, [3, 51, 0])) ||
    (!before(version, [3, 44, 6]) && before(version, [3, 45, 0]));
  return !safe;
}

/** What a `sqlite3` is needed for: any database, or one whose `-wal` holds something. */
export type SqliteNeed = "any" | "wal-safe";

/**
 * Which `sqlite3` to run:
 *
 * found       the first one at the fixed places, or for `wal-safe` the first that passes the test
 * none        none at any of them
 * vulnerable  for `wal-safe`, none passes: the first found, and its version, or null when it printed none
 */
export type SqlitePick =
  | { kind: "found"; path: string; version: SqliteVersion | null }
  | { kind: "none" }
  | { kind: "vulnerable"; path: string; version: SqliteVersion | null };

export interface SqliteFinder {
  /** The `sqlite3` to run for a need. Never throws. */
  pick(need: SqliteNeed): Promise<SqlitePick>;
  /** What the last `wal-safe` pick found, or null before there was one. */
  lastWalSafe(): SqlitePick | null;
}

/** A program's identity on its disk and when it last changed, so a program replaced at a place is asked again. */
async function identityOf(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

export function createSqliteFinder(
  options: {
    locations?: readonly string[];
    isExecutable?: (candidate: string) => Promise<boolean>;
    /** The program's identity, or null when it cannot be looked at. */
    identity?: (candidate: string) => Promise<string | null>;
    /** Runs `<candidate> -init /dev/null --version`. */
    runVersion?: (candidate: string) => Promise<SqliteAnswer>;
  } = {},
): SqliteFinder {
  const locations = options.locations ?? HERMES_SQLITE_LOCATIONS;
  const isExecutable = options.isExecutable ?? ((candidate) => isExecutableFile(candidate));
  const identity = options.identity ?? identityOf;
  const runVersion = options.runVersion ?? ((candidate) => runSqlite(candidate, VERSION_ARGS));
  /** Each place's version, by the identity of the program it was asked of. */
  const versions = new Map<string, { identity: string; version: SqliteVersion | null }>();
  let walSafe: SqlitePick | null = null;

  /** The version of the program at a place, asked again only when it changed. Null when it printed none. */
  async function versionAt(candidate: string): Promise<SqliteVersion | null> {
    const now = await identity(candidate);
    const known = versions.get(candidate);
    if (now !== null && known?.identity === now) return known.version;
    const answer = await runVersion(candidate);
    const version = answer.ok ? parseSqliteVersion(answer.stdout) : null;
    // A program that cannot be looked at is asked again next time.
    if (now !== null) versions.set(candidate, { identity: now, version });
    else versions.delete(candidate);
    return version;
  }

  async function pick(need: SqliteNeed): Promise<SqlitePick> {
    let first: { path: string; version: SqliteVersion | null } | null = null;
    for (const candidate of locations) {
      if (!(await isExecutable(candidate))) continue;
      if (need === "any") return { kind: "found", path: candidate, version: null };
      const version = await versionAt(candidate);
      // A version that could not be read fails the test.
      if (version !== null && !hasWalResetBug(version)) {
        return { kind: "found", path: candidate, version };
      }
      first ??= { path: candidate, version };
    }
    return first === null ? { kind: "none" } : { kind: "vulnerable", ...first };
  }

  return {
    async pick(need) {
      let picked: SqlitePick;
      try {
        picked = await pick(need);
      } catch {
        picked = { kind: "none" };
      }
      if (need === "wal-safe") walSafe = picked;
      return picked;
    },
    lastWalSafe: () => walSafe,
  };
}
