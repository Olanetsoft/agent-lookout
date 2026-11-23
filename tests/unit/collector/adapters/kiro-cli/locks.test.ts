import { describe, expect, test } from "vitest";

import {
  createLockReader,
  LOCK_LIMIT_BYTES,
  livenessOf,
  parseLock,
  type LockLook,
  type LockProcess,
} from "@collector/adapters/kiro-cli/locks";
import { LOCKED_AT, NOW, PID, lockText } from "@tests/fixtures/kiro-cli/kiroCli";
import { memoryFiles } from "@tests/support/adapters/kiro-cli/kiroCliAdapter";

const LOCK = "/Users/example/.kiro/sessions/0a1b2c3d4e5f6a7b/sess_x/.lock";

describe("a lock's body", () => {
  test("gives its pid and when it was taken, and nothing else", () => {
    expect(parseLock(lockText())).toEqual({ pid: PID, startedAt: LOCKED_AT });
    // As Kiro writes it on Linux, with more of its process.
    const linux = JSON.stringify({
      pid: PID,
      started_at: "2026-10-01T11:30:00.123456789Z",
      linux_boot_id: "00000000-0000-4000-8000-000000000000",
      linux_start_ticks: "12345",
    });
    expect(parseLock(linux)).toEqual({ pid: PID, startedAt: Date.UTC(2026, 9, 1, 11, 30, 0, 123) });
  });

  test("with no time that can be read still names its process", () => {
    for (const started of ["yesterday", 1_790_000_000, null, undefined]) {
      expect(parseLock(JSON.stringify({ pid: PID, started_at: started }))).toEqual({
        pid: PID,
        startedAt: null,
      });
    }
  });

  test("with no pid that could be a process's is no lock Kiro wrote", () => {
    for (const text of [
      "",
      "not json",
      "[]",
      JSON.stringify({ started_at: "2026-10-01T11:30:00Z" }),
      JSON.stringify({ pid: 0 }),
      JSON.stringify({ pid: -4 }),
      JSON.stringify({ pid: 1.5 }),
      JSON.stringify({ pid: "52001" }),
      // The settings lock's shape, which is not a session's.
      JSON.stringify({ acquired_at_ms: 1_790_000_000_000 }),
    ]) {
      expect(parseLock(text), text).toBeNull();
    }
  });
});

describe("a look at a session's lock", () => {
  test("finds none, one held, or one that cannot be read", async () => {
    const files = memoryFiles(() => NOW);
    const locks = createLockReader(files.io);
    expect(await locks.look(LOCK, false)).toEqual({ state: "none" });
    files.write(LOCK, lockText());
    expect(await locks.look(LOCK, false)).toEqual({
      state: "held",
      lock: { pid: PID, startedAt: LOCKED_AT },
    });
    files.write(LOCK, "{");
    expect(await locks.look(LOCK, false)).toEqual({ state: "unreadable" });
    files.write(LOCK, `${lockText()}${" ".repeat(LOCK_LIMIT_BYTES)}`);
    expect(await locks.look(LOCK, false)).toEqual({ state: "unreadable" });
  });

  test("never follows a link, and takes a folder for no lock only where it is told to", async () => {
    const files = memoryFiles(() => NOW);
    const locks = createLockReader(files.io);
    files.special(LOCK);
    expect(await locks.look(LOCK, true)).toEqual({ state: "unreadable" });
    expect(files.opened()).toEqual([]);
    files.remove(LOCK);
    files.mkdir(LOCK);
    expect(await locks.look(LOCK, true)).toEqual({ state: "none" });
    expect(await locks.look(LOCK, false)).toEqual({ state: "unreadable" });
  });

  test("that fails is no fact about the lock, and one that has gone since its lstat is none", async () => {
    const files = memoryFiles(() => NOW);
    const locks = createLockReader(files.io);
    files.write(LOCK, lockText());
    files.fail(LOCK);
    expect(await locks.look(LOCK, false)).toEqual({ state: "unreadable" });
    files.heal(LOCK);
    files.failOpen(LOCK, "ENOENT");
    expect(await locks.look(LOCK, false)).toEqual({ state: "none" });
  });

  test("opens a lock whose read failed again on the next look, though it has not changed", async () => {
    const files = memoryFiles(() => NOW);
    const locks = createLockReader(files.io);
    files.write(LOCK, lockText());
    files.failOpen(LOCK, "EIO");
    expect(await locks.look(LOCK, false)).toEqual({ state: "unreadable" });
    files.heal(LOCK);
    expect(await locks.look(LOCK, false)).toEqual({
      state: "held",
      lock: { pid: PID, startedAt: LOCKED_AT },
    });
  });

  test("opens a lock again only once it changed", async () => {
    const files = memoryFiles(() => NOW);
    const locks = createLockReader(files.io);
    files.write(LOCK, lockText());
    await locks.look(LOCK, false);
    files.forget();
    await locks.look(LOCK, false);
    expect(files.opened()).toEqual([]);
    files.write(LOCK, lockText(PID + 1));
    expect(await locks.look(LOCK, false)).toMatchObject({ lock: { pid: PID + 1 } });
  });
});

describe("whether a session is open", () => {
  const held = (startedAt: number | null = LOCKED_AT): LockLook => ({
    state: "held",
    lock: { pid: PID, startedAt },
  });
  const facts = (changes: Partial<LockProcess> = {}): LockProcess => ({
    alive: true,
    bootedAt: NOW - 86_400_000,
    match: "same",
    ...changes,
  });

  test("is open while the lock's process runs and started no later than the lock, give or take a minute", () => {
    expect(livenessOf(held(), facts())).toBe("open");
  });

  test("is closed with no lock, a process that has ended, another program's pid or a lock older than the computer's start", () => {
    expect(livenessOf({ state: "none" }, undefined)).toBe("closed");
    expect(livenessOf(held(), facts({ alive: false }))).toBe("closed");
    expect(livenessOf(held(), facts({ match: "different" }))).toBe("closed");
    expect(livenessOf(held(), facts({ bootedAt: LOCKED_AT + 1, match: null }))).toBe("closed");
    // A process that ended says so whatever the lock's time.
    expect(livenessOf(held(null), facts({ alive: false }))).toBe("closed");
  });

  test("is not known for a lock that cannot be read, has no time, or whose process's start cannot be checked", () => {
    expect(livenessOf({ state: "unreadable" }, undefined)).toBe("unknown");
    expect(livenessOf(held(null), facts())).toBe("unknown");
    expect(livenessOf(held(), facts({ match: "unknown" }))).toBe("unknown");
    expect(livenessOf(held(), facts({ match: null }))).toBe("unknown");
    expect(livenessOf(held(), undefined)).toBe("unknown");
  });
});
