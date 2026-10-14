import { describe, expect, test } from "vitest";

import {
  createProjectLister,
  PROJECT_ROOT_LIMIT_BYTES,
  PROJECTS_REFRESH_MS,
  projectRootOf,
} from "@collector/adapters/gemini-cli/projects";
import {
  chatName,
  chatPath,
  HOME,
  idleSession,
  ids,
  NOW,
  OTHER_PROJECT,
  OTHER_SLUG,
  PROJECT,
  projectRootPath,
  SLUG,
  TMP_DIR,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { folderTimes, memoryFiles } from "@tests/support/adapters/geminiCliAdapter";
import { asWritten } from "@tests/support/paths";

function setUp() {
  const files = memoryFiles();
  const timed = folderTimes(files.io);
  const lister = createProjectLister({ tmpDir: TMP_DIR, io: timed.io });
  // Each folder as the tests write it, whatever system joined it.
  const list = async (now = NOW) =>
    (await lister.list(await timed.io.stat(TMP_DIR), now)).map((project) => ({
      ...project,
      dir: asWritten(project.dir),
    }));
  return { files, timed, list };
}

describe("projectRootOf", () => {
  test.each([
    [PROJECT, PROJECT],
    [`  ${PROJECT}  `, PROJECT],
    ["c:\\users\\example\\code\\demo-project", "c:\\users\\example\\code\\demo-project"],
    ["code/demo-project", null],
    ["", null],
    [`${PROJECT}\n${OTHER_PROJECT}`, null],
    [`${PROJECT}\u0007`.padStart(40), null],
  ])("%j is %j", (text, cwd) => {
    expect(projectRootOf(text)).toBe(cwd);
  });
});

describe("the project folders in tmp/", () => {
  test("are its folders, with each one's .project_root, and not bin, background-processes or files", async () => {
    const { files, list } = setUp();
    files.write(projectRootPath(), PROJECT);
    files.write(chatPath(chatName(NOW, ids.idle)), idleSession());
    files.write(projectRootPath(OTHER_SLUG), `${OTHER_PROJECT}\n`);
    files.mkdir(`${TMP_DIR}/bin`);
    files.mkdir(`${TMP_DIR}/background-processes`);
    files.write(`${TMP_DIR}/seen_screen_reader_nudge.json`, "{}");
    files.special(`${TMP_DIR}/linked-project`);

    expect(await list()).toEqual([
      { slug: OTHER_SLUG, dir: `${TMP_DIR}/${OTHER_SLUG}`, cwd: OTHER_PROJECT },
      { slug: SLUG, dir: `${TMP_DIR}/${SLUG}`, cwd: PROJECT },
    ]);
    expect(files.count("readdir", (target) => target.includes("/bin"))).toBe(0);
    expect(files.opened()).toEqual([projectRootPath(OTHER_SLUG), projectRootPath()]);
  });

  test("bin or background-processes holding a .project_root is a project's, as Gemini CLI names a project in ~/bin", async () => {
    const { files, list } = setUp();
    files.write(projectRootPath("bin"), `${HOME}/bin`);
    files.write(`${TMP_DIR}/bin/placeholder-tool`, "");
    files.mkdir(`${TMP_DIR}/background-processes`);
    expect(await list()).toEqual([{ slug: "bin", dir: `${TMP_DIR}/bin`, cwd: `${HOME}/bin` }]);
  });

  test("a folder of an older version's hash, with no .project_root, is a project of no known folder", async () => {
    const { files, list } = setUp();
    const hashed = "a".repeat(64);
    files.mkdir(`${TMP_DIR}/${hashed}/chats`);
    expect(await list()).toEqual([{ slug: hashed, dir: `${TMP_DIR}/${hashed}`, cwd: null }]);
  });

  test.each([
    ["one too large to be a path", "/".padEnd(PROJECT_ROOT_LIMIT_BYTES + 1, "a")],
    ["a relative path", "code/demo-project"],
    ["control characters", `${PROJECT}\u0000`],
    ["two lines", `${PROJECT}\n${OTHER_PROJECT}`],
  ])(".project_root holding %s names no folder", async (_name, text) => {
    const { files, list } = setUp();
    files.write(projectRootPath(), text);
    expect((await list())[0]?.cwd).toBeNull();
  });

  test("a .project_root that is a link, a pipe or a device is never opened", async () => {
    const { files, list } = setUp();
    files.special(projectRootPath());
    expect((await list())[0]?.cwd).toBeNull();
    expect(files.opened()).toEqual([]);
  });

  test("each .project_root is read again only when it changed", async () => {
    const { files, list } = setUp();
    files.write(projectRootPath(), PROJECT);
    await list(NOW);
    // Listed again, a while later: the file is looked at, not opened.
    files.forget();
    await list(NOW + PROJECTS_REFRESH_MS);
    expect(files.count("lstat", (target) => target === projectRootPath())).toBe(1);
    expect(files.opened()).toEqual([]);

    files.rewrite(projectRootPath(), OTHER_PROJECT, { mtimeMs: NOW + 1 });
    files.forget();
    expect((await list(NOW + 2 * PROJECTS_REFRESH_MS))[0]?.cwd).toBe(OTHER_PROJECT);
    expect(files.opened()).toEqual([projectRootPath()]);
  });

  test("a .project_root replaced by another file is read again, though its size and time are the same", async () => {
    const { files, list } = setUp();
    files.write(projectRootPath(), PROJECT, { mtimeMs: NOW });
    await list(NOW);
    const moved = `${HOME}/work/demo-project`;
    expect(moved).toHaveLength(PROJECT.length);
    files.write(projectRootPath(), moved, { mtimeMs: NOW });
    expect((await list(NOW + PROJECTS_REFRESH_MS))[0]?.cwd).toBe(moved);
  });

  test("tmp/ is listed again when its time moves, or at least every 30 seconds", async () => {
    const { files, timed, list } = setUp();
    files.write(projectRootPath(), PROJECT);
    await list(NOW);

    files.forget();
    files.write(projectRootPath(OTHER_SLUG), OTHER_PROJECT);
    // Not yet: the folder's time has not moved, and it was listed a moment ago.
    expect(await list(NOW + 2_000)).toHaveLength(1);
    expect(files.count("readdir")).toBe(0);

    timed.touch(TMP_DIR, NOW + 3_000);
    expect(await list(NOW + 4_000)).toHaveLength(2);

    files.remove(`${TMP_DIR}/${OTHER_SLUG}`);
    expect(await list(NOW + 5_000)).toHaveLength(2);
    expect(await list(NOW + 4_000 + PROJECTS_REFRESH_MS)).toHaveLength(1);
  });

  test("a project whose .project_root was not there yet is looked at again on every call", async () => {
    const { files, list } = setUp();
    files.mkdir(`${TMP_DIR}/${SLUG}/chats`);
    expect((await list(NOW))[0]?.cwd).toBeNull();
    files.write(projectRootPath(), PROJECT);
    expect((await list(NOW + 2_000))[0]?.cwd).toBe(PROJECT);
  });

  describe("on Windows, where Gemini CLI writes the folder in lower case", () => {
    const onDisk = "C:\\Users\\Example\\Code\\Demo-Project";

    /** A lister for Windows whose system gives `real` as each folder's path, or none. */
    function windowsLister(real: (target: string) => string | null) {
      const files = memoryFiles();
      const asked: string[] = [];
      const io = {
        ...files.io,
        async realpath(target: string) {
          asked.push(target);
          const found = real(target);
          if (found === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return found;
        },
      };
      const lister = createProjectLister({ tmpDir: TMP_DIR, io, platform: "win32" });
      files.write(projectRootPath(), onDisk.toLowerCase());
      const cwd = async () => (await lister.list(await io.stat(TMP_DIR), NOW))[0]?.cwd;
      return { files, asked, cwd };
    }

    test("takes the folder's case from its disk", async () => {
      const { asked, cwd } = windowsLister(() => onDisk);
      expect(await cwd()).toBe(onDisk);
      expect(asked).toEqual([onDisk.toLowerCase()]);
    });

    test("keeps the text as written when the disk gives another folder, or none", async () => {
      expect(await windowsLister(() => "D:\\Linked\\Demo-Project").cwd()).toBe(
        onDisk.toLowerCase(),
      );
      expect(await windowsLister(() => null).cwd()).toBe(onDisk.toLowerCase());
    });

    test("asks nothing of the system on macOS and Linux", async () => {
      const files = memoryFiles();
      const io = {
        ...files.io,
        realpath: async () => {
          throw new Error("Not to be asked.");
        },
      };
      files.write(projectRootPath(), PROJECT);
      const lister = createProjectLister({ tmpDir: TMP_DIR, io, platform: "darwin" });
      expect((await lister.list(await io.stat(TMP_DIR), NOW))[0]?.cwd).toBe(PROJECT);
    });
  });

  test("rejects when tmp/ cannot be listed", async () => {
    const { files, timed } = setUp();
    files.mkdir(TMP_DIR);
    const lister = createProjectLister({ tmpDir: TMP_DIR, io: timed.io });
    files.fail(TMP_DIR);
    await expect(
      lister.list({ kind: "directory", size: 0, mtimeMs: 0, ino: 1 }, NOW),
    ).rejects.toThrow();
  });
});
