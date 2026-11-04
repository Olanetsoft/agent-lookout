import { describe, expect, test } from "vitest";

import {
  createListReader,
  databaseOf,
  MAX_LIST_BYTES,
  MAX_PROJECTS,
  parseProjectList,
  projectFolderOf,
} from "@collector/adapters/crush/projects";
import {
  DATA_DIR,
  DATABASE,
  HOME,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  PROJECT_LIST,
  projectEntry,
  projectListJson,
  SECOND,
} from "@tests/fixtures/crush/crush";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/crush/crushAdapter";

const readerOf = (files: MemoryFiles) => createListReader({ dataFolder: DATA_DIR, io: files.io });

/** Two folders of one length, so a list of them keeps its length when they swap. */
const FOLDER_A = `${HOME}/code/aaaa`;
const FOLDER_B = `${HOME}/code/bbbb`;

describe("a project's folder", () => {
  test("is an absolute path", () => {
    expect(projectFolderOf(PROJECT)).toBe(PROJECT);
  });

  test("loses a slash at its end, so one folder is one project", () => {
    expect(projectFolderOf(`${PROJECT}/`)).toBe(PROJECT);
  });

  test.each([
    ["a relative path", "code/demo-project"],
    ["a relative path up a folder, as crush --cwd writes it", "../demo-project"],
    ["a path from the home folder", "~/code/demo-project"],
    ["a Windows path", "C:\\Users\\example\\code"],
    ["nothing", ""],
    ["the root", "/"],
    ["a way up", "/Users/example/../other/demo"],
    ["a way up at its end", "/Users/example/code/.."],
    ["a dot", "/Users/example/./code"],
    ["a line break", "/Users/example/co\nde"],
    ["a mark that turns text around", "/Users/example/co\u202Ede"],
    ["too many letters", `/${"a".repeat(4096)}`],
    ["a number", 7],
    ["null", null],
    ["a list", [PROJECT]],
  ])("is never %s", (_name, value) => {
    expect(projectFolderOf(value)).toBeNull();
  });

  test("holds its database at .crush/crush.db, with `/` on every system", () => {
    expect(databaseOf(PROJECT)).toBe(DATABASE);
  });
});

describe("parseProjectList", () => {
  test("takes each folder, the newest first, as the file has them", () => {
    expect(parseProjectList(projectListJson([PROJECT, OTHER_PROJECT]))).toEqual([
      PROJECT,
      OTHER_PROJECT,
    ]);
  });

  test("takes nothing of an entry but its path", () => {
    const text = JSON.stringify({
      projects: [{ path: PROJECT, data_dir: "/somewhere/else", last_accessed: "not a time" }],
    });
    expect(parseProjectList(text)).toEqual([PROJECT]);
  });

  test("skips an entry with no good path, and goes on", () => {
    const text = projectListJson(["relative/folder", 7, null, PROJECT]);
    expect(parseProjectList(text)).toEqual([PROJECT]);
    expect(parseProjectList(JSON.stringify({ projects: [null, "text", 7, {}, []] }))).toEqual([]);
  });

  test("takes a folder once", () => {
    expect(parseProjectList(projectListJson([PROJECT, `${PROJECT}/`]))).toEqual([PROJECT]);
  });

  test("takes at most the newest 20", () => {
    const folders = Array.from({ length: MAX_PROJECTS + 5 }, (_, n) => `${HOME}/code/project-${n}`);
    const taken = parseProjectList(projectListJson(folders));
    expect(taken).toHaveLength(MAX_PROJECTS);
    expect(taken?.at(-1)).toBe(folders[MAX_PROJECTS - 1]);
  });

  test("a list with no projects has no folders", () => {
    expect(parseProjectList('{"projects":[]}')).toEqual([]);
  });

  test.each([
    ["no JSON", "not json"],
    ["half a file", '{"projects":[{"path":"/Us'],
    ["a list at the top", "[]"],
    ["text", '"projects"'],
    ["null", "null"],
    ["no projects", "{}"],
    ["projects of the wrong type", '{"projects":{"path":"/a"}}'],
  ])("takes %s for no list", (_name, text) => {
    expect(parseProjectList(text)).toBeNull();
  });
});

describe("the list", () => {
  test("is its folders", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    expect(await readerOf(files).read()).toEqual({ state: "read", folders: [PROJECT] });
  });

  test("is opened once, and again only when it changes", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = readerOf(files);
    await reader.read();
    await reader.read();
    expect(files.count("openRegular")).toBe(1);

    files.write(PROJECT_LIST, projectListJson([OTHER_PROJECT]));
    expect(await reader.read()).toEqual({ state: "read", folders: [OTHER_PROJECT] });
    expect(files.count("openRegular")).toBe(2);
    expect(files.openHandles()).toBe(0);
  });

  describe("is read again on a change of any one of its size, time and identity", () => {
    /** A reader that has read the two folders once. */
    async function readOnce() {
      const files = memoryFiles();
      files.write(PROJECT_LIST, projectListJson([FOLDER_A, FOLDER_B]));
      const reader = readerOf(files);
      await reader.read();
      return { files, reader };
    }

    test("its time, as when Crush rewrites it in place with a folder moved to the front", async () => {
      const { files, reader } = await readOnce();
      files.rewrite(PROJECT_LIST, projectListJson([FOLDER_B, FOLDER_A]), {
        mtimeMs: NOW + SECOND,
      });
      expect(await reader.read()).toEqual({ state: "read", folders: [FOLDER_B, FOLDER_A] });
    });

    test("its identity, with a new file of the same size and time", async () => {
      const { files, reader } = await readOnce();
      files.write(PROJECT_LIST, projectListJson([FOLDER_B, FOLDER_A]));
      expect(await reader.read()).toEqual({ state: "read", folders: [FOLDER_B, FOLDER_A] });
    });

    test("its size, in the same file at the same time", async () => {
      const { files, reader } = await readOnce();
      files.rewrite(PROJECT_LIST, projectListJson([FOLDER_A]), { mtimeMs: NOW });
      expect(await reader.read()).toEqual({ state: "read", folders: [FOLDER_A] });
    });
  });

  test("is missing when the folder has no such file, and when there is no folder", async () => {
    const files = memoryFiles();
    expect(await readerOf(files).read()).toEqual({ state: "missing" });
    files.mkdir(DATA_DIR);
    expect(await readerOf(files).read()).toEqual({ state: "missing" });
  });

  test("goes when the file goes", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = readerOf(files);
    await reader.read();
    files.remove(PROJECT_LIST);
    expect(await reader.read()).toEqual({ state: "missing" });
  });

  test("is not opened through a link at its name", async () => {
    const files = memoryFiles();
    files.special(PROJECT_LIST);
    expect(await readerOf(files).read()).toEqual({ state: "not-safe" });
    expect(files.opened()).toEqual([]);
  });

  test("is not opened through a link at the data folder's name", async () => {
    const files = memoryFiles();
    files.special(DATA_DIR);
    expect(await readerOf(files).read()).toEqual({ state: "not-safe" });
    expect(files.opened()).toEqual([]);
  });

  test("is not read when it is over 1 MiB, and the last one does not stand", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = readerOf(files);
    await reader.read();
    files.write(PROJECT_LIST, "x".repeat(MAX_LIST_BYTES + 1));
    files.forget();
    expect(await reader.read()).toEqual({ state: "too-large" });
    expect(files.opened()).toEqual([]);
  });

  test("of exactly 1 MiB is read", async () => {
    const files = memoryFiles();
    const text = projectListJson();
    files.write(PROJECT_LIST, text + " ".repeat(MAX_LIST_BYTES - text.length));
    expect((await readerOf(files).read()).state).toBe("read");
  });

  test("that grows past 1 MiB between the look and the open is not taken", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = createListReader({
      dataFolder: DATA_DIR,
      io: {
        ...files.io,
        async openRegular(file) {
          const opened = await files.io.openRegular(file);
          return { ...opened, info: { ...opened.info, size: MAX_LIST_BYTES + 1 } };
        },
      },
    });
    expect(await reader.read()).toEqual({ state: "unreadable" });
    expect(files.reads).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("that cannot be taken for one, with none before it, is unreadable", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, "not json");
    expect(await readerOf(files).read()).toEqual({ state: "unreadable" });
  });

  test("caught half written leaves the last one standing, and the next change is read", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = readerOf(files);
    await reader.read();
    files.write(PROJECT_LIST, '{"projects":[{"pa');
    expect(await reader.read()).toEqual({ state: "read", folders: [PROJECT] });
    files.write(PROJECT_LIST, projectListJson([OTHER_PROJECT]));
    expect(await reader.read()).toEqual({ state: "read", folders: [OTHER_PROJECT] });
  });

  test("that cannot be looked at or opened leaves the last one standing", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    const reader = readerOf(files);
    await reader.read();
    files.fail(PROJECT_LIST);
    expect(await reader.read()).toEqual({ state: "read", folders: [PROJECT] });
    files.heal(PROJECT_LIST);
    files.write(PROJECT_LIST, projectListJson([OTHER_PROJECT]));
    files.failOpen(PROJECT_LIST);
    expect(await reader.read()).toEqual({ state: "read", folders: [PROJECT] });
  });

  test("names nothing but the file it is given", async () => {
    const files = memoryFiles();
    files.write(PROJECT_LIST, projectListJson());
    files.write(`${DATA_DIR}/crush.json`, '{"providers":{"demo":{"api_key":"placeholder"}}}');
    await readerOf(files).read();
    expect(files.opened()).toEqual([PROJECT_LIST]);
  });

  test("keeps the order of the file, not of a time in it", () => {
    const text = JSON.stringify({
      projects: [
        { ...projectEntry(PROJECT), last_accessed: "2026-01-01T00:00:00Z" },
        { ...projectEntry(OTHER_PROJECT), last_accessed: "2026-10-01T00:00:00Z" },
      ],
    });
    expect(parseProjectList(text)).toEqual([PROJECT, OTHER_PROJECT]);
  });
});
