import { isMissing, type CodexIo } from "./io.ts";

/**
 * The folder where Codex keeps one lock file for each session a Codex process
 * has open: `<codex home>/thread-writer-locks/<thread id>.lock`.
 *
 * Codex creates the file when a process starts or resumes a session and deletes
 * it when the session shuts down (codex-rs/rollout/src/writer_lock.rs, first
 * shipped in 0.155.0). The same folder holds `.coordination.lock`, which guards
 * the folder itself and is not a session.
 *
 * The folder is only listed. Its files are never opened, locked or examined:
 * opening one could disturb the lock Codex holds on it.
 */
export const WRITER_LOCK_DIR = "thread-writer-locks";

/** `<thread id>.lock`, where the thread id is a UUID. Nothing else in the folder names a session. */
const LOCK_FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;

export type WriterLocks =
  | {
      supported: true;
      /** The thread ids, in lowercase, of the sessions some Codex process has open. */
      open: Set<string>;
    }
  | {
      supported: false;
      /** True when the folder is not there, as with a Codex older than 0.155. False when it could not be listed. */
      missing: boolean;
    };

/** The thread id a lock file is named for, in lowercase, or null for any other name. */
export function threadIdOfLock(name: string): string | null {
  const match = LOCK_FILE_NAME.exec(name);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** Lists the lock folder. A folder that is missing or cannot be listed means open sessions cannot be told apart. */
export async function readWriterLocks(dir: string, io: CodexIo): Promise<WriterLocks> {
  let names: string[];
  try {
    names = await io.readdir(dir);
  } catch (error) {
    return { supported: false, missing: isMissing(error) };
  }
  const open = new Set<string>();
  for (const name of names) {
    const threadId = threadIdOfLock(name);
    if (threadId !== null) open.add(threadId);
  }
  return { supported: true, open };
}
