// The fx adapter, cut off from this machine, for the tests that share it: the
// same file system held in memory that the Codex tests use, a stand-in for
// what `ps` says of fx, and an adapter built from them with a clock the test
// moves by hand. Nothing here touches a real file or runs a program.

import { createFxAdapter, type FxAdapterOptions } from "@collector/adapters/fx/index";
import type { FxProcessAnswer } from "@collector/adapters/fx/processes";
import { HOME, logPath, NOW, V2 } from "@tests/fixtures/fx/fx";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** The process ID of the stand-in fx program that runs unless a test says otherwise. */
export const FX_PID = 4242;

/**
 * A stand-in for what `ps` says of fx: the IDs of the fx programs a test
 * gives it, or that it could not say. It counts how often it is asked.
 */
export function standInFxProcesses(
  initial: FxProcessAnswer = { ok: true, pids: [FX_PID], unparsed: 0 },
) {
  let answer = initial;
  const asked = { count: 0 };
  return {
    asked,
    set(next: FxProcessAnswer) {
      answer = next;
    },
    /** The fx programs that run, by ID, with nothing else to say. */
    running(...pids: number[]) {
      answer = { ok: true, pids, unparsed: 0 };
    },
    async read() {
      asked.count += 1;
      return answer;
    },
  };
}

let folderTime = 1;

/**
 * Writes a session's log, as fx renames a session's folder into `v2`, which
 * moves `v2`'s modified time as a disk does.
 */
export function writeSession(
  files: MemoryFiles,
  id: string,
  text: string,
  options: { mtimeMs?: number; dir?: string } = {},
) {
  files.write(logPath(id, options.dir), text, { mtimeMs: options.mtimeMs });
  files.touch(options.dir ?? V2, folderTime++);
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with an fx
 * program running unless the test says otherwise. With nothing in `env` it
 * looks in `~/.fx/sessions/v2`.
 */
export function fxAdapterFor(files: MemoryFiles, options: FxAdapterOptions = {}) {
  return createFxAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    processes: standInFxProcesses(),
    ...options,
  });
}
