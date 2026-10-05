import { execFileSync } from "node:child_process";
import { readdir, readFile, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  readRegistry,
  readRegularFile,
  type RegistryIo,
} from "@collector/adapters/claude-code/registry";
import { pids, registryFile, registryFiles } from "@tests/fixtures/claudeCode";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

/** Real file access that records every path it is asked to open. */
function recordingIo() {
  const listed: string[] = [];
  const opened: string[] = [];
  const io: RegistryIo = {
    readdir: (dir) => {
      listed.push(dir);
      return readdir(dir);
    },
    readFile: (file) => {
      opened.push(file);
      return readFile(file, "utf8");
    },
  };
  return { io, listed, opened };
}

describe("readRegistry", () => {
  test("reads every entry, by pid", async () => {
    const home = await makeClaudeHome(registryFiles);
    const registry = await readRegistry(path.join(home, "sessions"));
    expect(registry.readable).toBe(true);
    if (!registry.readable) return;
    expect([...registry.entries.keys()].sort()).toEqual(Object.values(pids).sort());
    expect(registry.entries.get(pids.permission)).toMatchObject({
      entrypoint: "claude-desktop",
      statusUpdatedAt: 1_700_000_040_000,
    });
  });

  test("the .key files beside the entries are never opened", async () => {
    const home = await makeClaudeHome({
      ...registryFiles,
      [`${pids.busy}.0f3a9c1d5e7b.key`]: "not-for-reading",
      [`${pids.idle}.9a8b7c6d5e4f.key`]: "not-for-reading",
      // A key for a process that has no entry at all.
      "5150.1a2b3c4d5e6f.key": "not-for-reading",
      // Names built to look like both.
      [`${pids.busy}.json.key`]: "not-for-reading",
      "notes.txt": "not a registry file",
    });
    const sessions = path.join(home, "sessions");
    const { io, listed, opened } = recordingIo();

    const registry = await readRegistry(sessions, io);

    expect(listed).toEqual([sessions]);
    expect(opened.sort()).toEqual(
      Object.keys(registryFiles)
        .map((name) => path.join(sessions, name))
        .sort(),
    );
    expect(opened.every((file) => file.endsWith(".json"))).toBe(true);
    expect(opened.some((file) => file.includes(".key"))).toBe(false);
    expect(registry.readable && registry.entries.size).toBe(4);
  });

  test("malformed files are skipped and the rest are still read", async () => {
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile(),
      // Claude Code has shipped a registry file with a stray closing brace.
      [`${pids.permission}.json`]: `${registryFile({ pid: pids.permission })}}`,
      [`${pids.question}.json`]: "",
      [`${pids.idle}.json`]: '{"pid": ',
      "5150.json": "[1, 2, 3]",
      "5151.json": '{"sessionId": "no pid here"}',
    });
    const registry = await readRegistry(path.join(home, "sessions"));
    expect(registry.readable).toBe(true);
    if (!registry.readable) return;
    expect([...registry.entries.keys()]).toEqual([pids.busy]);
  });

  test("an entry that cannot be opened is skipped", async () => {
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile() });
    const sessions = path.join(home, "sessions");
    // A directory with a registry file's name: opening it fails.
    await mkdir(path.join(sessions, "5150.json"));

    const registry = await readRegistry(sessions);
    expect(registry.readable).toBe(true);
    if (!registry.readable) return;
    expect([...registry.entries.keys()]).toEqual([pids.busy]);
  });

  test("the file named after a pid wins over another file claiming that pid", async () => {
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile({ entrypoint: "claude-vscode" }),
      "aaa-copy.json": registryFile({ entrypoint: "claude-desktop" }),
      "zzz-copy.json": registryFile({ entrypoint: "cli" }),
    });
    const registry = await readRegistry(path.join(home, "sessions"));
    expect(registry.readable && registry.entries.get(pids.busy)?.entrypoint).toBe("claude-vscode");
  });

  test("an empty directory is readable and has no entries", async () => {
    const home = await makeClaudeHome();
    const registry = await readRegistry(path.join(home, "sessions"));
    expect(registry).toEqual({ readable: true, entries: new Map() });
  });

  test("a directory that is not there is reported as missing", async () => {
    const home = await tempDir();
    expect(await readRegistry(path.join(home, "sessions"))).toEqual({
      readable: false,
      missing: true,
    });
  });

  test("a registry path that is a file, not a directory, is reported as missing", async () => {
    const home = await tempDir();
    await writeFile(path.join(home, "sessions"), "not a directory");
    expect(await readRegistry(path.join(home, "sessions"))).toEqual({
      readable: false,
      missing: true,
    });
  });
});

/** A JSON object that would be a perfectly good registry entry if it were read. */
const readable = (pid: number, name: string) =>
  JSON.stringify({ pid, sessionId: `session-${pid}`, name, status: "idle" });

describe.skipIf(process.platform === "win32")("what the registry reader will open", () => {
  test("a .json name that is a link to a .key file is not followed", async () => {
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile(),
      // Written as an entry, so that reading it would show up in the result.
      "7.aaaa.key": readable(7, "key-file-content"),
      "4242.abcdef.key": "not-for-reading",
    });
    const sessions = path.join(home, "sessions");
    await symlink("7.aaaa.key", path.join(sessions, "7.json"));
    await symlink(path.join(sessions, "4242.abcdef.key"), path.join(sessions, "link-to-key.json"));

    const registry = await readRegistry(sessions);
    expect(registry.readable).toBe(true);
    if (!registry.readable) return;
    expect([...registry.entries.keys()]).toEqual([pids.busy]);
    expect(JSON.stringify([...registry.entries.values()])).not.toContain("key-file-content");
  });

  test("a .json name that is a link out of the directory is not followed", async () => {
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile() });
    const sessions = path.join(home, "sessions");
    await writeFile(path.join(home, "outside.txt"), readable(8, "outside-content"));
    await symlink("../outside.txt", path.join(sessions, "escape.json"));

    const registry = await readRegistry(sessions);
    expect(registry.readable && [...registry.entries.keys()]).toEqual([pids.busy]);
  });

  test("a link to another entry in the same directory is not followed either", async () => {
    const home = await makeClaudeHome({ "9.json": readable(9, "demo-project") });
    const sessions = path.join(home, "sessions");
    await symlink("9.json", path.join(sessions, "copy.json"));
    await expect(readRegularFile(path.join(sessions, "copy.json"))).rejects.toThrow();
    expect(await readRegularFile(path.join(sessions, "9.json"))).toBe(readable(9, "demo-project"));
  });

  test("a named pipe called like an entry is skipped at once and the rest are read", async () => {
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile() });
    const sessions = path.join(home, "sessions");
    // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
    execFileSync("mkfifo", [path.join(sessions, "1.json")]);

    const started = Date.now();
    const registry = await readRegistry(sessions);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(registry.readable && [...registry.entries.keys()]).toEqual([pids.busy]);
  }, 5_000);

  test("a file far larger than any registry entry is refused before it is read", async () => {
    const home = await makeClaudeHome({
      [`${pids.busy}.json`]: registryFile(),
      "5150.json": registryFile({ pid: 5150, padding: "x".repeat(300_000) }),
    });
    const sessions = path.join(home, "sessions");
    await expect(readRegularFile(path.join(sessions, "5150.json"))).rejects.toThrow(/too large/i);
    const registry = await readRegistry(sessions);
    expect(registry.readable && [...registry.entries.keys()]).toEqual([pids.busy]);
  });

  test("a directory called like an entry is refused", async () => {
    const home = await makeClaudeHome();
    const sessions = path.join(home, "sessions");
    await mkdir(path.join(sessions, "5150.json"));
    await expect(readRegularFile(path.join(sessions, "5150.json"))).rejects.toThrow();
  });

  test("an ordinary file is read whole", async () => {
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile() });
    expect(await readRegularFile(path.join(home, "sessions", `${pids.busy}.json`))).toBe(
      registryFile(),
    );
    await writeFile(path.join(home, "sessions", "empty.json"), "");
    expect(await readRegularFile(path.join(home, "sessions", "empty.json"))).toBe("");
  });

  test("the registry directory itself may be reached through a link", async () => {
    // People keep ~/.claude in a dotfiles folder and link to it. Only the entries
    // inside must be ordinary files.
    const home = await makeClaudeHome({ [`${pids.busy}.json`]: registryFile() });
    const elsewhere = await tempDir();
    await symlink(path.join(home, "sessions"), path.join(elsewhere, "sessions"));
    const registry = await readRegistry(path.join(elsewhere, "sessions"));
    expect(registry.readable && [...registry.entries.keys()]).toEqual([pids.busy]);
  });
});
