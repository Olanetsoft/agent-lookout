// The Antigravity CLI adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, a
// stand-in for `ps` that says which agy programs run and counts each time it is
// asked, and an adapter built from both with a clock the test moves by hand.
// Nothing here touches a real file or runs a program.

import {
  createAntigravityAdapter,
  type AntigravityAdapterOptions,
} from "@collector/adapters/antigravity/index";
import type {
  AgyProcessList,
  AgyProcessReader,
} from "@collector/adapters/antigravity/agyProcesses";
import type { AgySessionProcess } from "@core/mapping/antigravityLiveness";
import { HOME, NOW } from "@tests/fixtures/antigravity";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A stand-in for `ps`: the agy programs it says run, which the test changes, and how often it was asked. */
export function standInProcesses(initial: AgySessionProcess[] = []) {
  let answer: AgyProcessList = { ok: true, sessions: initial };
  let asked = 0;
  const reader: AgyProcessReader = {
    async read() {
      asked += 1;
      return answer.ok ? { ok: true, sessions: [...answer.sessions] } : { ok: false };
    },
  };
  return {
    reader,
    /** The agy programs that run from now on. */
    set(sessions: AgySessionProcess[]) {
      answer = { ok: true, sessions };
    },
    /** `ps` fails from now on. */
    fail() {
      answer = { ok: false };
    },
    asked: () => asked,
  };
}

/** An adapter that reads only the stand-in files and asks only the stand-in `ps`. With nothing in `env`, it looks in `~/.gemini/antigravity-cli`. */
export function antigravityAdapterFor(
  files: MemoryFiles,
  processes: ReturnType<typeof standInProcesses>,
  options: AntigravityAdapterOptions = {},
) {
  return createAntigravityAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    platform: "darwin",
    io: files.io,
    processes: processes.reader,
    ...options,
  });
}
