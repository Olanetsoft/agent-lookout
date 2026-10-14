import { describe, expect, test } from "vitest";

import {
  createChatFinder,
  isQwenSessionId,
  projectFolderName,
  RESCAN_MS,
} from "@collector/adapters/qwen-code/transcriptFile";
import {
  chatFile,
  chatPath,
  NOW,
  PROJECT,
  PROJECT_FOLDER,
  promptLine,
  QWEN_DIR,
  sessionIdOf,
} from "@tests/fixtures/qwen-code/qwenCode";
import { memoryFiles } from "@tests/support/adapters/qwenCodeAdapter";

const PROJECTS = `${QWEN_DIR}/projects`;
const ID = sessionIdOf(1);

function finderOn(files: ReturnType<typeof memoryFiles>, platform: NodeJS.Platform = "darwin") {
  return createChatFinder({ projectsDir: PROJECTS, io: files.io, platform });
}

describe("projectFolderName", () => {
  test("makes every character that is not a letter or a digit a dash, as Qwen Code does", () => {
    expect(projectFolderName(PROJECT, "darwin")).toBe(PROJECT_FOLDER);
    expect(projectFolderName("/Users/example/code/demo.app_2", "linux")).toBe(
      "-Users-example-code-demo-app-2",
    );
  });

  test("makes the folder lowercase first on Windows", () => {
    expect(projectFolderName("C:\\Users\\Example\\Code\\Demo", "win32")).toBe(
      "c--users-example-code-demo",
    );
  });

  test("can never name a folder above projects", () => {
    expect(projectFolderName("../../..", "darwin")).toBe("--------");
  });
});

describe("isQwenSessionId", () => {
  test.each([
    sessionIdOf(1),
    "0123456789abcdef0123456789ABCDEF",
    "00000000000000000000000000000000",
  ])("%s is an id", (id) => {
    expect(isQwenSessionId(id)).toBe(true);
  });

  test.each([
    "",
    "../x",
    "a/b",
    `${sessionIdOf(1)}.jsonl`,
    "x".repeat(36),
    sessionIdOf(1) + "0",
    7,
  ])("%j is not one", (id) => {
    expect(isQwenSessionId(id)).toBe(false);
  });
});

describe("createChatFinder", () => {
  test("finds the file in the folder named for the session's folder, with one lstat", async () => {
    const files = memoryFiles();
    files.write(chatPath(QWEN_DIR, ID), chatFile(promptLine(NOW)));
    const found = await finderOn(files).find(ID, PROJECT, NOW);
    expect(found?.path).toBe(chatPath(QWEN_DIR, ID));
    expect(found?.info.kind).toBe("file");
    expect(files.calls).toEqual([{ method: "lstat", path: chatPath(QWEN_DIR, ID) }]);
  });

  test("on a miss looks in every folder once, and then not again for 30 seconds", async () => {
    const files = memoryFiles();
    files.mkdir(`${PROJECTS}/-Users-example-code-other`);
    const finder = finderOn(files);
    expect(await finder.find(ID, PROJECT, NOW)).toBeNull();
    expect(files.count("readdir")).toBe(1);

    files.forget();
    expect(await finder.find(ID, PROJECT, NOW + RESCAN_MS - 1)).toBeNull();
    // Only the likely place is looked at, which a new session's first line makes.
    expect(files.calls).toEqual([{ method: "lstat", path: chatPath(QWEN_DIR, ID) }]);

    files.forget();
    await finder.find(ID, PROJECT, NOW + RESCAN_MS);
    expect(files.count("readdir")).toBe(1);
  });

  test("finds a session's file in another folder, and keeps where it found it", async () => {
    const files = memoryFiles();
    const elsewhere = chatPath(QWEN_DIR, ID, "-Users-example-code-other");
    files.write(elsewhere, chatFile(promptLine(NOW)));
    files.mkdir(`${PROJECTS}/.hidden`);
    const finder = finderOn(files);
    expect((await finder.find(ID, PROJECT, NOW))?.path).toBe(elsewhere);

    files.forget();
    expect((await finder.find(ID, PROJECT, NOW + 2_000))?.path).toBe(elsewhere);
    expect(files.calls).toEqual([{ method: "lstat", path: elsewhere }]);
    expect(files.count("lstat", (target) => target.includes(".hidden"))).toBe(0);
  });

  test("looks again when the session moves with /cd, and when the file has gone", async () => {
    const files = memoryFiles();
    files.write(chatPath(QWEN_DIR, ID), chatFile(promptLine(NOW)));
    const finder = finderOn(files);
    await finder.find(ID, PROJECT, NOW);

    // /cd moves the file into the new folder's and names the new folder in the record.
    files.remove(chatPath(QWEN_DIR, ID));
    const moved = chatPath(QWEN_DIR, ID, "-Users-example-code-demo-api");
    files.write(moved, chatFile(promptLine(NOW)));
    expect((await finder.find(ID, "/Users/example/code/demo-api", NOW + 2_000))?.path).toBe(moved);

    files.remove(moved);
    expect(await finder.find(ID, "/Users/example/code/demo-api", NOW + 4_000)).toBeNull();
  });

  test("a link or a folder at the file's name is not a chat file", async () => {
    const files = memoryFiles();
    files.special(chatPath(QWEN_DIR, ID));
    expect(await finderOn(files).find(ID, PROJECT, NOW)).toBeNull();
    const other = memoryFiles();
    other.mkdir(chatPath(QWEN_DIR, ID));
    expect(await finderOn(other).find(ID, PROJECT, NOW)).toBeNull();
  });

  test("never looks for an id that is not one, and never at the files beside a chat file", async () => {
    const files = memoryFiles();
    files.write(chatPath(QWEN_DIR, ID), chatFile(promptLine(NOW)));
    files.write(`${PROJECTS}/${PROJECT_FOLDER}/chats/${ID}.runtime.json`, "{}");
    const finder = finderOn(files);
    for (const id of ["../x", "a/b", ""]) expect(await finder.find(id, PROJECT, NOW)).toBeNull();
    await finder.find(ID, PROJECT, NOW);
    expect(files.calls.map((call) => call.path)).toEqual([chatPath(QWEN_DIR, ID)]);
  });

  test("on Windows looks in the lowercase folder", async () => {
    const files = memoryFiles();
    const cwd = "/Users/Example/Code/Demo";
    files.write(chatPath(QWEN_DIR, ID, "-users-example-code-demo"), chatFile(promptLine(NOW)));
    expect((await finderOn(files, "win32").find(ID, cwd, NOW))?.path).toBe(
      chatPath(QWEN_DIR, ID, "-users-example-code-demo"),
    );
  });

  test("likely is one lstat of the likely place, and never a listing", async () => {
    const files = memoryFiles();
    const finder = finderOn(files);
    expect(await finder.likely(ID, PROJECT)).toBeNull();
    files.write(chatPath(QWEN_DIR, ID), chatFile(promptLine(NOW)), { mtimeMs: NOW - 5_000 });
    expect((await finder.likely(ID, PROJECT))?.mtimeMs).toBe(NOW - 5_000);
    expect(await finder.likely(ID, null)).toBeNull();
    expect(files.count("readdir")).toBe(0);
    expect(files.count("lstat")).toBe(2);
  });

  test("forgets the sessions it is told to", async () => {
    const files = memoryFiles();
    files.mkdir(PROJECTS);
    const finder = finderOn(files);
    await finder.find(ID, PROJECT, NOW);
    finder.keepOnly(new Set());
    files.forget();
    await finder.find(ID, PROJECT, NOW + 1_000);
    expect(files.count("readdir")).toBe(1);
  });
});
