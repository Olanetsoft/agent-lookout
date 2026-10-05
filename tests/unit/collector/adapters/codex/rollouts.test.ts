import { describe, expect, test } from "vitest";

import {
  createRolloutFinder,
  INDEX_PROMPT_REFRESH_MS,
  INDEX_REFRESH_MS,
  recentDayFolders,
  ROLLOUT_FILE_NAME,
  threadIdOfRollout,
} from "@collector/adapters/codex/rollouts";
import {
  CODEX_HOME,
  ids,
  NOW,
  revertedRolloutId,
  rollout,
  rolloutName,
  rolloutPath,
  metaLine,
  threadId,
} from "@tests/fixtures/codex";
import { inTimeZone, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

const SESSIONS = `${CODEX_HOME}/sessions`;

describe("the rollout file name", () => {
  test("names the thread, in lowercase, with or without a revert's own id", () => {
    expect(threadIdOfRollout(rolloutName("2026-10-01T09-00-00", ids.working))).toBe(ids.working);
    expect(
      threadIdOfRollout(rolloutName("2026-10-01T09-00-00", ids.reverted, revertedRolloutId)),
    ).toBe(ids.reverted);
    expect(
      threadIdOfRollout(rolloutName("2026-10-01T09-00-00", "0199A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B")),
    ).toBe("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
  });

  test.each([
    // Compressed after a week.
    `rollout-2026-10-01T09-00-00-${ids.working}.jsonl.zst`,
    `rollout-2026-10-01T09-00-00-${ids.working}.jsonl.tmp`,
    `rollout-2026-10-01T09-00-00-${ids.working}.json`,
    `rollout-2026-10-01T09-00-00-${ids.working}`,
    `rollout-2026-10-01-${ids.working}.jsonl`,
    `rollout-2026-10-01T09:00:00-${ids.working}.jsonl`,
    `session-2026-10-01T09-00-00-${ids.working}.jsonl`,
    `rollout-2026-10-01T09-00-00-not-a-uuid.jsonl`,
    `rollout-2026-10-01T09-00-00-${ids.working}_.jsonl`,
    `rollout-2026-10-01T09-00-00-${ids.working}_notauuid.jsonl`,
    `.rollout-2026-10-01T09-00-00-${ids.working}.jsonl`,
    "session_index.jsonl",
    "history.jsonl",
  ])("%s is not a session file", (name) => {
    expect(ROLLOUT_FILE_NAME.test(name)).toBe(false);
    expect(threadIdOfRollout(name)).toBeNull();
  });
});

describe("recentDayFolders", () => {
  // Codex names day folders by the local date. Each case is checked in a zone
  // far east and far west of UTC, so taking the date in UTC would fail at least
  // one of them on any computer.
  const zones = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Europe/London"];

  test.each(zones)("are today's and yesterday's local dates, in %s", async (zone) => {
    await inTimeZone(zone, () => {
      const justAfterMidnight = new Date(2026, 9, 1, 0, 30).getTime();
      const justBeforeMidnight = new Date(2026, 9, 1, 23, 30).getTime();
      const expected = [`${SESSIONS}/2026/10/01`, `${SESSIONS}/2026/09/30`];
      expect(recentDayFolders(SESSIONS, justAfterMidnight)).toEqual(expected);
      expect(recentDayFolders(SESSIONS, justBeforeMidnight)).toEqual(expected);
    });
  });

  test.each(zones)("cross the year with two-digit months and days, in %s", async (zone) => {
    await inTimeZone(zone, () => {
      expect(recentDayFolders(SESSIONS, new Date(2027, 0, 1, 9, 0).getTime())).toEqual([
        `${SESSIONS}/2027/01/01`,
        `${SESSIONS}/2026/12/31`,
      ]);
    });
  });

  test("the fixture's clock reaches the fixture's folder in every time zone", async () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata", "UTC"]) {
      await inTimeZone(zone, () => {
        expect(recentDayFolders(SESSIONS, NOW)).toContain(`${SESSIONS}/2026/10/01`);
      });
    }
  });

  test("on a day with an extra hour, a folder is not listed twice", async () => {
    await inTimeZone("America/New_York", () => {
      // 1 November 2026 has 25 hours in New York, so 24 hours before 23:30 is the same date.
      const lateOnTheLongDay = new Date(2026, 10, 1, 23, 30).getTime();
      expect(recentDayFolders(SESSIONS, lateOnTheLongDay)).toEqual([`${SESSIONS}/2026/11/01`]);
    });
  });
});

/** A Codex folder with sessions in today's folder, an old folder, and odd things beside them. */
function codexFolder(): MemoryFiles {
  const files = memoryFiles();
  const body = rollout(metaLine(NOW));
  files.write(rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", ids.working), body);
  files.write(rolloutPath(CODEX_HOME, "2026-10-01T07-00-00", ids.reverted), body);
  files.write(
    rolloutPath(CODEX_HOME, "2026-10-01T10-30-00", ids.reverted, revertedRolloutId),
    body,
  );
  files.write(
    `${SESSIONS}/2026/10/01/${rolloutName("2026-10-01T06-00-00", ids.compressed)}.zst`,
    "",
  );
  files.write(`${SESSIONS}/2026/10/01/.DS_Store`, "");
  files.write(rolloutPath(CODEX_HOME, "2026-09-30T22-00-00", ids.idle), body);
  files.write(rolloutPath(CODEX_HOME, "2026-09-20T08-00-00", ids.resumed), body);
  files.write(rolloutPath(CODEX_HOME, "2025-12-31T08-00-00", ids.old), body);
  files.write(
    `${CODEX_HOME}/archived_sessions/${rolloutName("2026-09-25T08-00-00", ids.archived)}`,
    body,
  );
  // Folders that are not years, months or days are not walked into.
  files.write(`${SESSIONS}/notes/${rolloutName("2026-09-21T08-00-00", ids.finished)}`, body);
  files.write(`${SESSIONS}/2026/9/21/${rolloutName("2026-09-21T08-00-00", ids.aborted)}`, body);
  return files;
}

describe("createRolloutFinder", () => {
  test("recent lists today's and yesterday's folders only, and opens nothing", async () => {
    await inTimeZone("UTC", async () => {
      const files = codexFolder();
      const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
      const refs = await finder.recent(NOW);

      expect(refs).toEqual([
        {
          path: rolloutPath(CODEX_HOME, "2026-10-01T07-00-00", ids.reverted),
          threadId: ids.reverted,
        },
        {
          path: rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", ids.working),
          threadId: ids.working,
        },
        {
          path: rolloutPath(CODEX_HOME, "2026-10-01T10-30-00", ids.reverted, revertedRolloutId),
          threadId: ids.reverted,
        },
        { path: rolloutPath(CODEX_HOME, "2026-09-30T22-00-00", ids.idle), threadId: ids.idle },
      ]);
      expect(files.calls).toEqual([
        { method: "readdir", path: `${SESSIONS}/2026/10/01` },
        { method: "readdir", path: `${SESSIONS}/2026/09/30` },
      ]);
    });
  });

  test("a day folder that is not there, or cannot be listed, holds no sessions", async () => {
    await inTimeZone("UTC", async () => {
      const files = memoryFiles();
      files.write(rolloutPath(CODEX_HOME, "2026-09-30T22-00-00", ids.idle), "");
      files.fail(`${SESSIONS}/2026/09/30`, "EACCES");
      const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
      expect(await finder.recent(NOW)).toEqual([]);
    });
  });

  test("locate finds a thread in any day folder, both files of a reverted one, and nothing archived", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    const refs = await finder.locate([ids.resumed, ids.reverted, ids.old, ids.archived], NOW);

    expect(refs).toEqual([
      { path: rolloutPath(CODEX_HOME, "2026-09-20T08-00-00", ids.resumed), threadId: ids.resumed },
      {
        path: rolloutPath(CODEX_HOME, "2026-10-01T07-00-00", ids.reverted),
        threadId: ids.reverted,
      },
      {
        path: rolloutPath(CODEX_HOME, "2026-10-01T10-30-00", ids.reverted, revertedRolloutId),
        threadId: ids.reverted,
      },
      { path: rolloutPath(CODEX_HOME, "2025-12-31T08-00-00", ids.old), threadId: ids.old },
    ]);
    // Only folders were listed.
    expect(files.calls.every((call) => call.method === "readdir")).toBe(true);
    expect(files.count("readdir", (dir) => dir.includes("archived_sessions"))).toBe(0);
    expect(files.count("readdir", (dir) => dir.includes("/notes") || dir.endsWith("/9"))).toBe(0);
  });

  test("locate with nothing to find does nothing", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    expect(await finder.locate([], NOW)).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  test("a thread already in the list is found again without listing anything", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    await finder.locate([ids.resumed], NOW);
    files.forget();

    expect(await finder.locate([ids.resumed], NOW + 10 * INDEX_REFRESH_MS)).toHaveLength(1);
    expect(files.calls).toEqual([]);
  });

  /** How many times every day folder was listed: once per listing of the year folder. */
  const listings = (files: MemoryFiles) => files.count("readdir", (dir) => dir === SESSIONS);

  test("a thread that is not found makes the list again at most every 30 seconds", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    const missing = threadId("e1");

    expect(await finder.locate([missing], NOW)).toEqual([]);
    expect(listings(files)).toBe(1);

    for (const after of [2_000, 10_000, INDEX_REFRESH_MS - 1]) {
      await finder.locate([missing], NOW + after);
    }
    expect(listings(files)).toBe(1);

    await finder.locate([missing], NOW + INDEX_REFRESH_MS);
    expect(listings(files)).toBe(2);
  });

  test("a thread that is newly asked for makes the list again sooner, but not on every poll", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    await finder.locate([threadId("e1")], NOW);
    expect(listings(files)).toBe(1);

    // A second open session appears two seconds later: too soon.
    await finder.locate([threadId("e1"), threadId("e2")], NOW + 2_000);
    expect(listings(files)).toBe(1);

    // Its file is written meanwhile, and it is still new five seconds after the last list.
    files.write(rolloutPath(CODEX_HOME, "2026-09-25T08-00-00", threadId("e2")), "");
    const found = await finder.locate(
      [threadId("e1"), threadId("e2")],
      NOW + INDEX_PROMPT_REFRESH_MS,
    );
    expect(listings(files)).toBe(2);
    expect(found.map((ref) => ref.threadId)).toEqual([threadId("e2")]);

    // e1 is still missing, but it is no longer new: the 30-second wait applies.
    await finder.locate([threadId("e1")], NOW + INDEX_PROMPT_REFRESH_MS + 6_000);
    expect(listings(files)).toBe(2);
  });

  test("a clock that has been set back makes the list again", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({ sessionsDir: SESSIONS, io: files.io });
    await finder.locate([threadId("e1")], NOW);
    await finder.locate([threadId("e1")], NOW - 1_000);
    expect(listings(files)).toBe(2);
  });

  test("the waits can be set", async () => {
    const files = codexFolder();
    const finder = createRolloutFinder({
      sessionsDir: SESSIONS,
      io: files.io,
      refreshMs: 100,
      promptRefreshMs: 10,
    });
    await finder.locate([threadId("e1")], NOW);
    await finder.locate([threadId("e1")], NOW + 99);
    expect(listings(files)).toBe(1);
    await finder.locate([threadId("e1")], NOW + 100);
    expect(listings(files)).toBe(2);
    await finder.locate([threadId("e2")], NOW + 110);
    expect(listings(files)).toBe(3);
  });
});
