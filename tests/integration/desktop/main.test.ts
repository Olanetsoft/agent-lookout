// What the main process hands its modules can only be run in Electron, so what
// matters most of it is read in its source.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const desktop = fileURLToPath(new URL("../../../src/desktop/", import.meta.url));

test("what removes an update is Electron's own original-fs, which removes an .asar", async () => {
  const main = await readFile(`${desktop}main.ts`, "utf8");
  expect(main).toContain('import { promises as originalFiles, rmSync } from "original-fs";');
  expect(main).toContain("removal: { rm: originalFiles.rm, rmSync },");
});
