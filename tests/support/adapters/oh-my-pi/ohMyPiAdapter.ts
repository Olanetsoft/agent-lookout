// The Oh My Pi adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, the same
// stand-in for `ps` the DeepSeek Harness tests use, which prints the table a
// test gives it, the computer's start a test sets, and an adapter built from
// them with a clock the test moves by hand. Nothing here touches a real file
// or runs a program.

import {
  createOhMyPiAdapter,
  ompNamesFor,
  type OhMyPiAdapterOptions,
} from "@collector/adapters/oh-my-pi/index";
import { createDshProcessReader } from "@collector/adapters/deepseek-harness/processes";
import { HOME, NOW, PROJECT_FOLDER, SESSIONS } from "@tests/fixtures/oh-my-pi/ohMyPi";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";
import {
  OWN_PID,
  psLine,
  standInPs,
  type StandInPs,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";

export { OWN_PID, psLine, standInPs, type MemoryFiles, type StandInPs };

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/** When the computer started: a day before the fixture's `NOW`, unless a test says otherwise. */
export const BOOT_AT = NOW - 24 * 60 * 60 * 1000;

/** An `omp` that started an hour before the fixture's `NOW`, as `ps` lists one. */
export const OMP_LINE = psLine(7001, NOW - 60 * 60 * 1000, "/Users/example/.local/bin/omp");

/** Each folder's next modified time: within the hour before `NOW`, and never the same twice. */
let folderTime = NOW - 60 * 60 * 1000;

/**
 * Writes a session's file in place of any other, and moves its project
 * folder's time, as adding a file does on a disk.
 */
export function writeSession(
  files: MemoryFiles,
  file: string,
  content: string | Uint8Array,
  mtimeMs?: number,
): void {
  files.write(file, content, { mtimeMs });
  files.touch(file.slice(0, file.lastIndexOf("/")), folderTime++);
  files.touch(SESSIONS, folderTime++);
}

/** Adds to a session's file, as Oh My Pi adds a line. Its folder's time stays. */
export function appendSession(
  files: MemoryFiles,
  file: string,
  content: string,
  mtimeMs?: number,
): void {
  files.append(file, content, { mtimeMs });
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with `ps`
 * listing the `omp` of `OMP_LINE` unless the test says otherwise, and the
 * computer started a day ago. With nothing in `env` it looks in
 * `~/.omp/agent/sessions`.
 */
export function ohMyPiAdapterFor(
  files: MemoryFiles,
  options: OhMyPiAdapterOptions & { ps?: StandInPs } = {},
) {
  const platform = options.platform ?? "darwin";
  const ps = options.ps ?? standInPs([OMP_LINE]);
  const now = options.now ?? (() => NOW);
  return createOhMyPiAdapter({
    env: {},
    homeDir: HOME,
    io: files.io,
    platform,
    processes: createDshProcessReader({
      platform,
      run: ps.run,
      ownPid: OWN_PID,
      names: ompNamesFor(platform),
    }),
    uptimeMs: () => now() - BOOT_AT,
    monotonic: () => now() - BOOT_AT,
    ...options,
    now,
  });
}

/** The project folder, made so it is there even before a file is written in it. */
export function withProjectFolder(files: MemoryFiles): MemoryFiles {
  files.mkdir(PROJECT_FOLDER);
  return files;
}
