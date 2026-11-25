import {
  closeSync,
  constants,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  OPEN_FOLLOWS_LINKS,
  openWithoutFollowing,
  openWithoutFollowingNow,
} from "@collector/files/noFollow";
import { tempDir } from "@tests/support/node/tempFiles";

/** What another program does between the look at a name and the open of it, once. */
const meanwhile = vi.hoisted((): { act: (() => void) | null } => ({ act: null }));

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const openSync: typeof real.openSync = (...args) => {
    meanwhile.act?.();
    return real.openSync(...args);
  };
  return { ...real, openSync, default: { ...real, openSync } };
});

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const open: typeof real.open = (...args) => {
    meanwhile.act?.();
    return real.open(...args);
  };
  return { ...real, open, default: { ...real, open } };
});

const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;

/** A folder with an ordinary file in it, and a link to that file beside it. */
async function fileAndLink() {
  const dir = await tempDir();
  const file = path.join(dir, "real.jsonl");
  await writeFile(file, "content");
  const link = path.join(dir, "link.jsonl");
  await symlink("real.jsonl", link);
  return { dir, file, link };
}

describe("opening without following a link", () => {
  test("only Windows has no flag that stops an open following a link", () => {
    expect(OPEN_FOLLOWS_LINKS).toBe(process.platform === "win32");
  });

  // Both ways are checked on every system: this system's own, and the check
  // made on Windows, where the name is looked at again once the file is open.
  describe.each([
    ["this system's way", OPEN_FOLLOWS_LINKS],
    ["the way of a system whose open follows links", true],
  ])("%s", (_way, follows) => {
    test("an ordinary file is opened and read", async () => {
      const { file } = await fileAndLink();
      const handle = await openWithoutFollowing(file, constants.O_RDONLY, undefined, follows);
      try {
        expect((await handle.readFile()).toString("utf8")).toBe("content");
      } finally {
        await handle.close();
      }
      const fd = openWithoutFollowingNow(file, constants.O_RDONLY, undefined, follows);
      try {
        const buffer = Buffer.alloc(7);
        readSync(fd, buffer, 0, 7, 0);
        expect(buffer.toString("utf8")).toBe("content");
      } finally {
        closeSync(fd);
      }
    });

    test("a link to an ordinary file beside it is refused", async () => {
      const { link } = await fileAndLink();
      await expect(
        openWithoutFollowing(link, constants.O_RDONLY, undefined, follows),
      ).rejects.toThrow();
      expect(() => openWithoutFollowingNow(link, constants.O_RDONLY, undefined, follows)).toThrow();
    });

    test("nothing is written through a link, and a new file is made and written", async () => {
      const { dir, file, link } = await fileAndLink();
      await expect(openWithoutFollowing(link, APPEND, 0o600, follows)).rejects.toThrow();
      expect(() => openWithoutFollowingNow(link, APPEND, 0o600, follows)).toThrow();
      expect(await readFile(file, "utf8")).toBe("content");

      const fresh = path.join(dir, "fresh.jsonl");
      const fd = openWithoutFollowingNow(fresh, APPEND, 0o600, follows);
      try {
        writeSync(fd, "line\n");
      } finally {
        closeSync(fd);
      }
      expect(await readFile(fresh, "utf8")).toBe("line\n");
    });
  });

  // A name is looked at first only where an open follows links.
  test.each([
    ["a new file", (other: string, file: string) => renameSync(other, file)],
    [
      "a link",
      (other: string, file: string) => {
        rmSync(file);
        symlinkSync(other, file);
      },
    ],
  ])("%s put in place of a file between the look and the open gives ESTALE", async (_, put) => {
    const opens = [
      (file: string) => openWithoutFollowing(file, constants.O_RDONLY, undefined, true),
      async (file: string) => openWithoutFollowingNow(file, constants.O_RDONLY, undefined, true),
    ];
    for (const open of opens) {
      const { dir, file } = await fileAndLink();
      const other = path.join(dir, "other.jsonl");
      await writeFile(other, "other");
      meanwhile.act = () => {
        meanwhile.act = null;
        put(other, file);
      };
      await expect(open(file)).rejects.toMatchObject({ code: "ESTALE" });
      expect(meanwhile.act).toBeNull();
    }
  });
});
