// The Mistral Vibe adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, a
// stand-in for asking the system whether a lease's pid runs, which counts each
// time it is asked, and an adapter built from them with a clock the test
// moves by hand. Nothing here touches a real file or asks about a real process.

import {
  createMistralVibeAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type MistralVibeAdapterOptions,
} from "@collector/adapters/mistral-vibe/index";
import {
  HOME,
  LIVE_PID,
  NOW,
  SESSION_DIR,
  leaseFile,
  storeFiles,
  type StoreFields,
} from "@tests/fixtures/mistralVibe";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A stand-in for asking whether a pid runs: the pids it says run, which the test changes, and every pid it was asked about. */
export function standInPids(running: number[] = [LIVE_PID]) {
  let alive = new Set(running);
  const asked: number[] = [];
  return {
    isAlive(pid: number) {
      asked.push(pid);
      return alive.has(pid);
    },
    /** The pids that run from now on. */
    set(next: number[]) {
      alive = new Set(next);
    },
    asked,
  };
}

/** An adapter that reads only the stand-in files. With nothing in `env` it looks in `~/.vibe/logs/session`. */
export function vibeAdapterFor(
  files: MemoryFiles,
  pids = standInPids(),
  options: MistralVibeAdapterOptions = {},
) {
  return createMistralVibeAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: pids.isAlive,
    ...options,
  });
}

/** Writes every file of one session's store under a session folder. */
export function writeStore(files: MemoryFiles, fields: StoreFields, dir = SESSION_DIR) {
  for (const [relative, content] of Object.entries(storeFiles(fields))) {
    files.write(`${dir}/${relative}`, content);
  }
}

/** A held lease, as Vibe leaves one: `<id>.lock`, empty, and `<id>.lock.json` naming the pid. */
export function writeLease(
  files: MemoryFiles,
  id: string,
  pid: unknown = LIVE_PID,
  dir = SESSION_DIR,
) {
  files.write(`${dir}/active/${id}.lock`, "");
  files.write(`${dir}/active/${id}.lock.json`, leaseFile(id, pid));
}

/** Lets a lease go, as Vibe does: the lock first, then its `.json`. */
export function releaseLease(files: MemoryFiles, id: string, dir = SESSION_DIR) {
  files.remove(`${dir}/active/${id}.lock`);
  files.remove(`${dir}/active/${id}.lock.json`);
}

/** The three facts, in the order the adapter gives them, for a session folder written as people see it. */
export function watching(dir: string, read: string) {
  return [
    { label: "Sessions folder", value: `${dir}/unified` },
    { label: "Read", value: read },
    { label: "Open-sessions folder", value: `${dir}/active` },
  ];
}

/** What a healthy poll says, for a session folder written as people see it, with any notes after. */
export const healthy = (dir = "~/.vibe/logs/session", ...notes: string[]) =>
  [
    `Sessions are read from the files Mistral Vibe saves in ${dir}, since Vibe offers no list of its sessions for other programs.`,
    NEEDS_YOU_NOTE,
    UNCHECKED_NOTE,
    ...notes,
  ].join(" ");
