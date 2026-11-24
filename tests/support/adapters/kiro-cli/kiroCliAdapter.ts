// The Kiro CLI adapter, cut off from this computer, for the tests that share
// it: the same file system held in memory that the Codex tests use, and an
// adapter built from it with a clock the test moves by hand, stand-ins for
// signal 0 and for `ps`, and a computer that has been on for 30 days. Nothing
// here touches a real file or a real process.

import {
  createKiroCliAdapter,
  OPEN_NOTE,
  UNCHECKED_NOTE,
  V2_NOTE,
  type KiroCliAdapterOptions,
} from "@collector/adapters/kiro-cli/index";
import { lstart } from "@tests/fixtures/antigravity";
import {
  DAY,
  HOME,
  LOCKED_AT,
  MINUTE,
  NOW,
  PID,
  v2Header,
  v2Paths,
  v3Header,
  v3Paths,
  lockText,
} from "@tests/fixtures/kiro-cli/kiroCli";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/** A `ps` that says each of these processes started at that time, and knows no other. */
export const startsOf =
  (starts: Record<number, number>) =>
  async (pids: readonly number[]): Promise<Map<number, string>> =>
    new Map(pids.flatMap((pid) => (starts[pid] === undefined ? [] : [[pid, lstart(starts[pid])]])));

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with every
 * process running unless the test says otherwise, a `ps` that says the
 * fixture's process started a minute before its lock was taken, and a computer
 * that has been on for 30 days. With nothing in `env` it looks in `~/.kiro`.
 */
export function kiroCliAdapterFor(files: MemoryFiles, options: KiroCliAdapterOptions = {}) {
  return createKiroCliAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    isAlive: () => true,
    platform: "darwin",
    uptimeMs: () => 30 * DAY,
    readProcessStarts: startsOf({ [PID]: LOCKED_AT - MINUTE }),
    ...options,
  });
}

/** Writes a V3 session: its header, its log when given, and its lock when given. */
export function writeV3(
  files: MemoryFiles,
  id: string,
  {
    log,
    lock,
    header = {},
    writtenAt = NOW - MINUTE,
  }: {
    log?: string;
    lock?: string;
    header?: Record<string, unknown>;
    writtenAt?: number;
  } = {},
) {
  const paths = v3Paths(id);
  files.write(paths.header, v3Header(id, header), { mtimeMs: writtenAt });
  if (log !== undefined) files.write(paths.log, log, { mtimeMs: writtenAt });
  if (lock !== undefined) files.write(paths.lock, lock, { mtimeMs: LOCKED_AT });
  return paths;
}

/** Writes a V2 session: its header, its transcript when given, and its lock when given. */
export function writeV2(
  files: MemoryFiles,
  id: string,
  {
    log,
    lock,
    header = {},
    writtenAt = NOW - MINUTE,
  }: {
    log?: string;
    lock?: string;
    header?: Record<string, unknown>;
    writtenAt?: number;
  } = {},
) {
  const paths = v2Paths(id);
  files.write(paths.header, v2Header(id, header), { mtimeMs: writtenAt });
  if (log !== undefined) files.write(paths.log, log, { mtimeMs: writtenAt });
  if (lock !== undefined) files.write(paths.lock, lock, { mtimeMs: LOCKED_AT });
  return paths;
}

/** The fixture's lock: its process, taken half an hour ago. */
export const LOCK = lockText();

/** What a healthy poll says, for a folder written as people see it. */
export const healthy = (folder = "~/.kiro") =>
  `Sessions are read from the files Kiro CLI saves in ${folder}, since it offers no list of its sessions for other programs. ${V2_NOTE} ${OPEN_NOTE} ${UNCHECKED_NOTE}`;
