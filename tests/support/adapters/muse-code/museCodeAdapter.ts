// The Muse Code adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, the same
// stand-in for `ps` the DeepSeek Harness tests use, which prints the table a
// test gives it, the computer's start a test sets, and an adapter built from
// them with a clock the test moves by hand. Nothing here touches a real file
// or runs a program.

import { createDshProcessReader } from "@collector/adapters/deepseek-harness/processes";
import {
  createMuseCodeAdapter,
  MUSE_NAMES,
  type MuseCodeAdapterOptions,
} from "@collector/adapters/muse-code/index";
import { HOME, NOW, SESSIONS } from "@tests/fixtures/muse-code/museCode";
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

/** A `muse` that started an hour before the fixture's `NOW`, as `ps` lists one. */
export const MUSE_LINE = psLine(7001, NOW - 60 * 60 * 1000, "/Users/example/.local/bin/muse");

/** Each folder's next modified time: within the hour before `NOW`, and never the same twice. */
let folderTime = NOW - 60 * 60 * 1000;

/**
 * Writes a session's log in place of any other, and moves the times of its
 * folder and of every folder above it up to the sessions folder, as making a
 * folder in each does on a disk. A session added to a day folder already
 * there moves that folder's time alone, so a test of that uses `files.write`
 * and `files.touch` on the day folder.
 */
export function writeLog(
  files: MemoryFiles,
  file: string,
  content: string | Uint8Array,
  mtimeMs?: number,
  sessionsDir: string = SESSIONS,
): void {
  files.write(file, content, { mtimeMs });
  let dir = file.slice(0, file.lastIndexOf("/"));
  while (dir.startsWith(sessionsDir)) {
    files.touch(dir, folderTime++);
    if (dir === sessionsDir) break;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
}

/** Adds to a session's log, as Muse Code appends a record. Its folders' times stay. */
export function appendLog(
  files: MemoryFiles,
  file: string,
  content: string,
  mtimeMs?: number,
): void {
  files.append(file, content, { mtimeMs });
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with `ps`
 * listing the `muse` of `MUSE_LINE` unless the test says otherwise, and the
 * computer started a day ago. With nothing in `env` it looks in
 * `~/.local/share/muse/sessions`.
 */
export function museCodeAdapterFor(
  files: MemoryFiles,
  options: MuseCodeAdapterOptions & { ps?: StandInPs } = {},
) {
  const platform = options.platform ?? "darwin";
  const ps = options.ps ?? standInPs([MUSE_LINE]);
  const now = options.now ?? (() => NOW);
  return createMuseCodeAdapter({
    env: {},
    homeDir: HOME,
    io: files.io,
    platform,
    processes: createDshProcessReader({
      platform,
      run: ps.run,
      ownPid: OWN_PID,
      names: MUSE_NAMES,
    }),
    uptimeMs: () => now() - BOOT_AT,
    monotonic: () => now() - BOOT_AT,
    ...options,
    now,
  });
}

/** The sessions folder, made so it is there even before a log is written in it. */
export function withSessionsFolder(files: MemoryFiles): MemoryFiles {
  files.mkdir(SESSIONS);
  return files;
}
