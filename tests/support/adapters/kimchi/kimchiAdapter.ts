// The Kimchi adapter, cut off from this machine, for the tests that share it:
// the same file system held in memory that the Pi tests use, the same
// stand-in for what `ps` says, and an adapter built from them with a clock
// the test moves by hand. Nothing here touches a real file or runs a program.

import { createKimchiAdapter, type KimchiAdapterOptions } from "@collector/adapters/kimchi/index";
import { HOME, NOW } from "@tests/fixtures/kimchi/kimchi";
import {
  handClock,
  memoryFiles,
  standInProcesses,
  type MemoryFiles,
} from "@tests/support/adapters/pi/piAdapter";

export { handClock, memoryFiles, standInProcesses, type MemoryFiles };

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with a
 * `kimchi` program running unless the test says otherwise. With nothing in
 * `env` it looks in `~/.config/kimchi/harness/sessions`.
 */
export function kimchiAdapterFor(files: MemoryFiles, options: KimchiAdapterOptions = {}) {
  return createKimchiAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    processes: standInProcesses(),
    ...options,
  });
}
