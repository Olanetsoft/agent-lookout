// The Grok Build adapter, cut off from this machine, for the tests that share
// it: the same file system held in memory that the Codex tests use, with each
// thing in it owned by the user the tests say the adapter runs as and with one
// name, as the Autohand Code tests have it; the stand-ins for signal 0 and for
// the `ps` that says when each process started that the Qwen Code tests use;
// and an adapter built from them with a clock the test moves by hand. Nothing
// here touches a real file or a real process.

import {
  createGrokBuildAdapter,
  NEEDS_YOU_NOTE,
  UNCHECKED_NOTE,
  type GrokBuildAdapterOptions,
} from "@collector/adapters/grok-build/index";
import { lstart } from "@tests/fixtures/antigravity";
import {
  DAY,
  eventsPath,
  HOME,
  NOW,
  planPath,
  REGISTRY_FILE,
  registryText,
  summaryPath,
  type Entry,
} from "@tests/fixtures/grok-build/grokBuild";
import {
  OTHER_UID,
  ownedFiles,
  TEST_UID,
} from "@tests/support/adapters/autohand-code/autohandCodeAdapter";
import {
  handClock as codexHandClock,
  memoryFiles as codexMemoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/codexAdapter";
import { standInProcesses, standInStarts } from "@tests/support/adapters/qwenCodeAdapter";

export { OTHER_UID, ownedFiles, standInProcesses, standInStarts, TEST_UID, type MemoryFiles };

/** The file system held in memory, whose files are written at this fixture's `NOW` unless a test says otherwise. */
export const memoryFiles = (clock: () => number = () => NOW) => codexMemoryFiles(clock);

/** A clock a test moves by hand, starting at this fixture's `NOW`. */
export const handClock = (start: number = NOW) => codexHandClock(start);

/** Writes the list of open sessions, as Grok Build renames a new one over it: a new file. */
export function writeRegistry(files: MemoryFiles, entries: readonly Entry[], mtimeMs?: number) {
  files.write(REGISTRY_FILE, registryText(entries), { mtimeMs });
}

/** Writes a session's event log afresh. */
export function writeEvents(
  files: MemoryFiles,
  text: string,
  options: { id?: string; folder?: string; mtimeMs?: number } = {},
) {
  files.write(eventsPath(options.id, options.folder), text, { mtimeMs: options.mtimeMs });
}

/** Adds lines to a session's event log, as Grok Build does: the file keeps its identity. */
export function appendEvents(
  files: MemoryFiles,
  text: string,
  options: { id?: string; folder?: string; mtimeMs?: number } = {},
) {
  files.append(eventsPath(options.id, options.folder), text, { mtimeMs: options.mtimeMs });
}

export function writeSummary(
  files: MemoryFiles,
  text: string,
  options: { id?: string; folder?: string; mtimeMs?: number } = {},
) {
  files.write(summaryPath(options.id, options.folder), text, { mtimeMs: options.mtimeMs });
}

export function writePlan(
  files: MemoryFiles,
  text: string,
  options: { id?: string; folder?: string; mtimeMs?: number } = {},
) {
  files.write(planPath(options.id, options.folder), text, { mtimeMs: options.mtimeMs });
}

/**
 * An adapter that reads only the stand-in files as the test's user, on a
 * Mac's rules, with every process running, started a week before the tests'
 * clock as a `ps` that answers for each says, unless the test says otherwise.
 * With nothing in `env` it looks in `~/.grok`.
 */
export function grokBuildAdapterFor(files: MemoryFiles, options: GrokBuildAdapterOptions = {}) {
  const owned = ownedFiles(files);
  return createGrokBuildAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: owned.io,
    isAlive: () => true,
    platform: "darwin",
    euid: TEST_UID,
    readProcessStarts: async (pids) => new Map(pids.map((pid) => [pid, lstart(NOW - 7 * DAY)])),
    ...options,
  });
}

/** What a healthy poll says first, for folders written as people see them. */
export const healthy = (registry = "~/.grok/active_sessions.json", sessions = "~/.grok/sessions") =>
  `Sessions are read from the list of open sessions Grok Build keeps in ${registry}, and each one's event log in ${sessions}. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`;
