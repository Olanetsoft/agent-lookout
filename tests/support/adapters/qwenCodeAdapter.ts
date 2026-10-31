// The Qwen Code adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, a
// stand-in for signal 0 that says which processes run, which the test
// changes, and writes down every pid it was asked about, and an adapter built
// from them with a clock the test moves by hand. Nothing here touches a real
// file or a real process.

import {
  createQwenCodeAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type QwenCodeAdapterOptions,
} from "@collector/adapters/qwen-code/index";
import { HOME, NOW } from "@tests/fixtures/qwen-code/qwenCode";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A stand-in for signal 0: the pids that run, which the test changes, and each pid it was asked about. */
export function standInProcesses(running: Iterable<number> = []) {
  const alive = new Set(running);
  const asked: number[] = [];
  return {
    isAlive(pid: number) {
      asked.push(pid);
      return alive.has(pid);
    },
    start(pid: number) {
      alive.add(pid);
    },
    stop(pid: number) {
      alive.delete(pid);
    },
    asked,
  };
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules for folder
 * names, with every process running unless the test says otherwise. With
 * nothing in `env` it looks in `~/.qwen`, which is `QWEN_DIR` from the fixtures.
 */
export function qwenCodeAdapterFor(files: MemoryFiles, options: QwenCodeAdapterOptions = {}) {
  return createQwenCodeAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: () => true,
    platform: "darwin",
    ...options,
  });
}

/** What a healthy poll says first, for folders written as people see them. */
export const healthy = (sessions = "~/.qwen/sessions", projects = "~/.qwen/projects") =>
  `Sessions are read from the list of running sessions Qwen Code keeps in ${sessions}, and each one's chat file in ${projects}. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;

/** What Sources says of the last-message read while it is on. */
export const LAST_MESSAGE_READ = "end of a session's chat file, while its details are open";

/** The four facts, in the order the adapter gives them. */
export function watching(
  read: string,
  sessions = "~/.qwen/sessions",
  projects = "~/.qwen/projects",
  lastMessage = LAST_MESSAGE_READ,
) {
  return [
    { label: "Sessions folder", value: sessions },
    { label: "Chats folder", value: projects },
    { label: "Read", value: read },
    { label: "Last message read", value: lastMessage },
  ];
}
