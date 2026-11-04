// The Kimi Code adapter, cut off from this machine, for the tests that share it:
// the same file system held in memory that the Codex tests use, the stand-ins
// for signal 0 and for `ps` the Qwen Code tests use, and an adapter built from
// them with a clock the test moves by hand. Nothing here touches a real file or
// a real process.

import {
  createKimiCodeAdapter,
  NEEDS_YOU_NOTE,
  OPEN_NOTE,
  UNCHECKED_NOTE,
  type KimiCodeAdapterOptions,
} from "@collector/adapters/kimi-code/index";
import { DAY, HOME, NOW } from "@tests/fixtures/kimi-code/kimiCode";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";
import { standInProcesses, standInStarts } from "@tests/support/adapters/qwenCodeAdapter";

export { handClock, memoryFiles, standInProcesses, standInStarts, type MemoryFiles };

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with every
 * process running unless the test says otherwise, a `ps` that knows no start time
 * and a computer that has been on for 30 days. With nothing in `env` it looks in
 * `~/.kimi-code`.
 */
export function kimiCodeAdapterFor(files: MemoryFiles, options: KimiCodeAdapterOptions = {}) {
  return createKimiCodeAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: () => true,
    platform: "darwin",
    uptimeMs: () => 30 * DAY,
    readProcessStarts: async () => new Map(),
    ...options,
  });
}

/**
 * The three things that say a file changed, each moved with the other two left
 * as they were, for a file that holds `text` and was last written at `mtimeMs`.
 */
export const oneChangeEach = (text: string, mtimeMs: number) =>
  [
    ["size", (files: MemoryFiles, file: string) => files.append(file, "\n", { mtimeMs })],
    [
      "modified time",
      (files: MemoryFiles, file: string) => files.rewrite(file, text, { mtimeMs: mtimeMs + 1 }),
    ],
    ["identity", (files: MemoryFiles, file: string) => files.write(file, text, { mtimeMs })],
  ] as const;

/** What a healthy poll says, for a folder written as people see it. */
export const healthy = (folder = "~/.kimi-code") =>
  `Sessions are read from the files Kimi Code saves in ${folder}, since it offers no list of its sessions for other programs. ${NEEDS_YOU_NOTE} ${OPEN_NOTE} ${UNCHECKED_NOTE}`;
