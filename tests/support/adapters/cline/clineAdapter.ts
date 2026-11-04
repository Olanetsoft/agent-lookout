// The Cline adapter, cut off from this machine, for the tests that share it:
// the same file system held in memory that the Codex tests use, the stand-ins
// for signal 0 and for `ps` the Qwen Code tests use, and an adapter built from
// them with a clock the test moves by hand. Nothing here touches a real file or
// a real process.

import {
  createClineAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type ClineAdapterOptions,
} from "@collector/adapters/cline/index";
import { HOME, NOW } from "@tests/fixtures/cline/cline";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";
import { standInProcesses, standInStarts } from "@tests/support/adapters/qwenCodeAdapter";

export { handClock, memoryFiles, standInProcesses, standInStarts, type MemoryFiles };

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with every
 * process running unless the test says otherwise and a `ps` that knows no start
 * time. With nothing in `env` it looks in `~/.cline/data/sessions`.
 */
export function clineAdapterFor(files: MemoryFiles, options: ClineAdapterOptions = {}) {
  return createClineAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: () => true,
    platform: "darwin",
    readProcessStarts: async () => new Map(),
    ...options,
  });
}

/** What a healthy poll says, for a folder written as people see it. */
export const healthy = (sessions = "~/.cline/data/sessions") =>
  `Sessions are read from the manifest Cline keeps for each one in ${sessions}. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
