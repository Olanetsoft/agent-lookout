import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createSessionFileFinder,
  isProjectFolderName,
  isSessionFileName,
  MAX_SESSIONS,
  SWEEP_MS,
} from "@collector/adapters/pi/sessionFiles";
import {
  DAY,
  HOUR,
  NOW,
  PROJECT_FOLDER,
  projectFolderOf,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  sessionPath,
  sessionText,
  SESSIONS_DIR,
} from "@tests/fixtures/pi/pi";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/pi/piAdapter";

const FILE = sessionPath(SESSION_ID);

const finderOf = (files: MemoryFiles) =>
  createSessionFileFinder({ sessionsDir: path.resolve(SESSIONS_DIR), io: files.io });

const found = async (finder: ReturnType<typeof finderOf>, now = NOW) =>
  (await finder.recent(now)).map((ref) => path.basename(ref.path));

describe("the names it takes", () => {
  test("a session file is anything that ends in .jsonl, as /import keeps a file's own name", () => {
    expect(isSessionFileName(path.basename(FILE))).toBe(true);
    expect(isSessionFileName("my-export-1.jsonl")).toBe(true);
    expect(isSessionFileName(".jsonl")).toBe(false);
    expect(isSessionFileName("demo.jsonl.tmp")).toBe(false);
    expect(isSessionFileName("demo.json")).toBe(false);
  });

  test("a project folder is between two pairs of dashes", () => {
    expect(isProjectFolderName("--Users-example-code-demo--")).toBe(true);
    expect(isProjectFolderName("--C--Users-example-code-demo--")).toBe(true);
    // A session in the root folder.
    expect(isProjectFolderName("----")).toBe(true);
    expect(isProjectFolderName("--")).toBe(false);
    expect(isProjectFolderName("demo")).toBe(false);
    expect(isProjectFolderName("--demo")).toBe(false);
  });
});

describe("finding session files", () => {
  test("lists a file in a project folder, with what a lstat said, and opens nothing", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const [ref, ...rest] = await finderOf(files).recent(NOW);
    expect(rest).toEqual([]);
    expect(ref.path).toBe(path.resolve(FILE));
    expect(ref.info).toMatchObject({ kind: "file", mtimeMs: NOW });
    expect(files.opened()).toEqual([]);
  });

  test("lists a file directly in the folder, as PI_CODING_AGENT_SESSION_DIR leaves them", async () => {
    const files = memoryFiles();
    const flat = sessionPath(SESSION_ID, SESSIONS_DIR);
    files.write(flat, sessionText(SESSION_ID));
    expect(await found(finderOf(files))).toEqual([path.basename(flat)]);
  });

  test("passes over anything else in the folders", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    files.write(`${PROJECT_FOLDER}/notes.txt`, "notes");
    files.write(`${SESSIONS_DIR}/other/${path.basename(FILE)}`, "elsewhere");
    expect(await found(finderOf(files))).toEqual([path.basename(FILE)]);
  });

  test("rejects when the folder cannot be listed, and a missing one says so", async () => {
    const files = memoryFiles();
    await expect(finderOf(files).recent(NOW)).rejects.toMatchObject({ code: "ENOENT" });
    files.mkdir(SESSIONS_DIR);
    files.fail(SESSIONS_DIR);
    await expect(finderOf(files).recent(NOW)).rejects.toMatchObject({ code: "EACCES" });
  });

  test("a project folder that cannot be listed holds nothing, and the others stand", async () => {
    const files = memoryFiles();
    const other = sessionPath(sessionIdOf(2), projectFolderOf("/Users/example/code/other"));
    files.write(FILE, sessionText(SESSION_ID));
    files.write(other, sessionText(sessionIdOf(2)));
    files.fail(PROJECT_FOLDER);
    expect(await found(finderOf(files))).toEqual([path.basename(other)]);
  });

  describe("a project folder that was listed", () => {
    /** The finder, with a project folder's listing or its `lstat` refused while a test says so. */
    function refusing(method: "readdir" | "lstat") {
      const files = memoryFiles();
      files.write(FILE, sessionText(SESSION_ID));
      const state = { refused: false };
      const refuse = (called: string, target: string) => {
        if (state.refused && called === method && target.endsWith(path.basename(PROJECT_FOLDER))) {
          throw Object.assign(new Error("Refused."), { code: "EMFILE" });
        }
      };
      const io = {
        ...files.io,
        readdir: async (target: string) => {
          refuse("readdir", target);
          return files.io.readdir(target);
        },
        lstat: async (target: string) => {
          refuse("lstat", target);
          return files.io.lstat(target);
        },
      };
      const finder = createSessionFileFinder({ sessionsDir: path.resolve(SESSIONS_DIR), io });
      return { files, finder, state };
    }

    test("keeps its list through a listing that fails, and lists again once its time moved", async () => {
      const { files, finder, state } = refusing("readdir");
      expect(await found(finder)).toEqual([path.basename(FILE)]);

      state.refused = true;
      const added = sessionPath(sessionIdOf(2));
      files.write(added, sessionText(sessionIdOf(2)));
      files.touch(PROJECT_FOLDER, NOW + SECOND);
      expect(await found(finder, NOW + SECOND)).toEqual([path.basename(FILE)]);

      state.refused = false;
      expect(await found(finder, NOW + 2 * SECOND)).toEqual(
        [path.basename(FILE), path.basename(added)].sort(),
      );
    });

    test("keeps its list through a look-up that fails", async () => {
      const { finder, state } = refusing("lstat");
      expect(await found(finder)).toEqual([path.basename(FILE)]);
      state.refused = true;
      expect(await found(finder, NOW + SWEEP_MS)).toEqual([path.basename(FILE)]);
    });

    test("gives up its list once a link stands in its place", async () => {
      const files = memoryFiles();
      files.write(FILE, sessionText(SESSION_ID));
      const finder = finderOf(files);
      expect(await found(finder)).toEqual([path.basename(FILE)]);
      // The file stays where it was: through a link, its path would still lead to one.
      files.special(PROJECT_FOLDER);
      expect(await found(finder, NOW + SECOND)).toEqual([]);
    });
  });

  test("a link in place of a project folder or a file is not followed", async () => {
    const files = memoryFiles();
    const inFolder = `${PROJECT_FOLDER}/link.jsonl`;
    const linkedFolder = projectFolderOf("/Users/example/code/linked");
    files.special(inFolder);
    files.special(linkedFolder);
    expect(await found(finderOf(files))).toEqual([]);
    expect(files.count("readdir", (target) => target === linkedFolder)).toBe(0);
  });

  test("leaves out a file not written to for a day, by its modified time", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - DAY - HOUR });
    expect(await found(finderOf(files))).toEqual([]);
  });

  test("gives the newest first", async () => {
    const files = memoryFiles();
    const older = sessionPath(sessionIdOf(2));
    files.write(older, sessionText(sessionIdOf(2)), { mtimeMs: NOW - HOUR });
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - SECOND });
    expect(await found(finderOf(files))).toEqual([path.basename(FILE), path.basename(older)]);
  });

  test("gives at most the newest 200, and the others wait for the next sweep", async () => {
    const files = memoryFiles();
    for (let n = 0; n < MAX_SESSIONS + 5; n += 1) {
      files.write(sessionPath(sessionIdOf(n)), "", { mtimeMs: NOW - n * SECOND });
    }
    const finder = finderOf(files);
    expect(await found(finder)).toHaveLength(MAX_SESSIONS);
    files.forget();
    await finder.recent(NOW + SECOND);
    // The folder and each of the 200: the five left out are not looked at.
    expect(files.count("lstat")).toBe(MAX_SESSIONS + 1);
  });
});

describe("what a poll costs", () => {
  /** Thousands of sessions last written long ago, across some folders, and one new one. */
  function manyOldFiles() {
    const files = memoryFiles();
    for (let folder = 0; folder < 20; folder += 1) {
      const dir = projectFolderOf(`/Users/example/code/demo-${folder}`);
      for (let n = 0; n < 200; n += 1) {
        const id = sessionIdOf(folder * 1000 + n);
        files.write(sessionPath(id, dir), sessionText(id), { mtimeMs: NOW - 30 * DAY });
      }
    }
    files.write(FILE, sessionText(SESSION_ID));
    return files;
  }

  test("thousands of old files are looked up once, and opened never", async () => {
    const files = manyOldFiles();
    const finder = finderOf(files);
    expect(await found(finder)).toEqual([path.basename(FILE)]);
    expect(files.opened()).toEqual([]);
    expect(files.count("lstat")).toBeGreaterThan(4_000);

    files.forget();
    await finder.recent(NOW + SECOND);
    // Each of the 21 folders, and the one file written in the last day.
    expect(files.count("lstat")).toBe(22);
    expect(files.count("readdir")).toBe(1);
    expect(files.opened()).toEqual([]);
  });

  test("a new file is found by the next poll, by its folder's time, in that folder alone", async () => {
    const files = manyOldFiles();
    const finder = finderOf(files);
    await finder.recent(NOW);
    files.forget();

    const added = sessionPath(sessionIdOf(9_000));
    files.write(added, sessionText(sessionIdOf(9_000)));
    files.touch(PROJECT_FOLDER, NOW + SECOND);
    expect(await found(finder, NOW + SECOND)).toEqual(
      [path.basename(FILE), path.basename(added)].sort(),
    );
    expect(files.count("readdir")).toBe(2);
  });

  test("a new project folder is found by the next poll", async () => {
    const files = manyOldFiles();
    const finder = finderOf(files);
    await finder.recent(NOW);
    const added = sessionPath(sessionIdOf(9_001), projectFolderOf("/Users/example/code/new"));
    files.write(added, sessionText(sessionIdOf(9_001)));
    expect(await found(finder, NOW + SECOND)).toContain(path.basename(added));
  });

  test("an old session opened again is found by the next sweep, and no sooner", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - 2 * DAY });
    const finder = finderOf(files);
    await finder.recent(NOW);

    files.append(FILE, "\n", { mtimeMs: NOW + SECOND });
    expect(await found(finder, NOW + 2 * SECOND)).toEqual([]);
    expect(await found(finder, NOW + SWEEP_MS)).toEqual([path.basename(FILE)]);
  });

  test("a file added while its folder's time stands still is found by the next sweep", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const finder = finderOf(files);
    await finder.recent(NOW);
    const added = sessionPath(sessionIdOf(2));
    files.write(added, sessionText(sessionIdOf(2)));
    expect(await found(finder, NOW + SECOND)).toEqual([path.basename(FILE)]);
    expect(await found(finder, NOW + SWEEP_MS)).toContain(path.basename(added));
  });

  test("a clock set back counts as time enough for a sweep", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - 2 * DAY });
    const finder = finderOf(files);
    await finder.recent(NOW);
    files.append(FILE, "\n", { mtimeMs: NOW - HOUR });
    expect(await found(finder, NOW - SECOND)).toEqual([path.basename(FILE)]);
  });

  test("a file written in the last day that stops being written leaves when its day is up", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const finder = finderOf(files);
    expect(await found(finder)).toEqual([path.basename(FILE)]);
    expect(await found(finder, NOW + DAY + SECOND)).toEqual([]);
  });

  test("a folder that went is forgotten", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const finder = finderOf(files);
    await finder.recent(NOW);
    files.remove(PROJECT_FOLDER);
    files.mkdir(SESSIONS_DIR);
    expect(await found(finder, NOW + SECOND)).toEqual([]);
    const back = sessionPath(sessionIdOf(2));
    files.write(back, sessionText(sessionIdOf(2)));
    expect(await found(finder, NOW + 2 * SECOND)).toEqual([path.basename(back)]);
  });

  test("after forget, everything is listed again", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID), { mtimeMs: NOW - 2 * DAY });
    const finder = finderOf(files);
    await finder.recent(NOW);
    files.forget();
    finder.forget();
    await finder.recent(NOW + SECOND);
    expect(files.count("lstat", (target) => target.endsWith(".jsonl"))).toBe(1);
  });
});

describe("a flat sessions folder, as Prime Agent keeps", () => {
  const flatOf = (files: MemoryFiles) =>
    createSessionFileFinder({ sessionsDir: path.resolve(SESSIONS_DIR), io: files.io, flat: true });

  test("is listed again only when its time moves, and at each sweep, and has no project folders", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/${SESSION_ID}.jsonl`, sessionText(SESSION_ID));
    files.write(FILE, sessionText(sessionIdOf(2)));
    const finder = flatOf(files);
    const names = async (at: number) =>
      (await finder.recent(at)).map((ref) => path.basename(ref.path));
    expect(await names(NOW)).toEqual([`${SESSION_ID}.jsonl`]);
    expect(await names(NOW + 2 * SECOND)).toEqual([`${SESSION_ID}.jsonl`]);
    const listed = () => files.count("readdir", (target) => target === SESSIONS_DIR);
    expect(listed()).toBe(1);
    expect(files.count(undefined, (target) => target.startsWith(PROJECT_FOLDER))).toBe(0);
    files.write(`${SESSIONS_DIR}/${sessionIdOf(3)}.jsonl`, sessionText(sessionIdOf(3)));
    expect(await names(NOW + 4 * SECOND)).toHaveLength(1);
    files.touch(SESSIONS_DIR, NOW + 5 * SECOND);
    expect(await names(NOW + 6 * SECOND)).toHaveLength(2);
    await names(NOW + 6 * SECOND + SWEEP_MS);
    expect(listed()).toBe(3);
  });

  test("still rejects when the folder is missing, and is still followed when a link is at its name", async () => {
    const missing = memoryFiles();
    await expect(flatOf(missing).recent(NOW)).rejects.toMatchObject({ code: "ENOENT" });
    const linked = memoryFiles();
    linked.write(`${SESSIONS_DIR}/${SESSION_ID}.jsonl`, sessionText(SESSION_ID));
    // The stand-in calls a link "other" at lstat, and lists what is under its name.
    const io = {
      ...linked.io,
      lstat: async (target: string) =>
        target === path.resolve(SESSIONS_DIR)
          ? { kind: "other" as const, size: 0, mtimeMs: 0, ino: 1 }
          : linked.io.lstat(target),
    };
    const finder = createSessionFileFinder({
      sessionsDir: path.resolve(SESSIONS_DIR),
      io,
      flat: true,
    });
    await finder.recent(NOW);
    await finder.recent(NOW + 2 * SECOND);
    expect(linked.count("readdir", (target) => target === SESSIONS_DIR)).toBe(2);
  });

  test("Pi's folder is still listed on every poll", async () => {
    const files = memoryFiles();
    files.write(FILE, sessionText(SESSION_ID));
    const finder = finderOf(files);
    await finder.recent(NOW);
    await finder.recent(NOW + 2 * SECOND);
    expect(files.count("readdir", (target) => target === SESSIONS_DIR)).toBe(2);
  });
});

describe("a test of its own for which names are session files, as Unreal Agent's adapter gives", () => {
  const onlyMine = (name: string) => name.endsWith(".mine.jsonl");

  test("takes only the names it passes, in the folder and in a project folder, and looks up no other", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/a.mine.jsonl`, sessionText(SESSION_ID));
    files.write(`${SESSIONS_DIR}/b.jsonl`, sessionText(sessionIdOf(2)));
    files.write(`${PROJECT_FOLDER}/c.mine.jsonl`, sessionText(sessionIdOf(3)));
    files.write(`${PROJECT_FOLDER}/d.jsonl`, sessionText(sessionIdOf(4)));
    const finder = createSessionFileFinder({
      sessionsDir: path.resolve(SESSIONS_DIR),
      io: files.io,
      fileName: onlyMine,
    });
    expect((await finder.recent(NOW)).map((ref) => path.basename(ref.path)).sort()).toEqual([
      "a.mine.jsonl",
      "c.mine.jsonl",
    ]);
    expect(files.count("lstat", (target) => target.endsWith("b.jsonl"))).toBe(0);
    expect(files.count("lstat", (target) => target.endsWith("d.jsonl"))).toBe(0);
  });

  test("with a flat folder, goes into no folder in it", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/a.mine.jsonl`, sessionText(SESSION_ID));
    files.write(`${PROJECT_FOLDER}/c.mine.jsonl`, sessionText(sessionIdOf(3)));
    const finder = createSessionFileFinder({
      sessionsDir: path.resolve(SESSIONS_DIR),
      io: files.io,
      flat: true,
      fileName: onlyMine,
    });
    expect((await finder.recent(NOW)).map((ref) => path.basename(ref.path))).toEqual([
      "a.mine.jsonl",
    ]);
    expect(files.count(undefined, (target) => target.startsWith(PROJECT_FOLDER))).toBe(0);
  });

  test("left out, every name that ends in .jsonl is still a session file's", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/a.mine.jsonl`, sessionText(SESSION_ID));
    files.write(`${SESSIONS_DIR}/b.jsonl`, sessionText(sessionIdOf(2)));
    const names = (await finderOf(files).recent(NOW)).map((ref) => path.basename(ref.path)).sort();
    expect(names).toEqual(["a.mine.jsonl", "b.jsonl"]);
  });
});

describe("a test of its own for which names are project folders, as Droid's adapter gives", () => {
  const startsWithDash = (name: string) => name.startsWith("-");

  test("goes into only the folders it passes, and lists the loose files beside them", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/-Users-example-code-demo/a.jsonl`, sessionText(SESSION_ID));
    files.write(`${SESSIONS_DIR}/-/b.jsonl`, sessionText(sessionIdOf(2)));
    files.write(`${SESSIONS_DIR}/c.jsonl`, sessionText(sessionIdOf(3)));
    files.write(`${SESSIONS_DIR}/notes/d.jsonl`, sessionText(sessionIdOf(4)));
    const finder = createSessionFileFinder({
      sessionsDir: path.resolve(SESSIONS_DIR),
      io: files.io,
      isProjectFolder: startsWithDash,
    });
    expect((await finder.recent(NOW)).map((ref) => path.basename(ref.path)).sort()).toEqual([
      "a.jsonl",
      "b.jsonl",
      "c.jsonl",
    ]);
    expect(files.count(undefined, (target) => target.startsWith(`${SESSIONS_DIR}/notes`))).toBe(0);
  });

  test("left out, only Pi's folders between two pairs of dashes are gone into", async () => {
    const files = memoryFiles();
    files.write(`${SESSIONS_DIR}/-Users-example-code-demo/a.jsonl`, sessionText(SESSION_ID));
    files.write(
      `${projectFolderOf("/Users/example/code/demo")}/b.jsonl`,
      sessionText(sessionIdOf(2)),
    );
    expect(await found(finderOf(files))).toEqual(["b.jsonl"]);
  });
});
