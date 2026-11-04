import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  createListReader,
  MAX_LIST_BYTES,
  PROJECT_LIST_FILE,
} from "@collector/adapters/crush/projects";
import { nodeIo } from "@collector/files/readOnlyIo";
import { PROJECT, projectListJson } from "@tests/fixtures/crush/crush";
import { tempDir } from "@tests/support/node/tempFiles";

// The list as it lies on a real disk, with real links. A named pipe waits forever
// for a writer if it is opened as a file, so one is made here to show that it
// never is. Windows has no named pipes of this kind.

function readerOf(dataFolder: string) {
  return createListReader({ dataFolder, io: nodeIo });
}

describe("Crush's list of projects, on a real disk", () => {
  test("is read", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, PROJECT_LIST_FILE), projectListJson());
    expect(await readerOf(dir).read()).toEqual({ state: "read", folders: [PROJECT] });
  });

  test.skipIf(process.platform === "win32")("is not read through a link", async () => {
    const dir = await tempDir();
    const elsewhere = path.join(await tempDir(), "elsewhere.json");
    await writeFile(elsewhere, projectListJson());
    await symlink(elsewhere, path.join(dir, PROJECT_LIST_FILE));
    expect(await readerOf(dir).read()).toEqual({ state: "not-safe" });
  });

  test.skipIf(process.platform === "win32")(
    "is not read when the data folder is a link",
    async () => {
      const dir = await tempDir();
      await writeFile(path.join(dir, PROJECT_LIST_FILE), projectListJson());
      const link = path.join(await tempDir(), "crush");
      await symlink(dir, link);
      expect(await readerOf(link).read()).toEqual({ state: "not-safe" });
    },
  );

  test.skipIf(process.platform === "win32")("a named pipe at its name is not opened", async () => {
    const dir = await tempDir();
    execFileSync("mkfifo", [path.join(dir, PROJECT_LIST_FILE)]);
    expect(await readerOf(dir).read()).toEqual({ state: "not-safe" });
  });

  test("a folder at its name is not read", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, PROJECT_LIST_FILE));
    expect(await readerOf(dir).read()).toEqual({ state: "not-safe" });
  });

  test("over 1 MiB is not read", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, PROJECT_LIST_FILE), "x".repeat(MAX_LIST_BYTES + 1));
    expect(await readerOf(dir).read()).toEqual({ state: "too-large" });
  });
});
