import { describe, expect, test } from "vitest";

import {
  readWriterLocks,
  threadIdOfLock,
  WRITER_LOCK_DIR,
} from "@collector/adapters/codex/writerLocks";
import { CODEX_HOME, ids, lockPath, threadId } from "@tests/fixtures/codex";
import { memoryFiles } from "@tests/support/adapters/codexAdapter";

const LOCKS = `${CODEX_HOME}/${WRITER_LOCK_DIR}`;

describe("threadIdOfLock", () => {
  test("a lock named for a thread gives the thread's id, in lowercase", () => {
    expect(threadIdOfLock(`${ids.working}.lock`)).toBe(ids.working);
    expect(threadIdOfLock("0199A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B.lock")).toBe(
      "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    );
  });

  test.each([
    // The lock that guards the folder itself.
    ".coordination.lock",
    "notes.lock",
    ".lock",
    `${ids.working}`,
    `${ids.working}.lock.tmp`,
    `${ids.working}.LOCK.bak`,
    `x${ids.working}.lock`,
    "00000000-0000-4000-8000-00000000c1.lock",
  ])("%j names no thread", (name) => {
    expect(threadIdOfLock(name)).toBeNull();
  });
});

describe("readWriterLocks", () => {
  test("lists the folder and gives the open threads, skipping names that are not threads", async () => {
    const files = memoryFiles();
    files.write(lockPath(CODEX_HOME, ids.working), "");
    files.write(lockPath(CODEX_HOME, ids.idle.toUpperCase()), "");
    files.write(`${LOCKS}/.coordination.lock`, "");
    files.write(`${LOCKS}/notes.lock`, "");

    const locks = await readWriterLocks(LOCKS, files.io);
    expect(locks).toEqual({ supported: true, open: new Set([ids.working, ids.idle]) });
  });

  test("only lists the folder: no lock file is opened, or even looked at", async () => {
    const files = memoryFiles();
    files.write(lockPath(CODEX_HOME, ids.working), "");
    files.write(`${LOCKS}/.coordination.lock`, "");
    await readWriterLocks(LOCKS, files.io);
    expect(files.calls).toEqual([{ method: "readdir", path: LOCKS }]);
  });

  test("an empty folder means no session is open", async () => {
    const files = memoryFiles();
    files.mkdir(LOCKS);
    expect(await readWriterLocks(LOCKS, files.io)).toEqual({ supported: true, open: new Set() });
  });

  test("a missing folder, as with a Codex older than 0.155, means open sessions cannot be told apart", async () => {
    const files = memoryFiles();
    files.mkdir(CODEX_HOME);
    expect(await readWriterLocks(LOCKS, files.io)).toEqual({ supported: false, missing: true });
  });

  test("a folder that cannot be listed is not missing, and is not trusted either", async () => {
    const files = memoryFiles();
    files.write(lockPath(CODEX_HOME, threadId("c1")), "");
    files.fail(LOCKS, "EACCES");
    expect(await readWriterLocks(LOCKS, files.io)).toEqual({ supported: false, missing: false });
  });
});
