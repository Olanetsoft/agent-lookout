// The Gemini CLI adapter, cut off from this machine, for the tests that share
// it. It reads the file system held in memory that the Codex tests use, with a
// clock the test moves by hand, and a way to move a folder's modified time,
// which that file system keeps at 0. Nothing here touches a real file.

import {
  createGeminiCliAdapter,
  FILES_ONLY_NOTE,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type GeminiCliAdapterOptions,
} from "@collector/adapters/gemini-cli/index";
import type { FileInfo, ReadOnlyIo } from "@collector/files/readOnlyIo";
import { HOME, NOW } from "@tests/fixtures/gemini-cli/geminiCli";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";
import { asWritten } from "@tests/support/paths";

export { handClock, memoryFiles, type MemoryFiles };

/**
 * The io, with the modified time of each folder `touch` named given as the
 * test set it, as a disk moves a folder's time when a file is added to it.
 */
export function folderTimes(io: ReadOnlyIo) {
  const times = new Map<string, number>();
  const timed = (target: string, info: FileInfo): FileInfo => {
    const mtimeMs = times.get(asWritten(target));
    return info.kind === "directory" && mtimeMs !== undefined ? { ...info, mtimeMs } : info;
  };
  return {
    io: {
      ...io,
      stat: async (target: string) => timed(target, await io.stat(target)),
      lstat: async (target: string) => timed(target, await io.lstat(target)),
    } satisfies ReadOnlyIo,
    touch(dir: string, mtimeMs: number) {
      times.set(asWritten(dir), mtimeMs);
    },
  };
}

/**
 * An adapter that reads only the stand-in files, on a Mac unless the test
 * names another system. With nothing in `env` it looks in `~/.gemini`, which
 * is `GEMINI_DIR` from the fixtures, and in `~/.cache/.gemini`, which is
 * `SEATBELT_DIR`.
 */
export function geminiCliAdapterFor(files: MemoryFiles, options: GeminiCliAdapterOptions = {}) {
  return createGeminiCliAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    ...options,
  });
}

/** Both folders of sessions on a Mac, as people see them. */
export const BOTH_FOLDERS = "~/.gemini/tmp, and in ~/.cache/.gemini/tmp under macOS Seatbelt";

/** What a healthy poll says, for the folders of sessions read, written as people see them. */
export const healthy = (tmp = BOTH_FOLDERS) =>
  `Sessions are read from the files Gemini CLI saves in ${tmp}. ${NEEDS_YOU_NOTE} ${FILES_ONLY_NOTE} ${UNCHECKED_NOTE}`;

/** What Sources says of the last-message read while it is on. */
export const LAST_MESSAGE_READ = "end of a session's file, while its details are open";
