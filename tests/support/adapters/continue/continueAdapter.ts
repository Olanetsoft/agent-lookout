// The Continue adapter, cut off from this machine, for the tests that share it:
// the same file system held in memory that the Codex tests use, and an adapter
// built from it with a clock the test moves by hand. Nothing here touches a real
// file or runs a program.

import {
  createContinueAdapter,
  type ContinueAdapterOptions,
} from "@collector/adapters/continue/index";
import {
  entryOf,
  HOME,
  INDEX,
  indexText,
  NOW,
  SESSION_ID,
  sessionPath,
  sessionText,
} from "@tests/fixtures/continue/continue";
import { handClock, memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

export { handClock, memoryFiles, type MemoryFiles };

/**
 * An adapter that reads only the stand-in files, on a Mac's rules. With nothing
 * in `env` it looks in `~/.continue/sessions`.
 */
export function continueAdapterFor(files: MemoryFiles, options: ContinueAdapterOptions = {}) {
  return createContinueAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    ...options,
  });
}

/** Stand-in files that hold these sessions, each written at `writtenAt`, and their list. */
export function filesWith(ids: readonly string[] = [SESSION_ID], writtenAt = NOW - 60_000) {
  const files = memoryFiles();
  files.write(INDEX, indexText(ids.map((id) => entryOf(id))), { mtimeMs: writtenAt });
  for (const id of ids) files.write(sessionPath(id), sessionText(id), { mtimeMs: writtenAt });
  return files;
}
