import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { nodeIo, openRegularFile } from "@collector/files/readOnlyIo";
import { tempDir } from "@tests/support/node/tempFiles";

const text = (data: Uint8Array) => Buffer.from(data).toString("utf8");

describe("openRegularFile", () => {
  test("reads an ordinary file in ranges, and less at its end", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    await writeFile(file, "0123456789");

    const open = await openRegularFile(file);
    try {
      expect(open.info).toMatchObject({ kind: "file", size: 10 });
      expect(open.info.ino).toBeGreaterThan(0);
      expect(text(await open.read(0, 4))).toBe("0123");
      expect(text(await open.read(6, 100))).toBe("6789");
      expect(text(await open.read(10, 5))).toBe("");
      expect(text(await open.read(3, 0))).toBe("");
    } finally {
      await open.close();
    }
  });

  test("reads a file larger than one read of the disk in a single call", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "rollout.jsonl");
    const content = "x".repeat(3 * 1024 * 1024);
    await writeFile(file, content);
    const open = await openRegularFile(file);
    try {
      expect((await open.read(0, content.length)).byteLength).toBe(content.length);
    } finally {
      await open.close();
    }
  });

  test("a file that is not there is refused with ENOENT", async () => {
    const dir = await tempDir();
    await expect(openRegularFile(path.join(dir, "missing.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("a folder is refused", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "folder.jsonl"));
    await expect(openRegularFile(path.join(dir, "folder.jsonl"))).rejects.toThrow();
  });
});

describe.skipIf(process.platform === "win32")("what openRegularFile will not open", () => {
  test("a link is not followed, even to an ordinary file beside it", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "real.jsonl"), "content");
    await symlink("real.jsonl", path.join(dir, "link.jsonl"));
    await expect(openRegularFile(path.join(dir, "link.jsonl"))).rejects.toThrow();
  });

  test("a named pipe is refused at once instead of waiting for a writer", async () => {
    const dir = await tempDir();
    const pipe = path.join(dir, "rollout.jsonl");
    // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
    execFileSync("mkfifo", [pipe]);
    const started = Date.now();
    await expect(openRegularFile(pipe)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);
});

describe("nodeIo", () => {
  test("can only read: it has no way to write, make, move, lock or delete anything", () => {
    expect(Object.keys(nodeIo).sort()).toEqual(["lstat", "openRegular", "readdir", "stat"]);
  });

  test.skipIf(process.platform === "win32")("stat follows a link and lstat does not", async () => {
    const dir = await tempDir();
    await mkdir(path.join(dir, "real"));
    await symlink("real", path.join(dir, "link"));
    expect((await nodeIo.stat(path.join(dir, "link"))).kind).toBe("directory");
    expect((await nodeIo.lstat(path.join(dir, "link"))).kind).toBe("other");
  });

  test("readdir gives names, and a missing folder gives ENOENT", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, "a.lock"), "");
    expect(await nodeIo.readdir(dir)).toEqual(["a.lock"]);
    await expect(nodeIo.readdir(path.join(dir, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
