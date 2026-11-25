// What the main process hands its modules can only be run in Electron, so what
// matters most of it is read in its source.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const desktop = fileURLToPath(new URL("../../../src/desktop/", import.meta.url));

test("no message is shown that would hold the main process, and the collector in it, until it is closed", async () => {
  const names = await readdir(desktop, { recursive: true });
  const files = names.filter((name) => name.endsWith(".ts"));
  expect(files).toContain("main.ts");
  for (const name of files) {
    const text = await readFile(path.join(desktop, name), "utf8");
    expect(text, name).not.toMatch(/showMessageBox|showOpenDialog|showSaveDialog/);
    // A start that failed is the one that may: the app ends once it is closed.
    expect(text.split("showErrorBox").length - 1, name).toBe(name === "main.ts" ? 1 : 0);
  }
});

test("Check for Updates… shows the card that answers it, and checks, with the window open or closed", async () => {
  const main = await readFile(path.join(desktop, "main.ts"), "utf8");
  const body = /function checkForUpdates\(\): void \{\n([\s\S]*?)\n\}/.exec(main)?.[1];
  expect(body?.split("\n").map((line) => line.trim())).toEqual([
    "if (updater === null) return;",
    "showWindow(UPDATES_URL);",
    "void updater.check();",
  ]);
});

test("what removes an update is Electron's own original-fs, which removes an .asar", async () => {
  const main = await readFile(path.join(desktop, "main.ts"), "utf8");
  expect(main).toContain('import { promises as originalFiles, rmSync } from "original-fs";');
  expect(main).toContain("removal: { rm: originalFiles.rm, rmSync },");
});

test("an update waits in the app's folder of user data, and only what 0.2.31 and earlier left is looked for in the temporary folder", async () => {
  const main = await readFile(path.join(desktop, "main.ts"), "utf8");
  expect(main).toContain('dataDir: app.getPath("userData"),');
  expect(main).toContain('tempDir: app.getPath("temp"),');
});
