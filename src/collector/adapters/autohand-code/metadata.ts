import path from "node:path";

import type {
  MetadataFacts,
  MetadataStatus,
} from "../../../core/mapping/autohand-code/autohandCodeMapping.ts";
import { sessionName } from "../../../core/text.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isTrusted, metadataPathOf } from "./folders.ts";
import {
  bytesAt,
  folderAt,
  isWholeObject,
  literalOf,
  timeAt,
  topKey,
  topStringKey,
  topTime,
  valueAfter,
  wordAt,
} from "./jsonBytes.ts";

/**
 * Reading the `metadata.json` Autohand Code keeps for each session, for the
 * few fields a session's status, name and times need. Built from Autohand
 * Code's source at v0.9.11 and not yet checked on a computer running it.
 *
 * Each session has a folder, `sessions/<id>/`, with `metadata.json` beside
 * `conversation.jsonl`, `state.json` and `command-output/`, which are never
 * opened. Autohand Code rewrites `metadata.json` whole at each message, each
 * reply's token counts and each file the session reads
 * (`src/session/SessionManager.ts:598-611`, `:658-693`, `:728-732`), through a
 * temporary file from 0.9.6 on, and in place before. The importer writes it in
 * place still (`src/import/importers/BaseImporter.ts:216`).
 *
 * It holds the start of your last message as `summary`, a title Autohand Code
 * made, which can be the first words of your first instruction, the files the
 * session read, the task of an auto-mode run, and for a copy the account it
 * came from. This finds only `status`, `createdAt`, `lastActiveAt`,
 * `closedAt`, `projectPath`, `client`, `titleSource`, the `importedAt` of
 * `importedFrom`, and `title` only when `titleSource` is `user`, as bytes
 * (`jsonBytes.ts`). The writers put the keys in different orders, so each is
 * looked for in the whole file.
 *
 * A file is opened only as an ordinary file with one name in a real folder,
 * of 1 MiB or less, read-only and following no link, and on macOS and Linux
 * only one of the user Agent Lookout runs as. It is opened only when its size,
 * modified time or identity changed. One cut off as it was written in place
 * stands in from the read before, once. Nothing here writes, renames, locks or
 * deletes anything.
 */

/** The largest `metadata.json` read. */
export const MAX_METADATA_BYTES = 1_048_576;

/** The longest folder read. */
const MAX_PATH_BYTES = 8_192;

/** The longest name read. Autohand Code allows 80 characters (`src/session/sessionTitle.ts:8-20`). */
const MAX_TITLE_BYTES = 1_024;

const STATUSES: readonly MetadataStatus[] = ["active", "completed", "crashed"];
const STATUS_WORDS = STATUSES.map((status) => Buffer.from(`${status}"`));
const CLIENTS = ["terminal", "vscode"] as const;
const CLIENT_WORDS = CLIENTS.map((client) => Buffer.from(`${client}"`));
const USER = Buffer.from('user"');
const IMPORTED_FROM = Buffer.from('\n  "importedFrom": {');
const IMPORTED_AT = Buffer.from('\n    "importedAt": "');
const OBJECT_END = Buffer.from("\n  }");

/** The kept fields of a `metadata.json`, or null when it is not one this reads, as one cut off. */
export function metadataOf(bytes: Buffer, platform: NodeJS.Platform): MetadataFacts | null {
  if (!isWholeObject(bytes)) return null;
  const statusAt = valueAfter(bytes, topStringKey("status"));
  if (statusAt < 0) return null;
  const status = STATUSES[wordAt(bytes, statusAt, STATUS_WORDS)] ?? "other";

  const sourceAt = valueAfter(bytes, topStringKey("titleSource"));
  const byYou = sourceAt >= 0 && bytesAt(bytes, sourceAt, USER);
  // A title Autohand Code made can be your first words, so only yours is looked for.
  const titleAt = byYou ? valueAfter(bytes, topKey("title")) : -1;
  const titleText = titleAt < 0 ? null : literalOf(bytes, titleAt, MAX_TITLE_BYTES);
  const clientAt = valueAfter(bytes, topStringKey("client"));
  const projectAt = valueAfter(bytes, topKey("projectPath"));

  return {
    status,
    createdAt: topTime(bytes, "createdAt"),
    lastActiveAt: topTime(bytes, "lastActiveAt"),
    closedAt: topTime(bytes, "closedAt"),
    importedAt: importedAtOf(bytes),
    projectPath: projectAt < 0 ? null : folderAt(bytes, projectAt, MAX_PATH_BYTES, platform),
    title: titleText === null ? null : (sessionName(titleText) ?? null),
    client: CLIENTS[clientAt < 0 ? -1 : wordAt(bytes, clientAt, CLIENT_WORDS)] ?? null,
  };
}

/** The `importedAt` of `importedFrom`, looked for only inside that object. */
function importedAtOf(bytes: Buffer): number | null {
  const from = valueAfter(bytes, IMPORTED_FROM);
  if (from < 0) return null;
  const end = bytes.indexOf(OBJECT_END, from);
  const inside = bytes.subarray(from, end < 0 ? bytes.byteLength : end);
  return timeAt(inside, valueAfter(inside, IMPORTED_AT));
}

/** What one `metadata.json` says now. */
export type MetadataRead =
  | {
      state: "ok";
      facts: MetadataFacts;
      /** The file's modified time as it was opened for these facts. */
      writtenAt: number;
    }
  /** No ordinary file this reads in a real folder, or an open that failed. */
  | { state: "none" }
  /** Not one this reads, as one cut off. */
  | { state: "broken" }
  /** Over `MAX_METADATA_BYTES`. */
  | { state: "too-large" };

interface Remembered {
  info: FileInfo;
  read: MetadataRead;
  stoodIn: boolean;
}

const sameFile = (a: FileInfo, b: FileInfo) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export interface MetadataReader {
  /** What a session's `metadata.json` says, given its `lstat`, opened only when that changed. */
  read(sessionId: string, info: FileInfo): Promise<MetadataRead>;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

export interface MetadataReaderOptions {
  sessionsDir: string;
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
}

/** A reader of `metadata.json` files, which keeps what it read of each until it changes. */
export function createMetadataReader(options: MetadataReaderOptions): MetadataReader {
  const { sessionsDir, io, platform, euid } = options;
  const remembered = new Map<string, Remembered>();

  async function openAndRead(sessionId: string, looked: FileInfo): Promise<Remembered> {
    // A link at the folder's name would lead out of the sessions folder, and
    // opening a file does not look at the names before its own.
    const folder = await io.lstat(path.join(sessionsDir, sessionId));
    if (!isTrusted(folder, "session-folder", platform, euid)) {
      return { info: looked, read: { state: "none" }, stoodIn: false };
    }
    const handle: OpenFile = await io.openRegular(metadataPathOf(sessionsDir, sessionId));
    try {
      const { info } = handle;
      const remember = (read: MetadataRead): Remembered => ({ info, read, stoodIn: false });
      if (!isTrusted(info, "metadata", platform, euid)) return remember({ state: "none" });
      if (info.size > MAX_METADATA_BYTES) return remember({ state: "too-large" });
      const bytes = Buffer.from(await handle.read(0, info.size));
      const facts = metadataOf(bytes, platform);
      // The time the file had as it was opened, so a write since its `lstat`
      // counts with what it added, and never one before the `lstat`'s.
      const writtenAt = Math.max(looked.mtimeMs, info.mtimeMs);
      return remember(facts === null ? { state: "broken" } : { state: "ok", facts, writtenAt });
    } finally {
      await handle.close().catch(() => {});
    }
  }

  return {
    async read(sessionId, info) {
      const known = remembered.get(sessionId);
      if (known && sameFile(known.info, info)) return known.read;
      // One over the most by its `lstat` is never opened. The open file is checked again.
      if (info.size > MAX_METADATA_BYTES) {
        const tooLarge: MetadataRead = { state: "too-large" };
        remembered.set(sessionId, { info, read: tooLarge, stoodIn: false });
        return tooLarge;
      }
      const standIn = () => {
        if (known?.read.state !== "ok" || known.stoodIn) return null;
        known.stoodIn = true;
        return known.read;
      };
      let opened: Remembered;
      try {
        opened = await openAndRead(sessionId, info);
      } catch {
        // Gone since its `lstat`, or a read that failed: what was read before
        // stands in, once, and it is opened again on the next poll.
        return standIn() ?? { state: "none" };
      }
      // Half written, as a read can catch it: what was read before stands in, once.
      if (opened.read.state === "broken") {
        const before = standIn();
        if (before !== null) return before;
      }
      remembered.set(sessionId, opened);
      return opened.read;
    },
    keepOnly(sessionIds) {
      for (const sessionId of remembered.keys()) {
        if (!sessionIds.has(sessionId)) remembered.delete(sessionId);
      }
    },
  };
}
