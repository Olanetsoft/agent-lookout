// Real files for integration tests: temporary directories, stand-ins for the
// Claude Code and Codex folders and stub programs. Everything is removed when
// the test that asked for it finishes.

import { chmod, copyFile, cp, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

/**
 * The fixture folder laid out as Codex lays out its own: `tests/fixtures/codex-home`.
 * Tests may point the adapter at it to read, and never write in it. A test that
 * changes files works on a copy from `makeCodexHome`.
 */
export const CODEX_FIXTURE_HOME = fileURLToPath(
  new URL("../../fixtures/codex-home", import.meta.url),
);

/**
 * A settings file that is not there, in a folder that is not there, for a
 * collector a test builds or an app it starts: the time rules are all off, and
 * nothing reads the settings of the person running the tests. Only a change of
 * a time rule would write it, and a test that makes one names a file of its
 * own, in a `tempDir`.
 */
export const NO_SETTINGS_FILE = path.join(
  os.tmpdir(),
  "agent-lookout-test-no-settings",
  "settings.json",
);

/** A fresh directory that is removed when the current test finishes. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-lookout-test-"));
  onTestFinished(async () => {
    // On Windows a file a process has only just let go of can be busy for a moment.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

/** A stand-in program for Windows, and what its environment must hold for it to act. */
export interface WindowsStub {
  file: string;
  env: NodeJS.ProcessEnv;
}

/**
 * A stand-in program for Windows, where a script cannot be one: this Node,
 * linked or copied under the name `claude.exe`, with a preload that `env`
 * names in `NODE_OPTIONS`. The preload runs `body` when the program running
 * is the stand-in, and does nothing in any other Node. `body` is JavaScript
 * that has `args`, the arguments the stand-in was given, and `write(text)`,
 * which prints to stdout. The program ends with 0 after it unless `body`
 * ends it first. An argument that starts with `-` must not come first, as
 * Node would take it for one of its own.
 */
export async function writeWindowsStub(body: string, name = "claude.exe"): Promise<WindowsStub> {
  const dir = await tempDir();
  const file = path.join(dir, name);
  await link(process.execPath, file).catch(() => copyFile(process.execPath, file));
  const preload = path.join(dir, "stand-in.cjs");
  await writeFile(
    preload,
    `const path = require("node:path");
if (path.basename(process.execPath).toLowerCase() === ${JSON.stringify(name.toLowerCase())}) {
  // Node has already taken the first argument for a script and made it a path.
  const args = process.argv.length > 1 ? [path.basename(process.argv[1]), ...process.argv.slice(2)] : [];
  const write = (text) => require("node:fs").writeSync(1, String(text));
  ${body}
  process.exit(0);
}
`,
  );
  // In quotes, with each backslash escaped, as NODE_OPTIONS reads a path.
  return { file, env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } };
}
