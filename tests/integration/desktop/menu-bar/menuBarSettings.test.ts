import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { menuBarSettingsFile, MENU_BAR_SETTINGS_FILE } from "@desktop/menu-bar/menuBarSettings";
import { tempDir } from "@tests/support/node/tempFiles";

test("with no file yet, the item is shown", async () => {
  const dir = await tempDir();
  expect(menuBarSettingsFile(dir).read()).toEqual({ show: true });
});

test("the switch is kept in menu-bar-state.json in the app's folder, readable by this user only", async () => {
  const dir = await tempDir();
  const store = menuBarSettingsFile(dir);
  store.write({ show: false });

  expect(store.read()).toEqual({ show: false });
  expect(menuBarSettingsFile(dir).read()).toEqual({ show: false });
  const file = path.join(dir, MENU_BAR_SETTINGS_FILE);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ show: false });
  // Windows has no POSIX file modes.
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Written whole and moved into place, with nothing left beside it.
  expect(await readdir(dir)).toEqual([MENU_BAR_SETTINGS_FILE]);

  store.write({ show: true });
  expect(menuBarSettingsFile(dir).read()).toEqual({ show: true });
});

test("makes the folder when it is not there yet", async () => {
  const dir = path.join(await tempDir(), "Agent Lookout");
  menuBarSettingsFile(dir).write({ show: false });
  expect(menuBarSettingsFile(dir).read()).toEqual({ show: false });
});

test("a damaged file reads as the default", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, MENU_BAR_SETTINGS_FILE), '{"show": fal');
  expect(menuBarSettingsFile(dir).read()).toEqual({ show: true });
});

test("a file that cannot be written is not remembered, and nothing throws", async () => {
  const dir = await tempDir();
  // A file where the folder should be.
  const blocked = path.join(dir, "not-a-folder");
  await writeFile(blocked, "");
  const store = menuBarSettingsFile(blocked);
  expect(() => store.write({ show: false })).not.toThrow();
  expect(store.read()).toEqual({ show: true });
});
