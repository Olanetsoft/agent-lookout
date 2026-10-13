import { describe, expect, test } from "vitest";

import {
  createOtherFolderCheck,
  otherFoldersNote,
} from "@collector/adapters/antigravity/cli/otherFolders";
import { tildify } from "@collector/files/paths";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { AGY_HOME, HOME, MINUTE, NOW, SECOND } from "@tests/fixtures/antigravity";
import { caseBlind, memoryFiles } from "@tests/support/adapters/antigravityAdapter";

const IDE = `${HOME}/.gemini/antigravity-ide`;
const APP = `${HOME}/.gemini/antigravity`;

const IDE_NOTE =
  "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout does not read the IDE yet.";

/** A check beside the CLI folder the adapter reads, `~/.gemini/antigravity-cli` unless named, on a file system held in memory. */
function checkFor(
  files: ReturnType<typeof memoryFiles>,
  home = AGY_HOME,
  platform: NodeJS.Platform = "darwin",
  io: ReadOnlyIo = files.io,
) {
  return createOtherFolderCheck({
    home,
    io,
    recheckMs: MINUTE,
    platform,
    name: (target) => tildify(target, HOME),
  });
}

describe("otherFoldersNote", () => {
  test("says nothing when the IDE's folder is not there", () => {
    expect(otherFoldersNote(null)).toBeNull();
  });

  test("says the IDE's folder is there and that the IDE is not read yet", () => {
    expect(otherFoldersNote("~/.gemini/antigravity-ide")).toBe(IDE_NOTE);
  });
});

describe("createOtherFolderCheck", () => {
  test("makes one lstat of the IDE's folder beside the CLI's, and no other call", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(IDE);
    files.write(`${IDE}/settings.json`, "{}");
    expect(await checkFor(files).note(NOW)).toBe(IDE_NOTE);
    expect(files.calls).toEqual([{ method: "lstat", path: IDE }]);
  });

  test("never looks at Antigravity 2.0's folder, which a source of its own reads", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(APP);
    expect(await checkFor(files).note(NOW)).toBeNull();
    expect(files.calls).toEqual([{ method: "lstat", path: IDE }]);
  });

  test("looks again only once a minute has passed, and then sees a folder that came or went", async () => {
    const files = memoryFiles(() => NOW);
    const check = checkFor(files);
    expect(await check.note(NOW)).toBeNull();
    files.mkdir(IDE);
    files.forget();
    expect(await check.note(NOW + MINUTE - SECOND)).toBeNull();
    expect(files.calls).toEqual([]);
    expect(await check.note(NOW + MINUTE)).toBe(IDE_NOTE);
    expect(files.count("lstat")).toBe(1);
    files.remove(IDE);
    expect(await check.note(NOW + MINUTE + SECOND)).toBe(IDE_NOTE);
    expect(await check.note(NOW + 2 * MINUTE)).toBeNull();
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles(() => NOW);
    const check = checkFor(files);
    await check.note(NOW);
    files.forget();
    await check.note(NOW - SECOND);
    expect(files.count("lstat")).toBe(1);
  });

  test("a link in the folder's place counts as there, and an ordinary file does not", async () => {
    const linked = memoryFiles(() => NOW);
    linked.special(IDE);
    expect(await checkFor(linked).note(NOW)).toBe(IDE_NOTE);
    const file = memoryFiles(() => NOW);
    file.write(IDE, "not a folder");
    expect(await checkFor(file).note(NOW)).toBeNull();
  });

  test("a folder that cannot be looked at is not said to be there", async () => {
    for (const code of ["EACCES", "ELOOP"]) {
      const files = memoryFiles(() => NOW);
      files.mkdir(IDE);
      files.fail(IDE, code);
      expect(await checkFor(files).note(NOW)).toBeNull();
    }
  });

  test("the folder the adapter reads as the CLI's is never taken for the IDE's", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(IDE);
    expect(await checkFor(files, IDE).note(NOW)).toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("on macOS and Windows, the CLI's folder named in another case is not taken for the IDE's when the disk says they are one folder", async () => {
    const home = `${HOME}/.gemini/Antigravity-IDE`;
    for (const platform of ["darwin", "win32"] as const) {
      const files = memoryFiles(() => NOW);
      files.mkdir(IDE);
      // A disk that ignores case, as they are formatted by default: the two names are one folder.
      const io = caseBlind(files.io, { [home]: IDE });
      expect(await checkFor(files, home, platform, io).note(NOW), platform).toBeNull();
    }
  });

  test("a disk that tells case apart can hold the IDE's folder beside a CLI folder named like it, and the IDE's is reported", async () => {
    const home = `${HOME}/.gemini/Antigravity-IDE`;
    const files = memoryFiles(() => NOW);
    files.mkdir(IDE);
    files.mkdir(home);
    expect(await checkFor(files, home, "darwin").note(NOW)).toBe(IDE_NOTE);
    // On Linux a name keeps its case, so `Antigravity-IDE` is another folder, and the disk is not asked.
    const linux = memoryFiles(() => NOW);
    linux.mkdir(IDE);
    expect(await checkFor(linux, home, "linux").note(NOW)).toBe(IDE_NOTE);
    expect(linux.calls.filter((call) => call.method === "stat")).toEqual([]);
  });
});
