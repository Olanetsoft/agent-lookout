import { describe, expect, test } from "vitest";

import {
  createOtherFolderCheck,
  otherFoldersNote,
} from "@collector/adapters/antigravity/otherFolders";
import { tildify } from "@collector/files/paths";
import { AGY_HOME, HOME, MINUTE, NOW, SECOND } from "@tests/fixtures/antigravity";
import { memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const IDE = `${HOME}/.gemini/antigravity-ide`;
const APP = `${HOME}/.gemini/antigravity`;

/** A check beside the CLI folder the adapter reads, `~/.gemini/antigravity-cli` unless named, on a file system held in memory. */
function checkFor(
  files: ReturnType<typeof memoryFiles>,
  home = AGY_HOME,
  platform: NodeJS.Platform = "darwin",
) {
  return createOtherFolderCheck({
    home,
    io: files.io,
    recheckMs: MINUTE,
    platform,
    name: (target) => tildify(target, HOME),
  });
}

describe("otherFoldersNote", () => {
  test("says nothing when neither folder is there", () => {
    expect(otherFoldersNote({ ide: null, app: null })).toBeNull();
  });

  test("says the IDE's folder is there and that only the CLI is read", () => {
    expect(otherFoldersNote({ ide: "~/.gemini/antigravity-ide", app: null })).toBe(
      "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout reads only the Antigravity CLI so far, not the IDE.",
    );
  });

  test("says Antigravity 2.0's folder is there, which an older IDE used too, and is not read yet", () => {
    expect(otherFoldersNote({ ide: null, app: "~/.gemini/antigravity" })).toBe(
      "A folder of Antigravity 2.0, or of an older Antigravity IDE, is here, ~/.gemini/antigravity. Agent Lookout does not read it yet.",
    );
  });

  test("names both when both are there", () => {
    expect(
      otherFoldersNote({ ide: "~/.gemini/antigravity-ide", app: "~/.gemini/antigravity" }),
    ).toBe(
      "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide, and so is one of Antigravity 2.0, or of an older Antigravity IDE, ~/.gemini/antigravity. Agent Lookout reads only the Antigravity CLI so far, not either of them.",
    );
  });
});

describe("createOtherFolderCheck", () => {
  test("makes one lstat of each folder beside the CLI's, and no other call", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(IDE);
    files.write(`${IDE}/settings.json`, "{}");
    files.mkdir(APP);
    expect(await checkFor(files).note(NOW)).toContain("~/.gemini/antigravity-ide");
    expect(files.calls).toEqual([
      { method: "lstat", path: IDE },
      { method: "lstat", path: APP },
    ]);
  });

  test("looks again only once a minute has passed, and then sees a folder that came or went", async () => {
    const files = memoryFiles(() => NOW);
    const check = checkFor(files);
    expect(await check.note(NOW)).toBeNull();
    files.mkdir(IDE);
    files.forget();
    expect(await check.note(NOW + MINUTE - SECOND)).toBeNull();
    expect(files.calls).toEqual([]);
    expect(await check.note(NOW + MINUTE)).toContain("The Antigravity IDE's folder is here");
    expect(files.count("lstat")).toBe(2);
    files.remove(IDE);
    expect(await check.note(NOW + MINUTE + SECOND)).toContain("~/.gemini/antigravity-ide");
    expect(await check.note(NOW + 2 * MINUTE)).toBeNull();
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles(() => NOW);
    const check = checkFor(files);
    await check.note(NOW);
    files.forget();
    await check.note(NOW - SECOND);
    expect(files.count("lstat")).toBe(2);
  });

  test("a link in a folder's place counts as there, and an ordinary file does not", async () => {
    const files = memoryFiles(() => NOW);
    files.special(IDE);
    files.write(APP, "not a folder");
    expect(await checkFor(files).note(NOW)).toBe(
      "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout reads only the Antigravity CLI so far, not the IDE.",
    );
  });

  test("a folder that cannot be looked at is not said to be there", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(IDE);
    files.fail(IDE);
    files.fail(APP, "ELOOP");
    expect(await checkFor(files).note(NOW)).toBeNull();
  });

  test("the folder the adapter reads as the CLI's is never taken for another", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(APP);
    files.mkdir(IDE);
    expect(await checkFor(files, APP).note(NOW)).toBe(
      "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout reads only the Antigravity CLI so far, not the IDE.",
    );
    expect(files.calls).toEqual([{ method: "lstat", path: IDE }]);
  });

  test("on macOS and Windows, the CLI's folder named in another case is still not taken for another", async () => {
    for (const platform of ["darwin", "win32"] as const) {
      const files = memoryFiles(() => NOW);
      files.mkdir(APP);
      expect(await checkFor(files, `${HOME}/.gemini/Antigravity`, platform).note(NOW)).toBeNull();
      expect(files.calls).toEqual([{ method: "lstat", path: IDE }]);
    }
    // On Linux a name keeps its case, so `Antigravity` is another folder.
    const files = memoryFiles(() => NOW);
    files.mkdir(APP);
    expect(await checkFor(files, `${HOME}/.gemini/Antigravity`, "linux").note(NOW)).toBe(
      "A folder of Antigravity 2.0, or of an older Antigravity IDE, is here, ~/.gemini/antigravity. Agent Lookout does not read it yet.",
    );
  });
});
