import { stat } from "node:fs/promises";

import {
  runSqlite,
  SQLITE_LOCATIONS,
  SQLITE_TIMEOUT_MS,
  type SqliteAnswer,
} from "../antigravity/app/summaries.ts";
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
 * Every run of `sqlite3` for Hermes Agent, these and the two questions, runs
 * within the poll's time for reading (`runWithin`). The first run of a poll
 * gets its whole 5 seconds. Each later one gets those, or what is left of the
 * poll's time when that is less, and none starts once nothing is left. A run
 * that had its whole 5 seconds and did not answer did not work, as before. One
 * whose timeout the time left cut shorter, and that did not answer by then,
 * was cut short: it is not taken as having failed, and a version it was
 * asked is asked again on the next pick.
 *
 * Built from Hermes Agent's source at v0.22.5, and not yet checked on a
 * computer running Hermes Agent.
 */

/** The time a poll's runs of `sqlite3` share. */
export interface ReadTime {
  /** How many milliseconds are left: none once it is 0 or less. */
  left(): number;
  /** Whether a run has started within it. Until one has, a run gets its whole timeout. */
  started: boolean;
}

/** Time that ends at `end` on this clock, with no run started in it yet. */
export function readTimeUntil(end: number, now: () => number): ReadTime {
  return { left: () => end - now(), started: false };
}

/** Time with no end, so every run gets its whole timeout. */
export function unlimitedTime(): ReadTime {
  return { left: () => Number.POSITIVE_INFINITY, started: false };
}

/** A run of `sqlite3` that was not started, or was cut short, because the time for reading ran out. */
export const OUT_OF_TIME = { kind: "out-of-time" } as const;
export type OutOfTime = typeof OUT_OF_TIME;

/** Whether an answer is that the time ran out. */
export function isOutOfTime(answer: unknown): answer is OutOfTime {
  return answer === OUT_OF_TIME;
}

/**
 * The timeout a run started now gets: its own 5 seconds when it is the first
 * of its time, else those or what is left, whichever is less. Null once
 * nothing is left, when none may start.
 */
export function timeoutWithin(time: ReadTime): number | null {
  const left = time.left();
  if (!(left > 0)) return null;
  return time.started ? Math.min(SQLITE_TIMEOUT_MS, Math.ceil(left)) : SQLITE_TIMEOUT_MS;
}

/**
 * Runs `sqlite3` once within the time left, with the timeout `timeoutWithin`
 * gives, and not at all once nothing is left. An answer that did not come was
 * cut short only when the time left made its timeout shorter than its own and
 * nothing is left after it. One that had its whole timeout did not work.
 */
export async function runWithin(
  time: ReadTime,
  run: (timeoutMs: number) => Promise<SqliteAnswer>,
): Promise<SqliteAnswer | OutOfTime> {
  const timeoutMs = timeoutWithin(time);
  if (timeoutMs === null) return OUT_OF_TIME;
  time.started = true;
  const answer = await run(timeoutMs);
  if (!answer.ok && timeoutMs < SQLITE_TIMEOUT_MS && !(time.left() > 0)) return OUT_OF_TIME;
  return answer;
}

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
  /**
   * The `sqlite3` to run for a need, with each version it asks run within the
   * time given (`runWithin`), unlimited when none is. Out of time when a
   * version had to be asked and the time ran out first: then nothing it
   * learned is kept as the answer, and `lastWalSafe` stays as it was. `any`
   * asks nothing, so it is never out of time. Never throws.
   */
  pick(need: SqliteNeed, time?: ReadTime): Promise<SqlitePick | OutOfTime>;
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
    /** Runs `<candidate> -init /dev/null --version`, within this timeout. */
    runVersion?: (candidate: string, timeoutMs: number) => Promise<SqliteAnswer>;
  } = {},
): SqliteFinder {
  const locations = options.locations ?? HERMES_SQLITE_LOCATIONS;
  const isExecutable = options.isExecutable ?? ((candidate) => isExecutableFile(candidate));
  const identity = options.identity ?? identityOf;
  const runVersion =
    options.runVersion ?? ((candidate, timeoutMs) => runSqlite(candidate, VERSION_ARGS, timeoutMs));
  /** Each place's version, by the identity of the program it was asked of. */
  const versions = new Map<string, { identity: string; version: SqliteVersion | null }>();
  let walSafe: SqlitePick | null = null;

  /**
   * The version of the program at a place, asked again only when it changed.
   * Null when it printed none, or did not answer in its whole 5 seconds. A run
   * cut short is not kept, so the place is asked again.
   */
  async function versionAt(
    candidate: string,
    time: ReadTime,
  ): Promise<SqliteVersion | null | OutOfTime> {
    const now = await identity(candidate);
    const known = versions.get(candidate);
    if (now !== null && known?.identity === now) return known.version;
    const answer = await runWithin(time, (timeoutMs) => runVersion(candidate, timeoutMs));
    if (isOutOfTime(answer)) return OUT_OF_TIME;
    const version = answer.ok ? parseSqliteVersion(answer.stdout) : null;
    // A program that cannot be looked at is asked again next time.
    if (now !== null) versions.set(candidate, { identity: now, version });
    else versions.delete(candidate);
    return version;
  }

  async function pick(need: SqliteNeed, time: ReadTime): Promise<SqlitePick | OutOfTime> {
    let first: { path: string; version: SqliteVersion | null } | null = null;
    for (const candidate of locations) {
      if (!(await isExecutable(candidate))) continue;
      if (need === "any") return { kind: "found", path: candidate, version: null };
      const version = await versionAt(candidate, time);
      // The places not yet asked could hold one that passes.
      if (isOutOfTime(version)) return OUT_OF_TIME;
      // A version that could not be read fails the test.
      if (version !== null && !hasWalResetBug(version)) {
        return { kind: "found", path: candidate, version };
      }
      first ??= { path: candidate, version };
    }
    return first === null ? { kind: "none" } : { kind: "vulnerable", ...first };
  }

  return {
    async pick(need, time = unlimitedTime()) {
      let picked: SqlitePick | OutOfTime;
      try {
        picked = await pick(need, time);
      } catch {
        picked = { kind: "none" };
      }
      if (need === "wal-safe" && picked.kind !== "out-of-time") walSafe = picked;
      return picked;
    },
    lastWalSafe: () => walSafe,
  };
}
