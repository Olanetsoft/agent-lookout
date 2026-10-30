import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { createKeepAwake } from "@desktop/keep-awake/keepAwake";
import {
  keepAwakeSettingsFile,
  KEEP_AWAKE_SETTINGS_FILE,
} from "@desktop/keep-awake/keepAwakeSettings";
import { tempDir } from "@tests/support/node/tempFiles";

const blocker = { start: () => 1, stop: () => {} };

test("with no file yet, the switch is off", async () => {
  const dir = await tempDir();
  expect(keepAwakeSettingsFile(dir).read()).toEqual({ on: false });
});

test("the switch is kept in keep-awake-state.json in the app's folder, readable by this user only", async () => {
  const dir = await tempDir();
  const store = keepAwakeSettingsFile(dir);
  store.write({ on: true });

  expect(store.read()).toEqual({ on: true });
  expect(keepAwakeSettingsFile(dir).read()).toEqual({ on: true });
  const file = path.join(dir, KEEP_AWAKE_SETTINGS_FILE);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ on: true });
  // Windows has no POSIX file modes.
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Written whole and moved into place, with nothing left beside it.
  expect(await readdir(dir)).toEqual([KEEP_AWAKE_SETTINGS_FILE]);

  store.write({ on: false });
  expect(keepAwakeSettingsFile(dir).read()).toEqual({ on: false });
});

test("a switch turned on is still on at the next launch", async () => {
  const dir = await tempDir();
  const first = createKeepAwake({ blocker, settings: keepAwakeSettingsFile(dir) });
  expect(first.status()).toEqual({ on: false });
  first.setOn(true);
  first.stop();

  const next = createKeepAwake({ blocker, settings: keepAwakeSettingsFile(dir) });
  expect(next.status()).toEqual({ on: true });
});

test("makes the folder when it is not there yet", async () => {
  const dir = path.join(await tempDir(), "Agent Lookout");
  keepAwakeSettingsFile(dir).write({ on: true });
  expect(keepAwakeSettingsFile(dir).read()).toEqual({ on: true });
});

test("a damaged file reads as off", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, KEEP_AWAKE_SETTINGS_FILE), '{"on": tru');
  expect(keepAwakeSettingsFile(dir).read()).toEqual({ on: false });
});

test("a file that cannot be written is not remembered, and nothing throws", async () => {
  const dir = await tempDir();
  // A file where the folder should be.
  const blocked = path.join(dir, "not-a-folder");
  await writeFile(blocked, "");
  const store = keepAwakeSettingsFile(blocked);
  expect(() => store.write({ on: true })).not.toThrow();
  expect(store.read()).toEqual({ on: false });
});
