// The Qwen Code adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, a
// stand-in for signal 0 that says which processes run, which the test
// changes, and writes down every pid it was asked about, a stand-in for the
// `ps` that says when each process started, and an adapter built from them
// with a clock the test moves by hand. Nothing here touches a real file or a
// real process.

import {
  createQwenCodeAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type QwenCodeAdapterOptions,
} from "@collector/adapters/qwen-code/index";
import type { ReadProcessStarts } from "@collector/processes/processStart";
import { lstart } from "@tests/fixtures/antigravity";
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
 * A stand-in for `ps -o pid=,lstart= -p <pids>`: when each process started,
 * which the test changes, printed as `ps` prints it in UTC, and the pids of
 * each run. A process it has no time for is left out, as one `ps` did not list.
 */
export function standInStarts(started: Record<number, number> = {}) {
  const starts = new Map(Object.entries(started).map(([pid, at]) => [Number(pid), at]));
  const runs: number[][] = [];
  const stand = {
    starts,
    runs,
    fails: false,
    read: (async (pids) => {
      runs.push([...pids]);
      if (stand.fails) throw new Error("ps could not be run");
      const printed = new Map<number, string>();
      for (const pid of pids) {
        const at = starts.get(pid);
        if (at !== undefined) printed.set(pid, lstart(at));
      }
      return printed;
    }) satisfies ReadProcessStarts,
  };
  return stand;
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules for folder
 * names, with every process running unless the test says otherwise, and a
 * `ps` that knows no start time. With nothing in `env` it looks in `~/.qwen`,
 * which is `QWEN_DIR` from the fixtures.
 */
export function qwenCodeAdapterFor(files: MemoryFiles, options: QwenCodeAdapterOptions = {}) {
  return createQwenCodeAdapter({
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
