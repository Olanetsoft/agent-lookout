import path from "node:path";
import { describe, expect, test } from "vitest";

import { createSessionFinder, NotAFolderError } from "@collector/adapters/muse-code/sessionFolders";
import {
  DATA_DIR,
  DAY,
  dayFolder,
  HOME,
  HOUR,
  logPath,
  MINUTE,
  NOW,
  opening,
  sessionFolder,
  SESSIONS,
  uuidAt,
} from "@tests/fixtures/muse-code/museCode";
import {
  memoryFiles,
  writeLog,
  type MemoryFiles,
} from "@tests/support/adapters/muse-code/museCodeAdapter";
import { asWritten } from "@tests/support/paths";

const finderOf = (files: MemoryFiles, maxSessions?: number) =>
  createSessionFinder({ sessionsDir: SESSIONS, io: files.io, maxSessions });

/** The logs found, as the tests write paths. */
async function found(
  finder: ReturnType<typeof finderOf>,
  now = NOW,
  needed: ReadonlySet<string> = new Set(),
) {
  const { refs, link } = await finder.find(now, needed);
  return { paths: refs.map((ref) => asWritten(ref.path)), ids: refs.map((ref) => ref.id), link };
}

const ID = (n: number, at = NOW - HOUR) => uuidAt(at, n);

describe("finding the logs", () => {
  test("finds each session's log in its day folder, newest first, by its folder's name", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR), NOW - 2 * MINUTE);
    writeLog(files, logPath(ID(2), NOW - DAY / 2), opening(NOW - HOUR), NOW - MINUTE);
    expect(await found(finderOf(files))).toEqual({
      paths: [logPath(ID(2), NOW - DAY / 2), logPath(ID(1))],
      ids: [ID(2), ID(1)],
      link: false,
    });
  });

  test("takes only names Muse Code makes: years, months and days of digits, and lowercase UUIDs", async () => {
    const files = memoryFiles();
    const day = dayFolder();
    for (const odd of [
      `${SESSIONS}/26/11/19/${ID(1)}/session.jsonl`,
      `${SESSIONS}/2026/13/19/${ID(1)}/session.jsonl`,
      `${SESSIONS}/2026/11/32/${ID(1)}/session.jsonl`,
      `${SESSIONS}/2026/11/1/${ID(1)}/session.jsonl`,
      `${day}/${ID(1).toUpperCase()}/session.jsonl`,
      `${day}/not-a-session/session.jsonl`,
      `${SESSIONS}/.msp-view-v1/2026/11/19/${ID(1)}/session.jsonl`,
    ]) {
      writeLog(files, odd, opening(NOW - HOUR));
    }
    writeLog(files, `${day}/${ID(2)}/other.jsonl`, opening(NOW - HOUR));
    const finder = finderOf(files);
    expect((await found(finder)).paths).toEqual([]);
    // No name that is not one of these is ever looked up.
    expect(
      files.calls.filter(({ path }) => /msp-view|not-a-session|\/26\/|\/13\/|\/32\//.test(path)),
    ).toEqual([]);
  });

  test("never lists a session folder, and never looks up a name beside its log", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
    for (const beside of [
      ".session.lock",
      "cron.db",
      "subagent/child/session.jsonl",
      "approval-review/a.jsonl",
    ]) {
      files.write(`${sessionFolder(ID(1))}/${beside}`, "x");
    }
    const finder = finderOf(files);
    await found(finder);
    await found(finder, NOW + MINUTE + 1);
    const folder = sessionFolder(ID(1));
    expect(
      files.calls.filter(({ path, method }) => path === folder && method === "readdir"),
    ).toEqual([]);
    expect(
      files.calls.filter(
        ({ path }) => path.startsWith(`${folder}/`) && !path.endsWith("/session.jsonl"),
      ),
    ).toEqual([]);
  });

  test("passes over a log not written in the last day until the next sweep, which finds it once written, wherever it is", async () => {
    const files = memoryFiles();
    // Three newer day folders, so the old one is not among the newest three.
    for (const back of [0, 1, 2])
      writeLog(files, logPath(ID(back + 1, NOW - back * DAY), NOW - back * DAY), opening(NOW));
    const old = logPath(ID(9, NOW - 5 * DAY), NOW - 5 * DAY);
    writeLog(files, old, opening(NOW - 5 * DAY), NOW - 4 * DAY);
    const finder = finderOf(files);
    expect((await found(finder)).paths).not.toContain(old);
    // A resume appends to the log in its old day folder.
    files.append(old, "", { mtimeMs: NOW });
    expect((await found(finder, NOW + 2_000)).paths).not.toContain(old);
    expect((await found(finder, NOW + MINUTE)).paths).toContain(old);
    // Once a sweep found it written in the last day, it is looked up on every poll.
    files.forget();
    expect((await found(finder, NOW + MINUTE + 2_000)).paths).toContain(old);
    expect(files.count("lstat", (path) => path === old)).toBe(1);
    expect(files.count("readdir")).toBe(0);
  });

  test("between sweeps looks at the newest three day folders alone, by name, and lists one again only when its time moved", async () => {
    const files = memoryFiles();
    const days = [0, 1, 2, 3].map((back) => NOW - back * DAY);
    for (const [index, at] of days.entries())
      writeLog(files, logPath(ID(index + 1, at), at), opening(at));
    const finder = finderOf(files);
    await found(finder);
    files.forget();
    // A session made since in the fourth newest day folder is not seen until the sweep.
    writeLog(files, logPath(ID(9, days[3]), days[3]), opening(NOW), NOW + 1_000);
    expect((await found(finder, NOW + 2_000)).paths).not.toContain(
      logPath(ID(9, days[3]), days[3]),
    );
    const listed = files.calls.filter(({ method }) => method === "readdir").map(({ path }) => path);
    expect(listed).not.toContain(dayFolder(days[3]));
    expect((await found(finder, NOW + MINUTE)).paths).toContain(logPath(ID(9, days[3]), days[3]));
    // One made in a newest day folder is seen at once.
    writeLog(files, logPath(ID(8)), opening(NOW), NOW + MINUTE + 1_000);
    expect((await found(finder, NOW + MINUTE + 2_000)).paths).toContain(logPath(ID(8)));
    files.forget();
    await found(finder, NOW + MINUTE + 4_000);
    expect(files.count("readdir")).toBe(0);
  });

  test("a sweep is due after a minute, and at once when the clock was set back", async () => {
    const files = memoryFiles();
    for (const back of [0, 1, 2])
      writeLog(files, logPath(ID(back + 1, NOW - back * DAY), NOW - back * DAY), opening(NOW));
    const oldDay = dayFolder(NOW - 5 * DAY);
    writeLog(
      files,
      logPath(ID(9, NOW - 5 * DAY), NOW - 5 * DAY),
      opening(NOW - 5 * DAY),
      NOW - 5 * DAY,
    );
    const finder = finderOf(files);
    await found(finder);
    files.forget();
    await found(finder, NOW + MINUTE - 1);
    expect(files.count("readdir", (path) => path === oldDay)).toBe(0);
    await found(finder, NOW - HOUR);
    expect(files.count("readdir", (path) => path === oldDay)).toBe(1);
    files.forget();
    await found(finder, NOW - HOUR + MINUTE);
    expect(files.count("readdir", (path) => path === oldDay)).toBe(1);
  });

  test(`reads the newest ${200} at most, and every one that needed the person however old`, async () => {
    const files = memoryFiles();
    for (let n = 1; n <= 4; n += 1)
      writeLog(files, logPath(ID(n)), opening(NOW - HOUR), NOW - n * MINUTE);
    const old = logPath(ID(9, NOW - 3 * DAY), NOW - 3 * DAY);
    writeLog(files, old, opening(NOW - 3 * DAY), NOW - 2 * DAY);
    const finder = finderOf(files, 2);
    expect((await found(finder)).paths).toEqual([logPath(ID(1)), logPath(ID(2))]);
    // As the finder writes them, as a poll's own refs give them.
    const needed = new Set([path.normalize(logPath(ID(4))), path.normalize(old)]);
    expect((await found(finder, NOW + 2_000, needed)).paths).toEqual([
      logPath(ID(1)),
      logPath(ID(2)),
      logPath(ID(4)),
      old,
    ]);
  });
});

describe("links and other things that are not folders or files", () => {
  test("sessions/ that is a link or a file is not a folder, and a missing one is missing", async () => {
    for (const make of [
      (files: MemoryFiles) => files.special(SESSIONS),
      (files: MemoryFiles) => files.write(SESSIONS, "x"),
    ]) {
      const files = memoryFiles();
      make(files);
      await expect(finderOf(files).find(NOW, new Set())).rejects.toBeInstanceOf(NotAFolderError);
      expect(files.count("readdir")).toBe(0);
    }
    await expect(finderOf(memoryFiles()).find(NOW, new Set())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("a link at a year, month, day or session folder, or at a log, is never gone into, and is said", async () => {
    const day = dayFolder();
    const places = [
      `${SESSIONS}/2027`,
      `${SESSIONS}/2026/12`,
      `${SESSIONS}/2026/11/20`,
      `${day}/${ID(5)}`,
      `${day}/${ID(6)}/session.jsonl`,
    ];
    for (const place of places) {
      const files = memoryFiles();
      writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
      files.special(place);
      if (place.endsWith(ID(5))) files.touch(day, NOW);
      const result = await found(finderOf(files));
      expect(result, place).toEqual({ paths: [logPath(ID(1))], ids: [ID(1)], link: true });
      expect(
        files.calls.filter(({ path, method }) => path.startsWith(place) && method !== "lstat"),
        place,
      ).toEqual([]);
    }
  });

  test("a session folder replaced by a link since it was listed is caught by its lookup", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
    const finder = finderOf(files);
    await found(finder);
    files.remove(sessionFolder(ID(1)));
    files.special(sessionFolder(ID(1)));
    expect(await found(finder, NOW + 2_000)).toEqual({ paths: [], ids: [], link: true });
  });

  test.each([
    ["day", dayFolder()],
    ["month", `${SESSIONS}/2026/11`],
    ["year", `${SESSIONS}/2026`],
  ])(
    "a %s folder replaced by a link since a log was found is not gone through for a session that needed the person",
    async (_, place) => {
      const files = memoryFiles();
      writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
      const finder = finderOf(files);
      // The logs it found, as the adapter passes them on.
      const needed = new Set((await finder.find(NOW, new Set())).refs.map((ref) => ref.path));
      expect([...needed].map(asWritten)).toEqual([logPath(ID(1))]);
      // A link in the middle of a path is followed by the system, so what is below it can still be looked up.
      files.special(place);
      files.forget();
      expect(await found(finder, NOW + 2_000, needed)).toEqual({ paths: [], ids: [], link: true });
      expect(files.calls.filter(({ path }) => path.startsWith(`${place}/`))).toEqual([]);
    },
  );

  test("a day folder replaced by a link since a sweep found a log written in the last day is not gone through between sweeps", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
    const finder = finderOf(files);
    expect((await found(finder)).paths).toEqual([logPath(ID(1))]);
    files.special(dayFolder());
    files.forget();
    expect(await found(finder, NOW + 2_000)).toEqual({ paths: [], ids: [], link: true });
    expect(files.calls.filter(({ path }) => path.startsWith(`${dayFolder()}/`))).toEqual([]);
  });

  test("a link at an old day folder that only a log written in the last day leads to is said", async () => {
    const files = memoryFiles();
    // Three newer day folders, so between sweeps the old one is not listed.
    for (const back of [0, 1, 2])
      writeLog(files, logPath(ID(back + 1, NOW - back * DAY), NOW - back * DAY), opening(NOW));
    const oldDay = dayFolder(NOW - 5 * DAY);
    // A resume appends to the log in its old day folder.
    writeLog(files, logPath(ID(9, NOW - 5 * DAY), NOW - 5 * DAY), opening(NOW - 5 * DAY), NOW);
    const finder = finderOf(files);
    expect((await found(finder)).paths).toContain(logPath(ID(9, NOW - 5 * DAY), NOW - 5 * DAY));
    files.special(oldDay);
    files.forget();
    const result = await found(finder, NOW + 2_000);
    expect(result.paths).toHaveLength(3);
    expect(result.paths).not.toContain(logPath(ID(9, NOW - 5 * DAY), NOW - 5 * DAY));
    expect(result.link).toBe(true);
    expect(files.calls.filter(({ path }) => path.startsWith(`${oldDay}/`))).toEqual([]);
  });

  test("a log that needed the person is looked up only where Muse Code makes one", async () => {
    const files = memoryFiles();
    const odd = [
      `${SESSIONS}/2026/11/${ID(1)}/session.jsonl`,
      `${DATA_DIR}/other/demo/${ID(2)}/session.jsonl`,
      `${HOME}/elsewhere/2026/11/19/${ID(3)}/session.jsonl`,
      // Each of these fails one check alone: a folder too deep, then a year, a month, a day and a session's name.
      `${SESSIONS}/2026/11/19/${ID(4)}/${ID(5)}/session.jsonl`,
      `${SESSIONS}/26/11/19/${ID(6)}/session.jsonl`,
      `${SESSIONS}/2026/13/19/${ID(7)}/session.jsonl`,
      `${SESSIONS}/2026/11/32/${ID(8)}/session.jsonl`,
      `${SESSIONS}/2026/11/19/not-a-session/session.jsonl`,
    ];
    for (const one of odd) writeLog(files, one, opening(NOW - HOUR));
    const folders = odd.map((one) => one.slice(0, one.lastIndexOf("/")));
    const finder = finderOf(files);
    const needed = new Set(odd.map((one) => path.normalize(one)));
    expect(await found(finder, NOW, needed)).toEqual({ paths: [], ids: [], link: false });
    expect(
      files.calls.filter(({ path: called }) =>
        folders.some((one) => asWritten(called).startsWith(one)),
      ),
    ).toEqual([]);
  });

  test("a missing log, as one being made, is looked up again on the next poll", async () => {
    const files = memoryFiles();
    files.mkdir(sessionFolder(ID(1)));
    files.touch(dayFolder(), NOW - HOUR);
    const finder = finderOf(files);
    expect((await found(finder)).paths).toEqual([]);
    writeLog(files, logPath(ID(1)), opening(NOW));
    expect((await found(finder, NOW + 2_000)).paths).toEqual([logPath(ID(1))]);
  });

  test("a folder that cannot be looked up keeps its last list for the poll, and one gone is dropped", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
    const finder = finderOf(files);
    await found(finder);
    files.fail(dayFolder());
    expect((await found(finder, NOW + 2_000)).paths).toEqual([logPath(ID(1))]);
    files.heal(dayFolder());
    files.remove(dayFolder());
    expect((await found(finder, NOW + 4_000)).paths).toEqual([]);
  });

  const OLD = NOW - 10 * DAY;
  test.each([
    ["day", dayFolder(OLD)],
    ["month", `${SESSIONS}/2026/11`],
    ["year", `${SESSIONS}/2026`],
  ])(
    "a log that needed the person past the newest days, under a %s folder that cannot be looked up, is still needed",
    async (_, place) => {
      const files = memoryFiles();
      for (let n = 0; n < 3; n += 1)
        writeLog(files, logPath(ID(n + 1, NOW - n * DAY), NOW - n * DAY), opening(NOW - HOUR));
      const old = logPath(ID(9, OLD), OLD);
      writeLog(files, old, opening(OLD), NOW - 2 * DAY);
      const finder = finderOf(files);
      const needed = new Set([path.normalize(old)]);
      expect((await found(finder, NOW, needed)).paths).toContain(old);
      files.fail(place, "EIO");
      const { refs, stillNeeded } = await finder.find(NOW + 2_000, needed);
      expect(refs.map((ref) => asWritten(ref.path))).not.toContain(old);
      expect(stillNeeded.map(asWritten)).toEqual([old]);
    },
  );

  test("forgets everything, as for a sessions folder that went", async () => {
    const files = memoryFiles();
    writeLog(files, logPath(ID(1)), opening(NOW - HOUR));
    const finder = finderOf(files);
    await found(finder);
    finder.forget();
    files.forget();
    await found(finder, NOW + 2_000);
    // A sweep again: every folder is listed.
    expect(files.count("readdir")).toBeGreaterThan(0);
  });
});
