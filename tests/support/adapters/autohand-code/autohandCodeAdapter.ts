// The Autohand Code adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, with
// each thing in it owned by the user the tests say the adapter runs as,
// readable by that user alone and with one name, unless a test says
// otherwise; the stand-in for signal 0 the Qwen Code tests use; and an
// adapter built from them with a clock the test moves by hand. Nothing here
// touches a real file or a real process.

import {
  createAutohandCodeAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type AutohandCodeAdapterOptions,
} from "@collector/adapters/autohand-code/index";
import type { FileInfo, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  HEARTBEATS_DIR,
  HOME,
  NOW,
  heartbeatPath,
  metadataPath,
} from "@tests/fixtures/autohand-code/autohandCode";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";
import { standInProcesses } from "@tests/support/adapters/qwenCodeAdapter";
import { asWritten } from "@tests/support/paths";

export { standInProcesses, type MemoryFiles };

/** The user the adapter runs as in these tests. */
export const TEST_UID = 501;

/** Someone else. */
export const OTHER_UID = 502;

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/**
 * The stand-in's `io`, with each thing's owner, permission bits and number of
 * names: the test's user, `0600` for a file and `0700` for a folder, and one
 * name, unless `set` gives a path others. Paths are given as the tests write
 * them.
 */
export function ownedFiles(files: MemoryFiles) {
  const marks = new Map<string, Partial<FileInfo>>();
  const mark = (info: FileInfo, target: string): FileInfo => ({
    ...info,
    uid: TEST_UID,
    mode: info.kind === "directory" ? 0o40700 : 0o100600,
    nlink: 1,
    ...marks.get(asWritten(target)),
  });
  const io: ReadOnlyIo = {
    readdir: (dir) => files.io.readdir(dir),
    stat: async (target) => mark(await files.io.stat(target), target),
    lstat: async (target) => mark(await files.io.lstat(target), target),
    async openRegular(file) {
      const open = await files.io.openRegular(file);
      return { ...open, info: mark(open.info, file), read: open.read, close: open.close };
    },
  };
  return {
    io,
    /** Gives a path an owner, permission bits or number of names of its own. */
    set(target: string, info: Partial<FileInfo>) {
      marks.set(asWritten(target), { ...marks.get(asWritten(target)), ...info });
    },
    clear(target: string) {
      marks.delete(asWritten(target));
    },
  };
}

let folderTime = 1;

/**
 * Writes a heartbeat, as Autohand Code renames a new one into the folder,
 * which moves the folder's modified time as a disk does.
 */
export function writeHeartbeat(
  files: MemoryFiles,
  text: string | Uint8Array,
  options: { name?: string; mtimeMs?: number } = {},
) {
  const file = heartbeatPath(options.name);
  files.write(file, text, { mtimeMs: options.mtimeMs });
  files.touch(HEARTBEATS_DIR, folderTime++);
  return file;
}

/** Removes a heartbeat, as Autohand Code does, which moves the folder's time too. */
export function removeHeartbeat(files: MemoryFiles, name?: string) {
  files.remove(heartbeatPath(name));
  files.touch(HEARTBEATS_DIR, folderTime++);
}

/** Writes a session's `metadata.json`. */
export function writeMetadata(
  files: MemoryFiles,
  text: string | Uint8Array,
  options: { id?: string; mtimeMs?: number } = {},
) {
  const file = metadataPath(options.id);
  files.write(file, text, { mtimeMs: options.mtimeMs });
  return file;
}

/**
 * An adapter that reads only the stand-in files as the test's user, on a
 * Mac's rules, with every process running unless the test says otherwise.
 * With nothing in `env` it looks in `~/.autohand`.
 */
export function autohandAdapterFor(
  files: MemoryFiles,
  options: AutohandCodeAdapterOptions & { owned?: ReturnType<typeof ownedFiles> } = {},
) {
  const { owned, ...rest } = options;
  return createAutohandCodeAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: (owned ?? ownedFiles(files)).io,
    isAlive: () => true,
    platform: "darwin",
    euid: TEST_UID,
    ...rest,
  });
}

/** What a healthy poll says, for the folders written as people see them. */
export const healthy = (home = "~/.autohand") =>
  `Sessions are read from the heartbeats Autohand Code rewrites in ${home}/active-agents while each runs, and the metadata.json it keeps for each in ${home}/sessions. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
