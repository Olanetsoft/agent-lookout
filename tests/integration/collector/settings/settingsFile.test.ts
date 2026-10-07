import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  MAX_SETTINGS_BYTES,
  readSettingsSetup,
  readSettingsText,
  SETTINGS_FILE_ENV,
  writeSettingsText,
  type SettingsSetup,
} from "@collector/settings/settingsFile";
import { tempDir } from "@tests/support/node/tempFiles";

/** A settings file in a folder of its own that is not there yet, inside a temporary one. */
async function setupIn(dir?: string): Promise<SettingsSetup> {
  const folder = path.join(dir ?? (await tempDir()), ".agent-lookout");
  const file = path.join(folder, "settings.json");
  return { file, shown: "~/.agent-lookout/settings.json" };
}

const modeOf = async (target: string) => (await stat(target)).mode & 0o777;

describe("where the settings are kept", () => {
  test("in ~/.agent-lookout/settings.json, unless AGENT_LOOKOUT_SETTINGS_FILE names another", () => {
    // The file as this system writes it, and shown in the short form.
    expect(readSettingsSetup({}, "/Users/example")).toEqual({
      file: path.resolve("/Users/example/.agent-lookout/settings.json"),
      shown: "~/.agent-lookout/settings.json",
    });
    expect(
      readSettingsSetup({ [SETTINGS_FILE_ENV]: " /Users/example/rules.json " }, "/Users/example"),
    ).toEqual({ file: path.resolve("/Users/example/rules.json"), shown: "~/rules.json" });
    expect(readSettingsSetup({ [SETTINGS_FILE_ENV]: "  " }, "/Users/example").shown).toBe(
      "~/.agent-lookout/settings.json",
    );
  });
});

describe("readSettingsText", () => {
  test("with no file, or no folder for it, nothing has been set", async () => {
    const setup = await setupIn();
    expect(readSettingsText(setup)).toEqual({ kind: "missing" });
    await mkdir(path.dirname(setup.file));
    expect(readSettingsText(setup)).toEqual({ kind: "missing" });
  });

  test("an ordinary file is read whole", async () => {
    const setup = await setupIn();
    await mkdir(path.dirname(setup.file));
    await writeFile(setup.file, '{"timeRules": {}}\n');
    expect(readSettingsText(setup)).toEqual({ kind: "read", text: '{"timeRules": {}}\n' });
  });

  test("a link at the file's name is not followed, and the rules are off", async () => {
    const dir = await tempDir();
    const setup = await setupIn(dir);
    await mkdir(path.dirname(setup.file));
    const elsewhere = path.join(dir, "elsewhere.json");
    await writeFile(elsewhere, '{"timeRules": {"longWait": {"on": true, "minutes": 1}}}');
    await symlink(elsewhere, setup.file);
    expect(readSettingsText(setup)).toEqual({
      kind: "refused",
      problem:
        "~/.agent-lookout/settings.json is a link, which Agent Lookout does not follow, so the time rules and the permission rules are off.",
    });
  });

  test("a link where its folder should be is not followed either", async () => {
    const dir = await tempDir();
    const setup = await setupIn(dir);
    const real = path.join(dir, "real");
    await mkdir(real);
    await writeFile(path.join(real, "settings.json"), "{}");
    await symlink(real, path.dirname(setup.file));
    expect(readSettingsText(setup)).toMatchObject({ kind: "refused" });
    expect(readSettingsText(setup)).toEqual({
      kind: "refused",
      problem:
        "The folder of ~/.agent-lookout/settings.json is a link or not a folder, which Agent Lookout does not follow, so the time rules and the permission rules are off.",
    });
  });

  test("a folder where the file should be is not read", async () => {
    const setup = await setupIn();
    await mkdir(setup.file, { recursive: true });
    expect(readSettingsText(setup)).toEqual({
      kind: "refused",
      problem:
        "~/.agent-lookout/settings.json is not an ordinary file, so the time rules and the permission rules are off.",
    });
  });

  test("a file larger than 64 KB is not read at all", async () => {
    const setup = await setupIn();
    await mkdir(path.dirname(setup.file));
    await writeFile(setup.file, " ".repeat(MAX_SETTINGS_BYTES + 1));
    expect(readSettingsText(setup)).toEqual({
      kind: "refused",
      problem:
        "~/.agent-lookout/settings.json is larger than 64 KB, so it was not read and the time rules and the permission rules are off.",
    });
  });
});

describe("writeSettingsText", () => {
  test("makes the folder with mode 700 and the file with mode 600, and leaves nothing else beside it", async () => {
    const setup = await setupIn();
    expect(writeSettingsText(setup, '{"timeRules": {}}\n')).toEqual({ ok: true });
    // Windows has no POSIX file modes.
    if (process.platform !== "win32") {
      expect(await modeOf(path.dirname(setup.file))).toBe(0o700);
      expect(await modeOf(setup.file)).toBe(0o600);
    }
    expect(await readFile(setup.file, "utf8")).toBe('{"timeRules": {}}\n');
    expect(await readdir(path.dirname(setup.file))).toEqual(["settings.json"]);
  });

  test("a file there already is replaced whole, with mode 600 whatever its mode was", async () => {
    const setup = await setupIn();
    await mkdir(path.dirname(setup.file), { mode: 0o700 });
    await writeFile(setup.file, "old and longer than what replaces it", { mode: 0o644 });
    expect(writeSettingsText(setup, "new")).toEqual({ ok: true });
    expect(await readFile(setup.file, "utf8")).toBe("new");
    // Windows has no POSIX file modes.
    if (process.platform !== "win32") expect(await modeOf(setup.file)).toBe(0o600);
  });

  test("nothing is written through a link at the file's name, and the file it points to is left alone", async () => {
    const dir = await tempDir();
    const setup = await setupIn(dir);
    await mkdir(path.dirname(setup.file));
    const elsewhere = path.join(dir, "elsewhere.json");
    await writeFile(elsewhere, "theirs");
    await symlink(elsewhere, setup.file);
    expect(writeSettingsText(setup, "ours")).toEqual({
      ok: false,
      problem:
        "~/.agent-lookout/settings.json is a link or not an ordinary file, which Agent Lookout does not write through, so the change was not saved.",
    });
    expect(await readFile(elsewhere, "utf8")).toBe("theirs");
    expect((await lstat(setup.file)).isSymbolicLink()).toBe(true);
  });

  test("nothing is written through a link where its folder should be", async () => {
    const dir = await tempDir();
    const setup = await setupIn(dir);
    const real = path.join(dir, "real");
    await mkdir(real);
    await symlink(real, path.dirname(setup.file));
    expect(writeSettingsText(setup, "ours").ok).toBe(false);
    expect(await readdir(real)).toEqual([]);
  });

  test("a folder that cannot be made is a change not saved, and says so", async () => {
    const dir = await tempDir();
    // A file where the folder above it would be.
    await writeFile(path.join(dir, "blocked"), "");
    const setup: SettingsSetup = {
      file: path.join(dir, "blocked", "settings.json"),
      shown: "~/blocked/settings.json",
    };
    expect(writeSettingsText(setup, "{}")).toEqual({
      ok: false,
      problem: "~/blocked/settings.json could not be written, so the change was not saved.",
    });
  });
});
