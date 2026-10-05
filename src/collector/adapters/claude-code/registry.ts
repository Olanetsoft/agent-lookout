import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

import { validPid } from "./feed.ts";

/**
 * The per-process session registry, `<claude home>/sessions/<pid>.json`.
 *
 * Claude Code acknowledges the directory and documents none of its fields, so
 * everything here is optional and nothing here may break a poll. The registry
 * is read on every poll, because reading it starts no process, and what it says
 * is checked against the supported feed, which is run far less often. It also
 * holds two things the feed lacks: which app a session runs in and when its
 * status last changed.
 *
 * Next to each entry sits a `<pid>.<hash>.key` file. Those are never opened. A
 * name must end in `.json` to be read, and the thing behind the name must be an
 * ordinary file: a link is not followed, so a name ending in `.json` cannot lead
 * to a `.key` file or out of the directory, and a pipe or device is not read.
 *
 * Field notes, all taken from Claude Code 2.1.283 and none of them promised:
 * - `status` is `busy`, `shell`, `idle` or `waiting`. `claude agents --json`
 *   prints a `shell` session as `busy`, so it is treated as working. A session
 *   that has only just started may not have written a status yet.
 * - `kind` is `interactive`, `bg`, `daemon` or `daemon-worker`. Only the first
 *   two are sessions; the others are Claude Code's helper processes.
 * - `procStart` is what `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` printed when
 *   the entry was written. Claude Code compares it with the same command's
 *   output later to tell whether a pid still belongs to the same process.
 * - `statusUpdatedAt` is written when the status changes and is left alone
 *   while the status stands. In entries written by 2.1.282 to 2.1.286 it was
 *   the moment the file itself was last written, hours or days earlier for a
 *   session that had stayed in one status. The rule that tells one wait from
 *   the next relies on this (`src/core/waitChanges.ts`): were the time to move
 *   during a wait, every move would be taken for a new wait. Whether it moves
 *   when only `waitingFor` changes has not been seen either way.
 */

/** The fields we use from one registry file. All but `pid` are optional. */
export interface RegistryEntry {
  pid: number;
  sessionId?: string;
  cwd?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  /** `interactive`, `bg`, `daemon` or `daemon-worker`. */
  kind?: string;
  /** For example `claude-vscode` or `claude-desktop`. */
  entrypoint?: string;
  name?: string;
  /** `busy`, `shell`, `idle` or `waiting`. */
  status?: string;
  waitingFor?: string;
  /** Background sessions: `working`, `blocked`, `done`, `failed` or `stopped`. */
  state?: string;
  /** Epoch milliseconds of the last status change. */
  statusUpdatedAt?: number;
  /** When the process started, as `ps` printed it. See the field notes above. */
  procStart?: string;
}

/** The two file operations the registry reader performs. Replaced in tests. */
export interface RegistryIo {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
}

/** A registry file is small. Anything this large is not one, so it is not read. */
const MAX_ENTRY_BYTES = 256 * 1024;

/**
 * Reads one registry file, and only if it is an ordinary file of ordinary size.
 *
 * - `O_NOFOLLOW` makes the open fail when the name is a symbolic link.
 * - `O_NONBLOCK` makes the open return at once for a named pipe, which would
 *   otherwise wait for a writer for ever and take the whole poll with it.
 * - The checks are made on the open file, not on the name, so nothing can be
 *   swapped in between the check and the read.
 * - The size is checked before a byte is read.
 *
 * Throws for anything it will not read. The caller skips that entry.
 */
export async function readRegularFile(file: string): Promise<string> {
  // The two flags do not exist on Windows, where they are left out.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(file, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Not an ordinary file.");
    if (info.size > MAX_ENTRY_BYTES) throw new Error("Too large to be a registry file.");

    const buffer = Buffer.alloc(info.size);
    let filled = 0;
    while (filled < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.toString("utf8", 0, filled);
  } finally {
    await handle.close();
  }
}

const nodeIo: RegistryIo = {
  readdir: (dir) => readdir(dir),
  readFile: readRegularFile,
};

export type RegistryRead =
  | {
      readable: true;
      /** By pid. Files that are malformed or have no usable pid are left out. */
      entries: Map<number, RegistryEntry>;
    }
  | {
      readable: false;
      /** True when the directory is not there at all, as on a machine without Claude Code. */
      missing: boolean;
    };

/** The same limit for content that arrives another way, as it does in tests. */
const MAX_ENTRY_CHARS = MAX_ENTRY_BYTES;

/** Whether a directory entry is a registry file we may open. */
export function isRegistryFileName(name: string): boolean {
  return name.endsWith(".json") && name !== ".json" && !name.startsWith(".");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A whole number. Whether it could be a real time is decided where the clock is known. */
function wholeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Parses one registry file. Returns null for anything that is not a usable entry. */
export function parseRegistryEntry(content: string): RegistryEntry | null {
  if (content.length > MAX_ENTRY_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const pid = validPid(raw.pid);
  if (pid === undefined) return null;

  return {
    pid,
    sessionId: text(raw.sessionId),
    cwd: text(raw.cwd),
    startedAt: wholeNumber(raw.startedAt),
    kind: text(raw.kind),
    entrypoint: text(raw.entrypoint),
    name: text(raw.name),
    status: text(raw.status),
    waitingFor: text(raw.waitingFor),
    state: text(raw.state),
    statusUpdatedAt: wholeNumber(raw.statusUpdatedAt),
    procStart: text(raw.procStart),
  };
}

/**
 * Reads every `*.json` file in the registry directory.
 *
 * An entry that cannot be read or parsed is skipped without a word: a session
 * can exit between the listing and the read, Claude Code has shipped registry
 * files with stray characters in them, and a link, a pipe or an oversized file
 * is not a registry file whatever it is called. Only a directory that cannot be
 * listed at all makes the registry unreadable.
 */
export async function readRegistry(
  sessionsDir: string,
  io: RegistryIo = nodeIo,
): Promise<RegistryRead> {
  let names: string[];
  try {
    names = await io.readdir(sessionsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { readable: false, missing: code === "ENOENT" || code === "ENOTDIR" };
  }

  const files = names.filter(isRegistryFileName).sort();
  const parsed = await Promise.all(
    files.map(async (name) => {
      try {
        return parseRegistryEntry(await io.readFile(path.join(sessionsDir, name)));
      } catch {
        return null;
      }
    }),
  );

  const entries = new Map<number, RegistryEntry>();
  parsed.forEach((entry, index) => {
    if (!entry) return;
    // The file named after the pid is the one Claude Code wrote for that process,
    // so it wins over any other file that happens to claim the same pid.
    const isNamedForPid = files[index] === `${entry.pid}.json`;
    if (isNamedForPid || !entries.has(entry.pid)) entries.set(entry.pid, entry);
  });
  return { readable: true, entries };
}
