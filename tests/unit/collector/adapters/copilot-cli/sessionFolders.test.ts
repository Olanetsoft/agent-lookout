import { describe, expect, test } from "vitest";

import {
  createSessionFinder,
  isSessionFolderName,
  NotAFolderError,
} from "@collector/adapters/copilot-cli/sessionFolders";
import {
  DAY,
  eventsPath,
  MINUTE,
  NOW,
  sessionFolder,
  sessionIdOf,
  SESSIONS,
  sessionStart,
} from "@tests/fixtures/copilot-cli/copilotCli";
import {
  memoryFiles,
  touchFolder,
  writeLog,
} from "@tests/support/adapters/copilot-cli/copilotCliAdapter";

const finderOf = (files: ReturnType<typeof memoryFiles>, maxSessions?: number) =>
  createSessionFinder({ sessionsDir: SESSIONS, io: files.io, maxSessions });

const ids = (found: { refs: { id: string }[] }) => found.refs.map((ref) => ref.id);

test("only a lowercase UUID names a session's folder", () => {
  expect(isSessionFolderName(sessionIdOf(1))).toBe(true);
  for (const name of [
    sessionIdOf(1).toUpperCase(),
    `${sessionIdOf(1)}.jsonl`,
    ".session-operation-locks",
    "my-own-session",
    "detached-shells",
  ]) {
    expect(isSessionFolderName(name), name).toBe(false);
  }
});

describe("finding sessions", () => {
  test("takes each folder with an event log written in the last day, newest first", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(1), mtimeMs: NOW - 2 * MINUTE });
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(2), mtimeMs: NOW - MINUTE });
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(3), mtimeMs: NOW - 2 * DAY });
    files.touch(sessionFolder(sessionIdOf(3)), NOW - 2 * DAY);
    files.write(`${SESSIONS}/${sessionIdOf(4)}.jsonl`, sessionStart(NOW));
    files.write(`${SESSIONS}/.session-operation-locks/x`, "");
    const found = await finderOf(files).find(NOW, new Set());
    expect(ids(found)).toEqual([sessionIdOf(2), sessionIdOf(1)]);
    expect(found.link).toBe(false);
    // The legacy flat file and the dot folder are never looked up.
    expect(
      files.count(
        undefined,
        (target) => target.includes(".jsonl") && !target.endsWith("events.jsonl"),
      ),
    ).toBe(0);
    expect(files.count(undefined, (target) => target.includes(".session-operation-locks"))).toBe(0);
  });

  test("a folder made, or a lock made in it, in the last day counts though its log is older", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW), { mtimeMs: NOW - 3 * DAY });
    // The folder's own time moved within the hour.
    expect(ids(await finderOf(files).find(NOW, new Set()))).toEqual([sessionIdOf(1)]);
    files.touch(sessionFolder(), NOW - 3 * DAY);
    expect(ids(await finderOf(files).find(NOW, new Set()))).toEqual([]);
  });

  test("passes over an old session until the next sweep, unless it is wanted", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW), { mtimeMs: NOW - 2 * DAY });
    files.touch(sessionFolder(), NOW - 2 * DAY);
    const finder = finderOf(files);
    expect(ids(await finder.find(NOW, new Set()))).toEqual([]);
    files.forget();
    await finder.find(NOW + 2_000, new Set());
    expect(files.count("lstat", (target) => target === eventsPath())).toBe(0);
    expect(ids(await finder.find(NOW + 4_000, new Set([sessionIdOf(1)])))).toEqual([
      sessionIdOf(1),
    ]);
    // Written again: found at the next sweep.
    files.write(eventsPath(), sessionStart(NOW), { mtimeMs: NOW + 5_000 });
    expect(ids(await finder.find(NOW + 6_000, new Set()))).toEqual([]);
    expect(ids(await finder.find(NOW + MINUTE + 6_000, new Set()))).toEqual([sessionIdOf(1)]);
  });

  test("a folder with no log yet is looked in again when it changes", async () => {
    const files = memoryFiles();
    files.mkdir(sessionFolder());
    touchFolder(files, sessionFolder());
    touchFolder(files, SESSIONS);
    const finder = finderOf(files);
    expect(ids(await finder.find(NOW, new Set()))).toEqual([]);
    files.forget();
    expect(ids(await finder.find(NOW + 2_000, new Set()))).toEqual([]);
    expect(files.count("lstat", (target) => target === eventsPath())).toBe(0);
    // Its first message makes the log, which moves the folder's time.
    writeLog(files, sessionStart(NOW));
    expect(ids(await finder.find(NOW + 4_000, new Set()))).toEqual([sessionIdOf(1)]);
  });

  test("a new folder is found as soon as the sessions folder's time moves", async () => {
    const files = memoryFiles();
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(1) });
    const finder = finderOf(files);
    await finder.find(NOW, new Set());
    files.forget();
    await finder.find(NOW + 2_000, new Set());
    expect(files.count("readdir")).toBe(0);
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(2) });
    expect(ids(await finder.find(NOW + 4_000, new Set())).sort()).toEqual([
      sessionIdOf(1),
      sessionIdOf(2),
    ]);
  });

  test("takes at most the newest sessions it may, and every one wanted", async () => {
    const files = memoryFiles();
    for (let n = 1; n <= 4; n += 1) {
      writeLog(files, sessionStart(NOW), { id: sessionIdOf(n), mtimeMs: NOW - n * MINUTE });
      files.touch(sessionFolder(sessionIdOf(n)), 0);
    }
    expect(ids(await finderOf(files, 2).find(NOW, new Set([sessionIdOf(4)])))).toEqual([
      sessionIdOf(1),
      sessionIdOf(2),
      sessionIdOf(4),
    ]);
  });

  test("never follows a link, at the sessions folder, a session's folder or its log", async () => {
    const files = memoryFiles();
    files.special(sessionFolder(sessionIdOf(1)));
    writeLog(files, sessionStart(NOW), { id: sessionIdOf(2) });
    files.remove(eventsPath(sessionIdOf(2)));
    files.special(eventsPath(sessionIdOf(2)));
    const found = await finderOf(files).find(NOW, new Set());
    expect(found).toEqual({ refs: [], link: true });

    const linked = memoryFiles();
    linked.special(SESSIONS);
    await expect(finderOf(linked).find(NOW, new Set())).rejects.toBeInstanceOf(NotAFolderError);
  });

  test("a missing sessions folder rejects with its code", async () => {
    await expect(finderOf(memoryFiles()).find(NOW, new Set())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
