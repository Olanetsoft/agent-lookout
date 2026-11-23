// The Copilot CLI adapter, cut off from this computer, for the tests that share
// it: the same file system held in memory that the Codex tests use, the
// stand-ins for signal 0 and for the `ps` that says when each process started
// that the Qwen Code tests use, and an adapter built from them with a clock
// the test moves by hand. Nothing here touches a real file or a real process.

import {
  createCopilotCliAdapter,
  ENDS_NOTE,
  FINISHED_NOTE,
  IDLE_NOTE,
  MAC_LOCK_NOTE,
  NEEDS_YOU_NOTE,
  OTHER_APPS_NOTE,
  READONLY_NOTE,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  UNCHECKED_RUN_NOTE,
  UNWRITTEN_NOTE,
  type CopilotCliAdapterOptions,
} from "@collector/adapters/copilot-cli/index";
import { lstart } from "@tests/fixtures/antigravity";
import {
  eventsPath,
  HOME,
  HOUR,
  lockPath,
  NOW,
  PID,
  SESSION_ID,
  SESSIONS,
  sessionFolder,
} from "@tests/fixtures/copilot-cli/copilotCli";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";
import { standInProcesses, standInStarts } from "@tests/support/adapters/qwenCodeAdapter";

export { standInProcesses, standInStarts, type MemoryFiles };

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/** Each folder's next modified time: within the hour before `NOW`, and never the same twice. */
let folderTime = NOW - HOUR;

/** Moves a folder's modified time on, as adding or removing a name in it does on a disk. */
export function touchFolder(files: MemoryFiles, folder: string): void {
  files.touch(folder, folderTime++);
}

/**
 * Writes a session's event log in place of any other, and moves the times of
 * its folder and of the sessions folder, as making them does on a disk.
 */
export function writeLog(
  files: MemoryFiles,
  content: string | Uint8Array,
  options: { id?: string; mtimeMs?: number; sessionsDir?: string } = {},
): void {
  const id = options.id ?? SESSION_ID;
  const sessionsDir = options.sessionsDir ?? SESSIONS;
  files.write(eventsPath(id, sessionsDir), content, { mtimeMs: options.mtimeMs });
  touchFolder(files, sessionFolder(id, sessionsDir));
  touchFolder(files, sessionsDir);
}

/** Adds to a session's event log, as Copilot appends an event. Its folders' times stay. */
export function appendLog(
  files: MemoryFiles,
  content: string,
  options: { id?: string; mtimeMs?: number } = {},
): void {
  files.append(eventsPath(options.id ?? SESSION_ID), content, { mtimeMs: options.mtimeMs });
}

/** Makes a lock in a session's folder, as a Copilot process does when it opens the session. */
export function writeLock(
  files: MemoryFiles,
  options: { pid?: number; id?: string; mtimeMs?: number } = {},
): void {
  const id = options.id ?? SESSION_ID;
  files.write(lockPath(options.pid ?? PID, id), "", { mtimeMs: options.mtimeMs ?? NOW - HOUR });
  touchFolder(files, sessionFolder(id));
}

/** Removes a lock, as a Copilot process does when it lets the session go. */
export function removeLock(files: MemoryFiles, options: { pid?: number; id?: string } = {}): void {
  const id = options.id ?? SESSION_ID;
  files.remove(lockPath(options.pid ?? PID, id));
  touchFolder(files, sessionFolder(id));
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with every
 * process running, started two hours before the fixture's `NOW` as a `ps`
 * that answers for each says, unless the test says otherwise. With nothing in
 * `env` it looks in `~/.copilot/session-state`.
 */
export function copilotCliAdapterFor(files: MemoryFiles, options: CopilotCliAdapterOptions = {}) {
  return createCopilotCliAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: () => true,
    platform: "darwin",
    readProcessStarts: async (pids) => new Map(pids.map((pid) => [pid, lstart(NOW - 2 * HOUR)])),
    ...options,
  });
}

/** What a healthy poll on a Mac says first, for a folder written as people see it. */
export const healthy = (sessions = "~/.copilot/session-state", lockNote = MAC_LOCK_NOTE) =>
  `Sessions are read from the event logs Copilot CLI keeps in ${sessions}. ${[
    STATUS_NOTE,
    IDLE_NOTE,
    NEEDS_YOU_NOTE,
    UNWRITTEN_NOTE,
    ENDS_NOTE,
    FINISHED_NOTE,
    lockNote,
    OTHER_APPS_NOTE,
    READONLY_NOTE,
    UNCHECKED_NOTE,
    UNCHECKED_RUN_NOTE,
  ].join(" ")}`;
