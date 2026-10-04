// Real files for integration tests: temporary directories, stand-ins for the
// Claude Code and Codex folders and stub programs. Everything is removed when
// the test that asked for it finishes.

import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

/**
 * The fixture folder laid out as Codex lays out its own: `tests/fixtures/codex-home`.
 * Tests may point the adapter at it to read, and never write in it. A test that
 * changes files works on a copy from `makeCodexHome`.
 */
export const CODEX_FIXTURE_HOME = fileURLToPath(new URL("../fixtures/codex-home", import.meta.url));

/** A fresh directory that is removed when the current test finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-lookout-test-"));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A stand-in for `~/.claude` with a `sessions` directory holding the given
 * files. Returns the home directory.
 */
export async function makeClaudeHome(files: Record<string, string> = {}): Promise<string> {
  const home = await tempDir();
  const sessions = path.join(home, "sessions");
  await mkdir(sessions);
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(path.join(sessions, name), content)),
  );
  return home;
}

/**
 * A stand-in for a person's home directory, with `.claude/sessions` inside it
 * holding the given files. Returns the home directory. Use it to reach the
 * adapter's default location without naming one in the environment.
 */
export async function makeUserHome(files: Record<string, string> = {}): Promise<string> {
  const home = await tempDir();
  const sessions = path.join(home, ".claude", "sessions");
  await mkdir(sessions, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) => writeFile(path.join(sessions, name), content)),
  );
  return home;
}

/**
 * A stand-in for `~/.codex` that a test may change: a copy of the fixture folder
 * when `copyFixture` is set, otherwise an empty folder, with the given files
 * written in it by path relative to the folder. Returns the folder.
 */
export async function makeCodexHome(
  files: Record<string, string | Uint8Array> = {},
  options: { copyFixture?: boolean } = {},
): Promise<string> {
  const home = await tempDir();
  if (options.copyFixture) await cp(CODEX_FIXTURE_HOME, home, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(home, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return home;
}

/** Writes an executable shell script and returns its path. */
export async function writeStub(script: string): Promise<string> {
  const dir = await tempDir();
  const file = path.join(dir, "claude");
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return file;
}
