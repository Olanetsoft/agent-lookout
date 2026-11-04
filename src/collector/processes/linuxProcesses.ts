import { open, stat } from "node:fs/promises";

import { validPid } from "./pids.ts";

/**
 * Telling Linux processes apart as Qwen Code does, from `/proc`.
 *
 * A pid is given out again once its process has ended, so a pid alone does
 * not say which process a record was written by. On Linux Qwen Code writes a
 * start token beside the pid, `<boot id>:<start>`: this boot's id, from
 * `/proc/sys/kernel/random/boot_id`, and the process's start, field 22 of
 * `/proc/<pid>/stat`, in clock ticks since the boot (`readProcStartToken` in
 * `core/utils/process-liveness.ts` at v0.25.1). A process given the pid later
 * in the same boot started later, and one given it after a restart has
 * another boot id. Unlike the start time Linux's `ps` gives, neither moves
 * when the clock is set.
 *
 * It also writes the pid namespace the process ran in, the inode of
 * `/proc/self/ns/pid` (`readPidNamespaceId`). A pid means something only in
 * its own namespace, so a record written in a container names a process this
 * side cannot see.
 *
 * Only two files are read, the boot id and a process's `stat`, and this
 * process's own namespace is looked up with a `stat` of the link. Of a `stat`
 * line only field 22 is kept: the program name and every other field are
 * dropped as the line is read. Nothing is written, and no other file of a
 * process, such as its command line or its environment, is opened.
 */

export const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

/** Where Linux names the pid namespace a process runs in. */
export const PID_NAMESPACE_FILE = "/proc/self/ns/pid";

/** A process's `stat`: one line, its pid, its program name in brackets, then its other fields. */
export const statFileOf = (pid: number) => `/proc/${pid}/stat`;

/** Far more than a boot id or a `stat` line holds. No more is read. */
export const MAX_PROC_FILE_BYTES = 4096;

/** Reads one file of `/proc` as text. Tests pass their own. */
export type ReadProcFile = (file: string) => Promise<string>;

/** Reads a file of `/proc`, read-only, at most 4 KiB of it. */
export const readProcFile: ReadProcFile = async (file) => {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_PROC_FILE_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
};

/** A boot id as the kernel writes it, hex digits and dashes, or null for anything else. */
export function bootIdOf(text: string): string | null {
  const value = text.trim();
  return /^[0-9a-f-]+$/i.test(value) ? value : null;
}

/**
 * Field 22 of a `stat` line, the process's start in clock ticks since the
 * boot, or null when the line has none. The program name, field 2, is in
 * brackets and can hold spaces and brackets of its own, so the fields are
 * counted from the line's last `)`, as Qwen Code counts them.
 */
export function startTicksOf(line: string): string | null {
  const nameEnd = line.lastIndexOf(")");
  if (nameEnd === -1) return null;
  // After the name comes field 3, so field 22 is the 20th.
  const ticks = line
    .slice(nameEnd + 1)
    .trim()
    .split(/\s+/)[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/** The start token of each of these processes, by pid. A pid whose token cannot be read is left out. */
export type ReadStartTokens = (pids: readonly number[]) => Promise<Map<number, string>>;

/**
 * Reads start tokens as Qwen Code writes them. The boot id is read once, the
 * first time a token is asked for, and kept, since it changes only when the
 * computer restarts, which ends this process too. A read of it that failed is
 * not kept, and is tried again next time. Until it is read no token is given:
 * a start alone, without its boot, is not Qwen Code's token, so it would never
 * match one. Each `stat` is read each time it is asked for.
 */
export function createStartTokenReader(readFile: ReadProcFile = readProcFile): ReadStartTokens {
  let bootId: string | null = null;
  return async (pids) => {
    const tokens = new Map<number, string>();
    const asked = pids.filter((pid) => validPid(pid) !== undefined);
    if (asked.length === 0) return tokens;
    if (bootId === null) {
      try {
        bootId = bootIdOf(await readFile(BOOT_ID_FILE));
      } catch {
        // Tried again next time.
      }
      if (bootId === null) return tokens;
    }
    const boot = bootId;
    await Promise.all(
      asked.map(async (pid) => {
        let line: string;
        try {
          line = await readFile(statFileOf(pid));
        } catch {
          // The process has gone, or its `stat` cannot be read: no token.
          return;
        }
        const ticks = startTicksOf(line);
        if (ticks !== null) tokens.set(pid, `${boot}:${ticks}`);
      }),
    );
    return tokens;
  };
}

/** The pid namespace this process runs in, or null when it cannot be read. Never throws. */
export type ReadPidNamespace = () => Promise<number | null>;

/** The inode of a file, following a link. Tests pass their own. */
export type InodeOf = (file: string) => Promise<number>;

/**
 * Reads the pid namespace this process runs in as Qwen Code reads its own, as
 * the inode of `/proc/self/ns/pid`, so the two compare as they are. A number
 * read is kept, since a process never moves to another namespace. A read that
 * failed is not, and is tried again next time.
 */
export function createPidNamespaceRead(
  inodeOf: InodeOf = async (file) => (await stat(file)).ino,
): ReadPidNamespace {
  let known: number | null = null;
  return async () => {
    if (known !== null) return known;
    try {
      const inode = await inodeOf(PID_NAMESPACE_FILE);
      if (Number.isSafeInteger(inode) && inode > 0) known = inode;
    } catch {
      // Tried again next time.
    }
    return known;
  };
}
