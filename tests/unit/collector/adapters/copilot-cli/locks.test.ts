import { describe, expect, test } from "vitest";

import { createLockReader, lockPidOf } from "@collector/adapters/copilot-cli/locks";
import {
  eventsPath,
  HOUR,
  lockPath,
  MINUTE,
  NOW,
  sessionFolder,
  sessionStart,
} from "@tests/fixtures/copilot-cli/copilotCli";
import {
  memoryFiles,
  removeLock,
  writeLock,
  writeLog,
} from "@tests/support/adapters/copilot-cli/copilotCliAdapter";

const FOLDER = sessionFolder();

test("a lock's name is inuse., a process ID with no leading zero, and .lock", () => {
  expect(lockPidOf("inuse.4321.lock")).toBe(4321);
  expect(lockPidOf("inuse.1.lock")).toBe(1);
  expect(lockPidOf("inuse.9999999999.lock")).toBe(9_999_999_999);
  for (const name of [
    "inuse.0.lock",
    "inuse.0123.lock",
    "inuse.12345678901.lock",
    "inuse.4321.hold",
    "inuse..lock",
    "inuse.-1.lock",
    "inuse.4321.lock.tmp",
    "xinuse.4321.lock",
    "events.jsonl",
    "workspace.yaml",
  ]) {
    expect(lockPidOf(name), name).toBeNull();
  }
});

describe("reading a session folder's locks", () => {
  test("keeps each lock's process ID and time, and never opens one or looks at another name", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW));
    writeLock(files, { pid: 4321, mtimeMs: NOW - HOUR });
    writeLock(files, { pid: 99, mtimeMs: NOW - MINUTE });
    files.write(`${FOLDER}/inuse.4321.hold`, "");
    files.write(`${FOLDER}/workspace.yaml`, "name: PRIVATE_TITLE\n");
    const reader = createLockReader(files.io);
    const locks = await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW);
    expect(locks).toEqual([
      { pid: 4321, mtimeMs: NOW - HOUR },
      { pid: 99, mtimeMs: NOW - MINUTE },
    ]);
    expect(files.opened()).toEqual([]);
    for (const name of ["inuse.4321.hold", "workspace.yaml", "events.jsonl"]) {
      expect(
        files.count(undefined, (target) => target.endsWith(name)),
        name,
      ).toBe(0);
    }
  });

  test("a lock that is not an ordinary file is not one", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW));
    files.special(lockPath(4321));
    const reader = createLockReader(files.io);
    expect(await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW)).toEqual([]);
  });

  test("lists the folder again only when its time moves, or once a minute", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW));
    const reader = createLockReader(files.io);
    expect(await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW)).toEqual([]);
    files.forget();
    expect(await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW + 2_000)).toEqual([]);
    expect(files.count("readdir")).toBe(0);

    writeLock(files, { pid: 4321 });
    expect(await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW + 4_000)).toHaveLength(1);
    removeLock(files, { pid: 4321 });
    expect(await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW + 6_000)).toEqual([]);

    // A lock made without the folder's time moving is found by the sweep.
    files.write(lockPath(77), "", { mtimeMs: NOW });
    const info = await files.io.lstat(FOLDER);
    expect(await reader.locks(FOLDER, info, NOW + 8_000)).toEqual([]);
    expect(await reader.locks(FOLDER, info, NOW + 6_000 + MINUTE)).toEqual([
      { pid: 77, mtimeMs: NOW },
    ]);
    // A clock set back counts as time enough.
    files.remove(lockPath(77));
    expect(await reader.locks(FOLDER, info, NOW)).toEqual([]);
  });

  test("a folder that cannot be listed keeps its last list, and one never listed has none", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW));
    writeLock(files, { pid: 4321 });
    const reader = createLockReader(files.io);
    files.fail(FOLDER);
    const refused = { kind: "directory" as const, size: 0, mtimeMs: 1, ino: 1 };
    expect(await reader.locks(FOLDER, refused, NOW)).toBeNull();
    files.heal(FOLDER);
    const listed = await reader.locks(FOLDER, await files.io.lstat(FOLDER), NOW);
    expect(listed).toHaveLength(1);
    files.fail(FOLDER);
    expect(await reader.locks(FOLDER, { ...refused, mtimeMs: 2 }, NOW + 2_000)).toEqual(listed);
    expect(files.count("lstat", (target) => target === eventsPath())).toBe(0);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });
});
