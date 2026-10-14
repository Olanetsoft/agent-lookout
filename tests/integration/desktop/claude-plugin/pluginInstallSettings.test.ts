import { execFileSync } from "node:child_process";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import {
  pluginInstallFile,
  PLUGIN_INSTALL_FILE,
  writePluginInstallRecord,
  type PluginInstallRecord,
} from "@desktop/claude-plugin/pluginInstallSettings";
import { tempDir } from "@tests/support/node/tempFiles";

const RECORD: PluginInstallRecord = {
  triedAt: 1_767_600_000_000,
  outcome: "installed",
  step: null,
  told: false,
};

test("with no file yet, it has never tried", async () => {
  const dir = await tempDir();
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "none" });
});

test("the record is kept in plugin-install-state.json in the app's folder, readable by this user only", async () => {
  const dir = await tempDir();
  const store = pluginInstallFile(dir);
  expect(store.write(RECORD)).toBe(true);

  expect(pluginInstallFile(dir).read()).toEqual({ kind: "record", record: RECORD });
  const file = path.join(dir, PLUGIN_INSTALL_FILE);
  expect(await readFile(file, "utf8")).toBe(writePluginInstallRecord(RECORD));
  // Windows has no POSIX file modes.
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
  // Written whole and moved into place, with nothing left beside it.
  expect(await readdir(dir)).toEqual([PLUGIN_INSTALL_FILE]);

  const told = { ...RECORD, told: true };
  expect(store.write(told)).toBe(true);
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "record", record: told });
});

test("makes the folder when it is not there yet", async () => {
  const dir = path.join(await tempDir(), "Agent Lookout");
  expect(pluginInstallFile(dir).write(RECORD)).toBe(true);
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "record", record: RECORD });
});

test("a damaged file is never taken for no file at all", async () => {
  const dir = await tempDir();
  await writeFile(path.join(dir, PLUGIN_INSTALL_FILE), '{"triedAt": 17676');
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
  await writeFile(path.join(dir, PLUGIN_INSTALL_FILE), "");
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
});

test("a file larger than any record is not one, even when it holds a record", async () => {
  const dir = await tempDir();
  const padded = `${JSON.stringify({ ...RECORD, padding: "x".repeat(5_000) })}\n`;
  await writeFile(path.join(dir, PLUGIN_INSTALL_FILE), padded);
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
});

// Windows keeps no named pipes among files.
test.skipIf(process.platform === "win32")(
  "a named pipe in the file's place cannot be read, and is not waited on",
  async () => {
    const dir = await tempDir();
    // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
    execFileSync("mkfifo", [path.join(dir, PLUGIN_INSTALL_FILE)]);
    const started = Date.now();
    expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
    expect(Date.now() - started).toBeLessThan(2_000);
  },
  5_000,
);

test("a folder where the file should be cannot be read", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, PLUGIN_INSTALL_FILE));
  expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
});

// Windows has no POSIX file modes, and root reads a file whatever its mode says.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a file this user may not read cannot be read",
  async () => {
    const dir = await tempDir();
    const file = path.join(dir, PLUGIN_INSTALL_FILE);
    await writeFile(file, writePluginInstallRecord(RECORD));
    await chmod(file, 0o000);
    expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });
    await chmod(file, 0o600);
  },
);

// Making a link needs a privilege on Windows that a test run may not have.
test.skipIf(process.platform === "win32")(
  "a link in the file's place, even one to a record or to nothing, cannot be read",
  async () => {
    const dir = await tempDir();
    const elsewhere = path.join(dir, "elsewhere.json");
    await writeFile(elsewhere, writePluginInstallRecord(RECORD));
    const file = path.join(dir, PLUGIN_INSTALL_FILE);
    await symlink(elsewhere, file);
    expect(pluginInstallFile(dir).read()).toEqual({ kind: "unreadable" });

    const other = await tempDir();
    await symlink(path.join(other, "not-there.json"), path.join(other, PLUGIN_INSTALL_FILE));
    expect(pluginInstallFile(other).read()).toEqual({ kind: "unreadable" });
  },
);

test("a record that cannot be written says so, and nothing throws", async () => {
  const dir = await tempDir();
  // A file where the folder should be.
  const blocked = path.join(dir, "not-a-folder");
  await writeFile(blocked, "");
  const store = pluginInstallFile(blocked);
  expect(store.write(RECORD)).toBe(false);
  expect(store.read()).toEqual({ kind: "unreadable" });
});
