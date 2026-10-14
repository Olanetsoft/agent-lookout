import path from "node:path";

import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { validPid } from "../../processes/pids.ts";
import { isQwenSessionId } from "./transcriptFile.ts";

/**
 * Qwen Code's list of running sessions, `<qwen home>/sessions/`: one small
 * JSON file for each session a Qwen Code process has open, which Qwen Code
 * documents for other programs to read (docs/users/features/cross-session-protocol.md
 * at v0.25.1). Built from that source and not yet checked on a machine
 * running Qwen Code.
 *
 * - A file is named `<pid>.json`, or `<pid>-<8 hex>.json` for a process that
 *   hosts more than one session. Only those names are opened, and the pid in
 *   the name must be the record's own: Qwen Code's own readers make the same
 *   two checks (`session-registry.ts`). Its temporary files,
 *   `<name>.json.<12 hex>.tmp`, and every other name are never opened.
 * - Each is opened without following a link, only as an ordinary file, and
 *   only when it is 64 KiB or less, the limit Qwen Code reads to.
 * - Only `pid`, `sessionId`, `cwd`, `startedAt` and `kind` are kept. The
 *   record also holds `ipcPath`, the path of the session's socket, and
 *   `ipcToken`, the token that lets a program send to it: both are dropped
 *   with the parsed record, never copied, kept, logged or used. So are
 *   `name`, `procStart`, `pidNs`, `qwenVersion` and anything Qwen Code adds,
 *   except that a start token or a namespace id says the record was written
 *   by a process on Linux, which on a Mac or Windows is one in a container.
 * - `kind` is `tui` for Qwen Code in a terminal, `headless` or `serve` for a
 *   session an editor or Qwen Code's own server drives, and `external` for a
 *   program that is not Qwen Code. A record without one is a terminal's,
 *   written before the field. Only terminal sessions are listed.
 * - A record of a newer format, `schemaVersion` above 1, is counted and not
 *   read, as Qwen Code's own readers do.
 *
 * Nothing here writes, renames, deletes or creates anything: Qwen Code's own
 * listing deletes records whose process has gone, which is why Agent Lookout
 * reads the files itself rather than running it.
 */

export const SESSIONS_DIR = "sessions";

/** The most of a record read, as Qwen Code reads no more. */
export const MAX_RECORD_BYTES = 64 * 1024;

/** The one format this reads. A higher one is a newer Qwen Code's. */
export const SCHEMA_VERSION = 1;

/** `<pid>.json`, or `<pid>-<8 hex>.json`. */
const RECORD_NAME = /^\d+(-[0-9a-f]{8})?\.json$/;

/** A kind as Qwen Code keeps one. Any other value is dropped, which reads as `tui`. */
const KIND = /^[a-z][a-z0-9-]{0,15}$/;

/** The longest folder kept. A longer one is not a folder. */
const MAX_CWD_LENGTH = 4096;

const CONTROL = /\p{Cc}/u;

/** The kind of a terminal session, which is the only kind listed. */
export const TERMINAL_KIND = "tui";

/** The pid a record's name gives, written as Qwen Code writes it, or null for any other name. */
export function pidOfRecordName(name: string): number | null {
  if (!RECORD_NAME.test(name)) return null;
  const digits = name.split(/[-.]/)[0] ?? "";
  const pid = Number(digits);
  // `041001.json` is not a name Qwen Code writes.
  return validPid(pid) !== undefined && String(pid) === digits ? pid : null;
}

/** What is kept of one record. */
export interface RegistryEntry {
  pid: number;
  /** The session's id, as Qwen Code's own rule for an id allows: hex digits and dashes. */
  sessionId: string;
  /** The session's folder: an absolute path, or null when the record's is not one. */
  cwd: string | null;
  /** When the process registered the session, in epoch milliseconds, as written. */
  startedAt: number | null;
  /** `tui` when the record has none. */
  kind: string;
  /** The record was written by a process on Linux: it carries a start token or a namespace id. */
  linux: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function folder(value: unknown, platform: NodeJS.Platform): string | null {
  if (typeof value !== "string" || value === "" || value.length > MAX_CWD_LENGTH) return null;
  if (CONTROL.test(value)) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  return paths.isAbsolute(value) ? value : null;
}

/**
 * The kept fields of one record, `"newer"` for one of a newer format, or null
 * for anything that is not a record this reads: not a JSON object, a pid
 * that is not the name's, or no session id.
 */
export function parseRecord(
  content: string,
  namePid: number,
  platform: NodeJS.Platform,
): RegistryEntry | "newer" | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { schemaVersion } = value;
  if (typeof schemaVersion !== "number") return null;
  if (schemaVersion > SCHEMA_VERSION) return "newer";
  if (schemaVersion !== SCHEMA_VERSION) return null;
  const pid = validPid(value.pid);
  if (pid === undefined || pid !== namePid) return null;
  if (!isQwenSessionId(value.sessionId)) return null;
  const startedAt =
    typeof value.startedAt === "number" && Number.isSafeInteger(value.startedAt)
      ? value.startedAt
      : null;
  return {
    pid,
    sessionId: value.sessionId,
    cwd: folder(value.cwd, platform),
    startedAt,
    kind: typeof value.kind === "string" && KIND.test(value.kind) ? value.kind : TERMINAL_KIND,
    linux:
      (typeof value.procStart === "string" && value.procStart !== "") ||
      (typeof value.pidNs === "number" && Number.isFinite(value.pidNs)),
  };
}

export type RegistryRead =
  | {
      readable: true;
      /** The terminal sessions' records. Two can name one session: `oneForEachSession` chooses. */
      entries: RegistryEntry[];
      /** By file name, each record that was read and parsed this time, for the next read. */
      parsed: Map<string, RegistryEntry>;
      /** How many records are of a newer format. */
      newer: number;
      /** How many terminal records were written on another system: Linux, from a Mac or Windows. */
      elsewhere: number;
    }
  | {
      readable: false;
      /** True when there is no folder at all. */
      missing: boolean;
    };

/** The text of one record, or null when it is not an ordinary file of 64 KiB or less. */
async function readRecordFile(file: string, io: ReadOnlyIo): Promise<string | null> {
  const handle = await io.openRegular(file);
  try {
    if (handle.info.size > MAX_RECORD_BYTES) return null;
    const bytes = await handle.read(0, handle.info.size);
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Reads every record in the folder.
 *
 * A record that cannot be opened is skipped: its session may have ended
 * between the listing and the read. One that was read and does not parse may
 * be one caught mid-write, though Qwen Code writes each through a temporary
 * file and a rename. Given what the read before parsed, `previous`, the entry
 * that file held then stands in for it this once, so its session does not
 * drop out of the list for a poll. One still not whole the next time is
 * skipped.
 */
export async function readRegistry(
  sessionsDir: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
  previous?: ReadonlyMap<string, RegistryEntry>,
): Promise<RegistryRead> {
  let names: string[];
  try {
    names = await io.readdir(sessionsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { readable: false, missing: code === "ENOENT" || code === "ENOTDIR" };
  }

  const files = names
    .map((name) => ({ name, pid: pidOfRecordName(name) }))
    .filter((file): file is { name: string; pid: number } => file.pid !== null)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const parsed = new Map<string, RegistryEntry>();
  let newer = 0;
  const found = await Promise.all(
    files.map(async ({ name, pid }) => {
      let content: string | null;
      try {
        content = await readRecordFile(path.join(sessionsDir, name), io);
      } catch {
        return null;
      }
      if (content === null) return null;
      const entry = parseRecord(content, pid, platform);
      if (entry === "newer") {
        newer += 1;
        return null;
      }
      if (entry === null) return previous?.get(name) ?? null;
      parsed.set(name, entry);
      return entry;
    }),
  );

  // A Linux process's ids mean nothing on a Mac or Windows: one in a container
  // writes into the folder it shares with this computer.
  const foreign = platform === "darwin" || platform === "win32";
  let elsewhere = 0;
  const entries: RegistryEntry[] = [];
  for (const entry of found) {
    if (entry === null || entry.kind !== TERMINAL_KIND) continue;
    if (foreign && entry.linux) {
      elsewhere += 1;
      continue;
    }
    entries.push(entry);
  }
  return { readable: true, entries, parsed, newer, elsewhere };
}

/** A session's one record, and whether its process runs. */
export interface ChosenEntry {
  entry: RegistryEntry;
  alive: boolean;
}

function isNewer(entry: RegistryEntry, than: RegistryEntry): boolean {
  return (entry.startedAt ?? -Infinity) > (than.startedAt ?? -Infinity);
}

/**
 * One record for each session, with whether its process runs, asked of
 * `isAlive` once for each record. Two records naming one session, as a
 * process that resumed it and one that had not yet let it go would write,
 * give the newest by `startedAt` whose process runs, as Qwen Code decides
 * between them: its own listing checks each process first, then takes the
 * newest. When no process of them runs, the newest.
 */
export function oneForEachSession(
  entries: readonly RegistryEntry[],
  isAlive: (pid: number) => boolean,
): ChosenEntry[] {
  const bySession = new Map<string, ChosenEntry>();
  for (const entry of entries) {
    const alive = isAlive(entry.pid);
    const kept = bySession.get(entry.sessionId);
    if (
      kept === undefined ||
      (alive && !kept.alive) ||
      (alive === kept.alive && isNewer(entry, kept.entry))
    ) {
      bySession.set(entry.sessionId, { entry, alive });
    }
  }
  return [...bySession.values()];
}
