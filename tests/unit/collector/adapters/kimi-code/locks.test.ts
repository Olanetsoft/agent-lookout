import { describe, expect, test } from "vitest";

import {
  createLockReader,
  LOCK_LIMIT_BYTES,
  parseLock,
  sessionOfLockFile,
} from "@collector/adapters/kimi-code/locks";
import {
  KIMI_HOME,
  LOCKED_AT,
  lockFile,
  lockText,
  NOW,
  PID,
  sessionIdOf,
} from "@tests/fixtures/kimi-code/kimiCode";
import { memoryFiles, oneChangeEach } from "@tests/support/adapters/kimi-code/kimiCodeAdapter";

const ID = sessionIdOf(1);
const OTHER = sessionIdOf(2);
const LOCKS = `${KIMI_HOME}/locks/sessions`;

describe("parseLock", () => {
  test("takes the process and the time, and nothing else", () => {
    expect(parseLock(lockText())).toEqual({ pid: PID, startedAt: LOCKED_AT });
  });

  test("a lock that names no process or no time names nothing", () => {
    for (const changes of [
      { pid: "x" },
      { pid: 0 },
      { pid: -1 },
      { pid: 1.5 },
      { pid: null },
      { startedAt: "soon" },
      { startedAt: null },
      { startedAt: 1.5 },
      { startedAt: Number.MAX_VALUE },
    ]) {
      expect(parseLock(lockText(changes)), JSON.stringify(changes)).toBeNull();
    }
    for (const text of ["", "not json", "null", "[]"]) {
      expect(parseLock(text), text).toBeNull();
    }
  });
});

describe("sessionOfLockFile", () => {
  test("reads a lock's name, and no temporary file of Kimi Code's", () => {
    expect(sessionOfLockFile(`${ID}.lock`)).toBe(ID);
    expect(sessionOfLockFile(`${ID}.lock.reclaim`)).toBeNull();
    expect(sessionOfLockFile(`${ID}.lock.tmp-41001-abc`)).toBeNull();
    expect(sessionOfLockFile(".lock")).toBeNull();
    expect(sessionOfLockFile("../escape.lock")).toBeNull();
    expect(sessionOfLockFile("notes.txt")).toBeNull();
  });
});

describe("createLockReader", () => {
  const setUp = (write = true) => {
    const files = memoryFiles(() => NOW);
    if (write) files.write(lockFile(ID), lockText());
    return { files, locks: createLockReader(KIMI_HOME, files.io) };
  };

  test("with no folder there are no locks, as before Kimi Code's first session", async () => {
    const { locks } = setUp(false);
    expect(await locks.read()).toEqual(new Map());
  });

  test("reads each lock, and leaves other files alone", async () => {
    const { files, locks } = setUp();
    files.write(`${LOCKS}/${ID}.lock.reclaim`, lockText({ pid: 7 }));
    files.write(`${LOCKS}/notes.txt`, "placeholder");
    expect(await locks.read()).toEqual(new Map([[ID, { pid: PID, startedAt: LOCKED_AT }]]));
    expect(files.opened()).toEqual([lockFile(ID)]);
  });

  test("reads a lock only when it changes, and forgets one that went", async () => {
    const { files, locks } = setUp();
    await locks.read();
    await locks.read();
    expect(files.opened()).toHaveLength(1);

    files.write(lockFile(ID), lockText({ pid: 7 }));
    expect((await locks.read())?.get(ID)?.pid).toBe(7);

    files.remove(lockFile(ID));
    expect(await locks.read()).toEqual(new Map());
  });

  test.each(oneChangeEach(lockText(), NOW))(
    "reads a lock again when only its %s changes",
    async (_what, change) => {
      const { files, locks } = setUp();
      await locks.read();
      change(files, lockFile(ID));
      files.forget();
      await locks.read();
      expect(files.opened()).toEqual([lockFile(ID)]);
    },
  );

  test("a lock that is broken or over the limit is there, and names nothing", async () => {
    const { files, locks } = setUp();
    files.write(lockFile(OTHER), "{ not json");
    files.write(lockFile(sessionIdOf(3)), "x".repeat(LOCK_LIMIT_BYTES + 1));
    const read = await locks.read();
    expect(read?.get(OTHER)).toBeNull();
    expect(read?.has(sessionIdOf(3))).toBe(true);
    expect(read?.get(sessionIdOf(3))).toBeNull();
    expect(files.reads.some(({ path }) => path === lockFile(sessionIdOf(3)))).toBe(false);
  });

  test("a read that fails is no fact about the file: what was read stands, and it is tried again", async () => {
    const { files, locks } = setUp();
    await locks.read();
    files.write(lockFile(ID), lockText({ pid: 7 }));
    files.failOpen(lockFile(ID));
    expect((await locks.read())?.get(ID)?.pid).toBe(PID);

    files.heal(lockFile(ID));
    expect((await locks.read())?.get(ID)?.pid).toBe(7);
  });

  test("a look that fails leaves what was read too", async () => {
    const { files, locks } = setUp();
    await locks.read();
    files.fail(lockFile(ID));
    expect((await locks.read())?.get(ID)?.pid).toBe(PID);
  });

  test("a first read that fails names nothing, until it works", async () => {
    const { files, locks } = setUp();
    files.failOpen(lockFile(ID));
    expect((await locks.read())?.get(ID)).toBeNull();
    files.heal(lockFile(ID));
    expect((await locks.read())?.get(ID)?.pid).toBe(PID);
  });

  test("a link in place of a lock names nothing, and is not opened", async () => {
    const { files, locks } = setUp(false);
    files.special(lockFile(ID));
    expect((await locks.read())?.get(ID)).toBeNull();
    expect(files.opened()).toEqual([]);
  });

  test("a link in place of the folder is not listed", async () => {
    const { files, locks } = setUp(false);
    files.special(LOCKS);
    expect(await locks.read()).toEqual(new Map());
    expect(files.count("readdir")).toBe(0);
  });

  test("a folder that cannot be listed is null, not a folder of no locks", async () => {
    const { files, locks } = setUp();
    files.fail(LOCKS);
    expect(await locks.read()).toBeNull();
  });
});
