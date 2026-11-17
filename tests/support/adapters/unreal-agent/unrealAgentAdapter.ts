// The Unreal Agent adapter, cut off from this machine, for the tests that
// share it: the same file system held in memory that the Codex tests use, a
// stand-in for what `ps` says of Unreal Agent's programs, a monotonic clock
// the test moves, and an adapter built from them. Nothing here touches a real
// file or runs a program.

import {
  createUnrealAgentAdapter,
  type UnrealAgentAdapterOptions,
} from "@collector/adapters/unreal-agent/index";
import type { UnrealAgentPrograms } from "@core/mapping/unreal-agent/unrealAgentLiveness";
import { HOME, NOW, sessionPath, STARTED_AT } from "@tests/fixtures/unreal-agent/unrealAgent";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";

export type { MemoryFiles };

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/** When the stand-in Unreal Agent program that runs unless a test says otherwise started: before the sessions. */
export const PROGRAM_STARTED_AT = STARTED_AT - 60_000;

/**
 * A stand-in for what `ps` says of Unreal Agent: the start times a test gives
 * it, or that it could not say. It counts how often it is asked.
 */
export function standInUnrealProcesses(
  initial: UnrealAgentPrograms = { ok: true, starts: [PROGRAM_STARTED_AT], unknownStart: false },
) {
  let answer = initial;
  const asked = { count: 0 };
  return {
    asked,
    set(next: UnrealAgentPrograms) {
      answer = next;
    },
    /** The Unreal Agent programs that run, by when each started. */
    running(...starts: number[]) {
      answer = { ok: true, starts, unknownStart: false };
    },
    async read() {
      asked.count += 1;
      return answer;
    },
  };
}

let folderTime = 1;

/**
 * Writes a session's file, as Unreal Agent renames a new file into the
 * sessions folder, which moves the folder's modified time as a disk does.
 */
export function writeSession(
  files: MemoryFiles,
  text: string | Uint8Array,
  options: { id?: string; mtimeMs?: number; dir?: string } = {},
) {
  const file = sessionPath(options.id, options.dir);
  files.write(file, text, { mtimeMs: options.mtimeMs });
  files.touch(file.slice(0, file.lastIndexOf("/")), folderTime++);
  return file;
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with an
 * Unreal Agent program running unless the test says otherwise, and a
 * monotonic clock that moves with the wall clock. With nothing in `env` it
 * looks in `~/.local/state/unreal-agent/sessions`.
 */
export function unrealAgentAdapterFor(files: MemoryFiles, options: UnrealAgentAdapterOptions = {}) {
  const now = options.now ?? (() => NOW);
  return createUnrealAgentAdapter({
    env: {},
    homeDir: HOME,
    now,
    monotonic: () => now() - NOW,
    io: files.io,
    platform: "darwin",
    processes: standInUnrealProcesses(),
    ...options,
  });
}
