import { readdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { nodeHistoryFs } from "@collector/history/historyFiles";
import { tempDir } from "@tests/support/node/tempFiles";

test("a file whose text cannot be written is not left behind, and one that was there stays", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "writer.lock");
  // Text that cannot be written stands in for a disk with no room for it.
  const unwritable = 1 as unknown as string;
  await expect(nodeHistoryFs.create(file, unwritable)).rejects.toThrow();
  expect(() => nodeHistoryFs.createNow(file, unwritable)).toThrow();
  expect(await readdir(dir)).toEqual([]);

  await nodeHistoryFs.create(file, "kept");
  await expect(nodeHistoryFs.create(file, "other")).rejects.toThrow(/EEXIST/);
  expect(() => nodeHistoryFs.createNow(file, "other")).toThrow(/EEXIST/);
  await expect(nodeHistoryFs.append(file, unwritable)).rejects.toThrow();
  expect(() => nodeHistoryFs.appendNow(file, unwritable)).toThrow();
  expect(nodeHistoryFs.readRegularNow(file, 256)).toBe("kept");
});
