import { describe, expect, test } from "vitest";

import {
  createFolderFinder,
  encodedFolderName,
  MAX_FOLDER_NAME_BYTES,
  type FolderWanted,
} from "@collector/adapters/grok-build/folders";
import {
  MINUTE,
  OPENED_AT,
  OTHER_SESSION_ID,
  NOW,
  PROJECT,
  PROJECT_FOLDER,
  SECOND,
  sessionFolder,
  SESSIONS_DIR,
  SESSION_ID,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  TEST_UID,
  type MemoryFiles,
} from "@tests/support/adapters/grok-build/grokBuildAdapter";
import { asWritten } from "@tests/support/paths";

const wanted = (fields: Partial<FolderWanted> = {}): FolderWanted => ({
  sessionId: SESSION_ID,
  cwd: PROJECT,
  openedAt: OPENED_AT,
  ...fields,
});

function finderOf(files: MemoryFiles, options: { maxNames?: number; maxIds?: number } = {}) {
  const owned = ownedFiles(files);
  return {
    owned,
    finder: createFolderFinder({
      sessionsDir: SESSIONS_DIR,
      io: owned.io,
      platform: "darwin",
      euid: TEST_UID,
      ...options,
    }),
  };
}

/** Where each session's folder was found, as the tests write paths. */
async function found(
  finder: ReturnType<typeof finderOf>["finder"],
  items: FolderWanted[],
  now = NOW,
) {
  const looks = await finder.find(items, now);
  return Object.fromEntries(
    [...looks].map(([id, look]) => [
      id,
      look.state === "found" ? asWritten(look.folder) : look.state,
    ]),
  );
}

describe("a folder's name", () => {
  test("is the working folder URL-encoded as urlencoding writes it, not as encodeURIComponent does", () => {
    expect(encodedFolderName(PROJECT)).toBe(PROJECT_FOLDER);
    expect(encodedFolderName("/a/!'()*")).toBe("%2Fa%2F%21%27%28%29%2A");
    expect(encodeURIComponent("/a/!'()*")).toBe("%2Fa%2F!'()*");
    expect(encodedFolderName("/a b/~x-y_z.w")).toBe("%2Fa%20b%2F~x-y_z.w");
    expect(encodedFolderName("/café/日本")).toBe("%2Fcaf%C3%A9%2F%E6%97%A5%E6%9C%AC");
    expect(encodedFolderName("C:\\Users\\example")).toBe("C%3A%5CUsers%5Cexample");
  });

  test("is none for a working folder whose name would be over 255 bytes, which Grok Build hashes", () => {
    const long = `/Users/example/${"日".repeat(30)}`;
    expect(encodedFolderName(long)).toBeNull();
    const fits = `/${"a".repeat(MAX_FOLDER_NAME_BYTES - 3)}`;
    expect(encodedFolderName(fits)).toHaveLength(MAX_FOLDER_NAME_BYTES);
    expect(encodedFolderName(`${fits}a`)).toBeNull();
  });
});

describe("finding a session's folder", () => {
  test("by its working folder's name, every poll", async () => {
    const files = memoryFiles();
    files.mkdir(sessionFolder());
    const { finder } = finderOf(files);
    expect(await found(finder, [wanted()])).toEqual({ [SESSION_ID]: sessionFolder() });
    files.forget();
    await found(finder, [wanted()]);
    expect(files.calls.map((call) => [call.method, call.path])).toEqual([
      ["lstat", SESSIONS_DIR],
      ["lstat", `${SESSIONS_DIR}/${PROJECT_FOLDER}`],
      ["lstat", sessionFolder()],
    ]);
  });

  test("a link at either level, or a folder of another user's, is not followed", async () => {
    const files = memoryFiles();
    files.mkdir(sessionFolder());
    const { owned, finder } = finderOf(files, {});
    owned.set(`${SESSIONS_DIR}/${PROJECT_FOLDER}`, { kind: "other" });
    expect(await found(finder, [wanted()], NOW)).toEqual({ [SESSION_ID]: "none" });
    owned.clear(`${SESSIONS_DIR}/${PROJECT_FOLDER}`);
    owned.set(sessionFolder(), { kind: "other" });
    expect(await found(finder, [wanted()], NOW + 2 * MINUTE)).toEqual({ [SESSION_ID]: "none" });
    owned.set(sessionFolder(), { kind: "directory", uid: OTHER_UID });
    expect(await found(finder, [wanted()], NOW + 4 * MINUTE)).toEqual({ [SESSION_ID]: "none" });
    owned.clear(sessionFolder());
    owned.set(SESSIONS_DIR, { kind: "other" });
    expect(await found(finder, [wanted()], NOW + 6 * MINUTE)).toEqual({ [SESSION_ID]: "none" });
  });

  test("a session in a hashed folder is found by its ID, and kept", async () => {
    const files = memoryFiles();
    const long = `/Users/example/${"日".repeat(30)}`;
    files.mkdir(`${SESSIONS_DIR}/workspace-0123456789abcdef/${SESSION_ID}`);
    files.mkdir(`${SESSIONS_DIR}/other-folder/${OTHER_SESSION_ID}`);
    const { finder } = finderOf(files);
    expect(await found(finder, [wanted({ cwd: long })])).toEqual({
      [SESSION_ID]: `${SESSIONS_DIR}/workspace-0123456789abcdef/${SESSION_ID}`,
    });
    files.forget();
    expect(await found(finder, [wanted({ cwd: long })], NOW + 2 * SECOND)).toEqual({
      [SESSION_ID]: `${SESSIONS_DIR}/workspace-0123456789abcdef/${SESSION_ID}`,
    });
    expect(files.count("readdir")).toBe(0);
  });

  test("a session whose folder moved is found by its ID", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/%2Felsewhere/${SESSION_ID}`);
    const { finder } = finderOf(files);
    expect(await found(finder, [wanted()])).toEqual({
      [SESSION_ID]: `${SESSIONS_DIR}/%2Felsewhere/${SESSION_ID}`,
    });
  });

  test("a folder found before that has gone is dropped and looked for again", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/%2Felsewhere/${SESSION_ID}`);
    const { finder } = finderOf(files);
    await found(finder, [wanted()]);
    expect(finder.kept).toBe(1);
    files.remove(`${SESSIONS_DIR}/%2Felsewhere`);
    files.mkdir(sessionFolder());
    expect(await found(finder, [wanted()], NOW + SECOND)).toEqual({
      [SESSION_ID]: sessionFolder(),
    });
    files.remove(sessionFolder());
    expect(await found(finder, [wanted()], NOW + 2 * SECOND)).toEqual({ [SESSION_ID]: "none" });
    expect(finder.kept).toBe(0);
  });

  test("an ID in two folders is in neither", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/%2Fone/${SESSION_ID}`);
    files.mkdir(`${SESSIONS_DIR}/%2Ftwo/${SESSION_ID}`);
    const { finder } = finderOf(files);
    expect(await found(finder, [wanted()])).toEqual({ [SESSION_ID]: "ambiguous" });
    expect(finder.kept).toBe(0);
  });

  test("the folders are looked through at most once a minute, and a clock set back counts as time enough", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/%2Fone`);
    const { finder } = finderOf(files);
    await found(finder, [wanted()], NOW);
    expect(files.count("readdir")).toBe(1);
    files.mkdir(`${SESSIONS_DIR}/%2Fone/${SESSION_ID}`);
    expect(await found(finder, [wanted()], NOW + MINUTE - 1)).toEqual({ [SESSION_ID]: "none" });
    expect(files.count("readdir")).toBe(1);
    expect(await found(finder, [wanted()], NOW + MINUTE)).toEqual({
      [SESSION_ID]: `${SESSIONS_DIR}/%2Fone/${SESSION_ID}`,
    });
    expect(files.count("readdir")).toBe(2);
    files.remove(`${SESSIONS_DIR}/%2Fone`);
    await found(finder, [wanted()], NOW + MINUTE + 1);
    expect(files.count("readdir")).toBe(2);
    await found(finder, [wanted()], NOW);
    expect(files.count("readdir")).toBe(3);
  });

  test("a folder made just after a look is found at the next, as the folders are listed afresh each time", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/%2Fone`);
    files.touch(SESSIONS_DIR, NOW);
    const { finder } = finderOf(files);
    await found(finder, [wanted()], NOW);
    // Made in the same rounded second, so the folder's time does not move.
    files.mkdir(`${SESSIONS_DIR}/%2Ftwo/${SESSION_ID}`);
    expect(await found(finder, [wanted()], NOW + MINUTE)).toEqual({
      [SESSION_ID]: `${SESSIONS_DIR}/%2Ftwo/${SESSION_ID}`,
    });
  });

  test("at most the first names, sorted, and the newest missing sessions are looked for", async () => {
    const files = memoryFiles();
    for (const name of ["%2Fa", "%2Fb", "%2Fc"]) files.mkdir(`${SESSIONS_DIR}/${name}`);
    files.mkdir(`${SESSIONS_DIR}/%2Fc/${SESSION_ID}`);
    files.mkdir(`${SESSIONS_DIR}/%2Fa/${OTHER_SESSION_ID}`);
    const { finder } = finderOf(files, { maxNames: 2, maxIds: 1 });
    const items = [wanted(), wanted({ sessionId: OTHER_SESSION_ID, openedAt: OPENED_AT + MINUTE })];
    expect(await found(finder, items)).toEqual({
      [SESSION_ID]: "none",
      [OTHER_SESSION_ID]: `${SESSIONS_DIR}/%2Fa/${OTHER_SESSION_ID}`,
    });
    expect(files.count("lstat", (target) => target.startsWith(`${SESSIONS_DIR}/%2Fc`))).toBe(0);
    // Its own folder's name was looked up, but not looked through for it.
    expect(files.count("lstat", (target) => target.endsWith(`/${SESSION_ID}`))).toBe(0);
  });

  test("names Grok Build never writes are not looked in", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSIONS_DIR}/odd name/${SESSION_ID}`);
    const { finder } = finderOf(files);
    expect(await found(finder, [wanted()])).toEqual({ [SESSION_ID]: "none" });
    expect(files.count("lstat", (target) => target.includes("odd name"))).toBe(0);
  });

  test("it forgets the sessions it is told to", async () => {
    const files = memoryFiles();
    files.mkdir(sessionFolder());
    const { finder } = finderOf(files);
    await found(finder, [wanted()]);
    finder.keepOnly(new Set([OTHER_SESSION_ID]));
    expect(finder.kept).toBe(0);
  });
});
