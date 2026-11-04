import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createSessionFileFinder,
  MAX_SESSIONS,
  sessionFilePath,
  SWEEP_MS,
} from "@collector/adapters/continue/sessionFiles";
import type { IndexedSession } from "@collector/adapters/continue/sessionIndex";
import {
  DAY,
  HOUR,
  NOW,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  sessionText,
  SESSIONS_DIR,
} from "@tests/fixtures/continue/continue";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/continue/continueAdapter";

const session = (id: string): IndexedSession => ({ id, folder: null, createdAt: null });

const finderOf = (files: MemoryFiles) =>
  createSessionFileFinder({ sessionsDir: path.resolve(SESSIONS_DIR), io: files.io });

const found = async (
  finder: ReturnType<typeof finderOf>,
  sessions: readonly IndexedSession[],
  now = NOW,
) => (await finder.recent(sessions, now)).map((one) => one.session.id);

describe("finding sessions written lately", () => {
  test("a session's file sits in the sessions folder, named by its id", () => {
    expect(sessionFilePath(path.resolve(SESSIONS_DIR), SESSION_ID)).toBe(
      path.resolve(sessionPath(SESSION_ID)),
    );
  });

  test("lists a session written in the last day, with what a lstat said, and opens nothing", async () => {
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW - HOUR });
    const [one, ...rest] = await finderOf(files).recent([session(SESSION_ID)], NOW);
    expect(rest).toEqual([]);
    expect(one.session.id).toBe(SESSION_ID);
    expect(one.info).toMatchObject({ kind: "file", mtimeMs: NOW - HOUR });
    expect(files.opened()).toEqual([]);
  });

  test("passes over a session last written a day ago or more", async () => {
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW - DAY });
    expect(await found(finderOf(files), [session(SESSION_ID)])).toEqual([]);
  });

  test("passes over a session with no file", async () => {
    expect(await found(finderOf(memoryFiles()), [session(SESSION_ID)])).toEqual([]);
  });

  test("a link, a pipe or a device at a session's name is not a session", async () => {
    const files = memoryFiles();
    files.special(sessionPath(SESSION_ID));
    expect(await found(finderOf(files), [session(SESSION_ID)])).toEqual([]);
  });

  test("a folder at a session's name is not a session", async () => {
    const files = memoryFiles();
    files.mkdir(sessionPath(SESSION_ID));
    expect(await found(finderOf(files), [session(SESSION_ID)])).toEqual([]);
  });

  test("a look that fails passes the session over, and says nothing else", async () => {
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID), sessionText(SESSION_ID), { mtimeMs: NOW });
    files.fail(sessionPath(SESSION_ID));
    expect(await found(finderOf(files), [session(SESSION_ID)])).toEqual([]);
  });

  test("the newest come first, and a tie goes by id", async () => {
    const files = memoryFiles();
    const [a, b, c] = [sessionIdOf(1), sessionIdOf(2), sessionIdOf(3)];
    files.write(sessionPath(a), "{}", { mtimeMs: NOW - HOUR });
    files.write(sessionPath(b), "{}", { mtimeMs: NOW - SECOND });
    files.write(sessionPath(c), "{}", { mtimeMs: NOW - HOUR });
    expect(await found(finderOf(files), [a, b, c].map(session))).toEqual([b, a, c]);
  });

  test("at most the newest 200 are listed", async () => {
    const files = memoryFiles();
    const ids = Array.from({ length: MAX_SESSIONS + 5 }, (_, n) => sessionIdOf(n));
    ids.forEach((id, n) => files.write(sessionPath(id), "{}", { mtimeMs: NOW - n * SECOND }));
    const listed = await found(finderOf(files), ids.map(session));
    expect(listed).toEqual(ids.slice(0, MAX_SESSIONS));
  });

  test("a new session in the list is looked up on the first poll that finds it", async () => {
    const files = memoryFiles();
    const finder = finderOf(files);
    expect(await found(finder, [])).toEqual([]);
    files.write(sessionPath(SESSION_ID), "{}", { mtimeMs: NOW });
    expect(await found(finder, [session(SESSION_ID)], NOW + SECOND)).toEqual([SESSION_ID]);
  });
});

describe("the cost of a poll, with thousands of old sessions", () => {
  const OLD = 5_000;
  const ids = Array.from({ length: OLD }, (_, n) => sessionIdOf(n + 10));
  const old = ids.map(session);
  const recent = session(SESSION_ID);

  function manyFiles() {
    const files = memoryFiles();
    for (const id of ids) files.write(sessionPath(id), "{}", { mtimeMs: NOW - 30 * DAY });
    files.write(sessionPath(SESSION_ID), "{}", { mtimeMs: NOW - HOUR });
    return files;
  }

  test("a sweep looks up every session, and the polls after it one each only for the recent", async () => {
    const files = manyFiles();
    const finder = finderOf(files);
    const sessions = [...old, recent];

    expect(await found(finder, sessions)).toEqual([SESSION_ID]);
    expect(files.count("lstat")).toBe(OLD + 1);

    files.forget();
    expect(await found(finder, sessions, NOW + 2 * SECOND)).toEqual([SESSION_ID]);
    expect(files.count("lstat")).toBe(1);
    expect(files.opened()).toEqual([]);
  });

  test("sessions past the newest 200 wait for the next sweep", async () => {
    const files = memoryFiles();
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, n) => sessionIdOf(n));
    many.forEach((id, n) => files.write(sessionPath(id), "{}", { mtimeMs: NOW - n * SECOND }));
    const finder = finderOf(files);
    await finder.recent(many.map(session), NOW);
    files.forget();
    await finder.recent(many.map(session), NOW + 2 * SECOND);
    expect(files.count("lstat")).toBe(MAX_SESSIONS);
  });

  test("a session that stops being recent stops being looked up", async () => {
    const files = memoryFiles();
    files.write(sessionPath(SESSION_ID), "{}", { mtimeMs: NOW - DAY + 10 * SECOND });
    const finder = finderOf(files);
    expect(await found(finder, [recent], NOW)).toEqual([SESSION_ID]);
    expect(await found(finder, [recent], NOW + 20 * SECOND)).toEqual([]);
    files.forget();
    expect(await found(finder, [recent], NOW + 30 * SECOND)).toEqual([]);
    expect(files.count("lstat")).toBe(0);
  });

  test("an old session opened again is found by the next sweep", async () => {
    const files = memoryFiles();
    const id = sessionIdOf(10);
    files.write(sessionPath(id), "{}", { mtimeMs: NOW - 30 * DAY });
    const finder = finderOf(files);
    expect(await found(finder, [session(id)], NOW)).toEqual([]);

    files.rewrite(sessionPath(id), "{}", { mtimeMs: NOW + SECOND });
    expect(await found(finder, [session(id)], NOW + SWEEP_MS - 1)).toEqual([]);
    expect(await found(finder, [session(id)], NOW + SWEEP_MS)).toEqual([id]);
  });

  test("a clock set back counts as time enough for a sweep", async () => {
    const files = memoryFiles();
    const id = sessionIdOf(10);
    files.write(sessionPath(id), "{}", { mtimeMs: NOW - 30 * DAY });
    const finder = finderOf(files);
    await finder.recent([session(id)], NOW);
    files.forget();
    await finder.recent([session(id)], NOW - HOUR);
    expect(files.count("lstat")).toBe(1);
  });

  test("forgetting starts over", async () => {
    const files = memoryFiles();
    const id = sessionIdOf(10);
    files.write(sessionPath(id), "{}", { mtimeMs: NOW - 30 * DAY });
    const finder = finderOf(files);
    await finder.recent([session(id)], NOW);
    finder.forget();
    files.forget();
    await finder.recent([session(id)], NOW + SECOND);
    expect(files.count("lstat")).toBe(1);
  });
});
