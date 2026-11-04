// The Pi adapter, cut off from this machine, for the tests that share it: the
// same file system held in memory that the Codex tests use, a stand-in for what
// `ps` says of Pi, and an adapter built from them with a clock the test moves by
// hand. Nothing here touches a real file or runs a program.

import { createPiAdapter, type PiAdapterOptions } from "@collector/adapters/pi/index";
import type { ProcessAnswer } from "@collector/adapters/opencode/processes";
import { HOME, NOW } from "@tests/fixtures/pi/pi";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A stand-in for what `ps` says of Pi, which counts how often it is asked. */
export function standInProcesses(initial: ProcessAnswer = { ok: true, running: true }) {
  let answer = initial;
  const asked = { count: 0 };
  return {
    asked,
    set(next: ProcessAnswer) {
      answer = next;
    },
    async read() {
      asked.count += 1;
      return answer;
    },
  };
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with a `pi`
 * program running unless the test says otherwise. With nothing in `env` it looks
 * in `~/.pi/agent/sessions`.
 */
export function piAdapterFor(files: MemoryFiles, options: PiAdapterOptions = {}) {
  return createPiAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    processes: standInProcesses(),
    ...options,
  });
}
