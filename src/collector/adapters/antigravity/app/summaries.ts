import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isExecutableFile } from "../../../files/paths.ts";
import type { FileInfo, ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import { conversationIdOfFolder } from "../shared/conversations.ts";

/**
 * The folder each Antigravity 2.0 chat works in, from the app's own list of
 * chats: `conversation_summaries.db` in its folder, a SQLite database.
 *
 * Agent Lookout has no SQLite of its own, so it asks the system's `sqlite3`
 * program, found only at fixed places, `/usr/bin/sqlite3` first, and never on
 * Windows. It is started directly, never through a shell, with stdin closed,
 * a timeout, no settings of the person's own (`-init /dev/null` in place of
 * `~/.sqliterc`), and one question:
 *
 *     sqlite3 -init /dev/null -batch -json 'file:<the file>?mode=ro&immutable=1'
 *       'SELECT conversation_id, workspace_uris FROM conversation_summaries'
 *
 * `mode=ro` opens the file read-only and never makes it when it is not there.
 * `immutable=1` tells SQLite the file cannot change, so it takes no lock and
 * makes no `-shm` or `-wal` file beside it: nothing is ever written. It also
 * means what the app has written to its own `-wal` file and not yet moved into
 * the database is not seen, so a chat begun a moment ago can be without its
 * folder until then, and a read made while the app writes the file can fail.
 *
 * Only those two columns are asked for: never `title`, `preview` or
 * `raw_summary`, which hold what was written in a chat, and never the
 * `conversations_fts` tables. Each row is kept only as its chat's id and the
 * first local folder its `workspace_uris` names, and the rest is dropped.
 *
 * The file is looked at with `lstat` on each poll that lists a chat, and read
 * again only when it is an ordinary file whose size or modified time changed
 * since a read that worked, or a minute after one that did not, whether it
 * changed or not: a `sqlite3` that cannot read it, such as one too old to know
 * `-json`, is not started again on every change the app makes.
 */

/** The app's list of chats, in its folder. */
export const SUMMARIES_FILE = "conversation_summaries.db";

/** The two columns read, and nothing else. */
export const SUMMARIES_QUERY = "SELECT conversation_id, workspace_uris FROM conversation_summaries";

/**
 * Where `sqlite3` is looked for, in this order: the system's own, which macOS
 * and most Linux systems have, then Homebrew's two homes and MacPorts. Never
 * on `PATH`.
 */
export const SQLITE_LOCATIONS = [
  "/usr/bin/sqlite3",
  "/bin/sqlite3",
  "/opt/homebrew/bin/sqlite3",
  "/usr/local/bin/sqlite3",
  "/opt/local/bin/sqlite3",
] as const;

/** How long `sqlite3` gets. It answers in a few milliseconds. */
export const SQLITE_TIMEOUT_MS = 5_000;

/** How long after a read that did not work the file is read again, changed or not. */
export const RETRY_MS = 60_000;

/** Far more than a list of every chat's id and folder, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The longest folder kept. */
const MAX_FOLDER_LENGTH = 4096;

/** A control character or a mark that turns text around, which no folder shown may hold. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/** The database as SQLite names it: read-only, and taken as a file nothing changes. */
export function summariesUri(file: string): string {
  const encoded = file.split("/").map(encodeURIComponent).join("/");
  return `file:${encoded}?mode=ro&immutable=1`;
}

/** The arguments `sqlite3` is given, each as it is. */
export function sqliteArguments(file: string): string[] {
  return ["-init", "/dev/null", "-batch", "-json", summariesUri(file), SUMMARIES_QUERY];
}

/**
 * The first local folder a `workspace_uris` value names: a JSON array of
 * `file:` addresses, of which the first that is an absolute path on this
 * machine, with no control character in it, is taken. Null for anything else.
 */
export function folderOfUris(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  let uris: unknown;
  try {
    uris = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(uris)) return null;
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri.startsWith("file:")) continue;
    let folder: string;
    try {
      folder = fileURLToPath(uri, { windows: false });
    } catch {
      continue;
    }
    if (
      path.posix.isAbsolute(folder) &&
      folder.length <= MAX_FOLDER_LENGTH &&
      !UNPRINTABLE.test(folder)
    ) {
      return folder;
    }
  }
  return null;
}

/**
 * Each chat's folder, by its id in lower case, from what `sqlite3 -json`
 * printed. Null when it is not what that prints: a JSON array of rows, or
 * nothing at all for a table with no rows.
 */
export function readFolders(stdout: string): Map<string, string> | null {
  if (stdout.trim() === "") return new Map();
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const folders = new Map<string, string>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { conversation_id: id, workspace_uris: uris } = row as Record<string, unknown>;
    const conversation = typeof id === "string" ? conversationIdOfFolder(id) : null;
    const folder = folderOfUris(uris);
    if (conversation !== null && folder !== null) folders.set(conversation, folder);
  }
  return folders;
}

/** What one run of `sqlite3` printed, or `ok: false` when it did not answer. */
export type SqliteAnswer = { ok: true; stdout: string } | { ok: false };

/** Runs `sqlite3` with these arguments. Tests pass their own. */
export type RunSqlite = (binary: string, args: readonly string[]) => Promise<SqliteAnswer>;

/** Starts one `sqlite3` directly, with no shell between, stdin closed and a timeout. Never rejects. */
export function runSqlite(binary: string, args: readonly string[]): Promise<SqliteAnswer> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        binary,
        [...args],
        {
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
          timeout: SQLITE_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout: String(stdout) }),
      );
      child.stdin?.end();
    } catch {
      resolve({ ok: false });
    }
  });
}

/** The first `sqlite3` at one of the fixed places that this user may run, or null. */
export async function findSqlite(
  isExecutable: (candidate: string) => Promise<boolean> = isExecutableFile,
): Promise<string | null> {
  for (const candidate of SQLITE_LOCATIONS) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * How the last read went:
 *
 * read            the folders were read
 * missing         the file is not there, or is not an ordinary file
 * no-sqlite       no `sqlite3` was found to read it
 * failed          `sqlite3` did not answer, or its answer could not be read
 * not-on-windows  nothing is read on Windows
 */
export type SummariesState = "read" | "missing" | "no-sqlite" | "failed" | "not-on-windows";

export interface Summaries {
  state: SummariesState;
  /** Each chat's folder, by its id. Empty unless `state` is `read`. */
  folders: ReadonlyMap<string, string>;
}

export interface SummariesReader {
  /** The folders, read again only when the file changed since a read that worked, or a failed read is due again. Never throws. */
  read(at: number): Promise<Summaries>;
}

const NONE: ReadonlyMap<string, string> = new Map();

export function createSummariesReader(options: {
  home: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  run?: RunSqlite;
  find?: () => Promise<string | null>;
}): SummariesReader {
  const { io, platform } = options;
  const run = options.run ?? runSqlite;
  const find = options.find ?? (() => findSqlite());
  // Read only on macOS and Linux, so the path is joined as there, whatever runs the code.
  const file = path.posix.join(options.home, SUMMARIES_FILE);
  /** The last read, with the file as it was then and when it was made. */
  let last: (Summaries & { info: FileInfo; at: number }) | null = null;

  async function read(at: number): Promise<Summaries> {
    if (platform === "win32") return { state: "not-on-windows", folders: NONE };
    let info: FileInfo;
    try {
      info = await io.lstat(file);
    } catch {
      last = null;
      return { state: "missing", folders: NONE };
    }
    if (info.kind !== "file") {
      last = null;
      return { state: "missing", folders: NONE };
    }
    const unchanged =
      last !== null &&
      last.info.ino === info.ino &&
      last.info.size === info.size &&
      last.info.mtimeMs === info.mtimeMs;
    // A clock set back counts as time enough.
    const due = last === null || at - last.at < 0 || at - last.at >= RETRY_MS;
    if (last !== null && (last.state === "read" ? unchanged : !due)) {
      return { state: last.state, folders: last.folders };
    }

    const binary = await find();
    let next: Summaries;
    if (binary === null) {
      next = { state: "no-sqlite", folders: NONE };
    } else {
      const answer = await run(binary, sqliteArguments(file));
      const folders = answer.ok ? readFolders(answer.stdout) : null;
      next = folders === null ? { state: "failed", folders: NONE } : { state: "read", folders };
    }
    last = { ...next, info, at };
    return next;
  }

  return {
    async read(at) {
      try {
        return await read(at);
      } catch {
        last = null;
        return { state: "failed", folders: NONE };
      }
    },
  };
}
