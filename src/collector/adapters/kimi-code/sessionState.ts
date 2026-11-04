import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { stateFilePath, stateFolderIsReal, type SessionPlace } from "./paths.ts";
import { folderOf, isRecord } from "./sessionIndex.ts";

/**
 * Reading a session's `state.json`, for the little this adapter needs. Built
 * from Kimi Code's source at 2.4.1 and not yet checked on a computer running it.
 *
 * Kimi Code rewrites the file whole, through a temporary file, each time a
 * session's title, last prompt, agents or last turn changes
 * (`session/sessionMetadata/sessionMetadataService.ts`), so a read never catches
 * one half written.
 *
 * - It is opened without following a link and only inside real folders, and read
 *   only as an ordinary file of 1 MiB or less.
 * - Only `cwd`, `createdAt`, `updatedAt`, `lastTurnReason`, `archived`, `title`
 *   and what says where `title` came from are read. `lastPrompt`, which holds the
 *   last prompt, `agents`, the rest of `custom` and anything Kimi Code adds are
 *   dropped with the parsed file, never copied, kept or logged.
 * - The title is kept only when Kimi Code's model or a person set it:
 *   `titleKind` `generated` or `custom`, or `isCustomTitle` `true`. By default a
 *   session's title is the first 200 characters of its first prompt, marked
 *   `replaceable`, and it is dropped. A title is also dropped for a session
 *   brought in from another program, which keeps the title it came with marked
 *   `generated`, and it can be that program's first prompt.
 *
 * A file remembered is opened again only when its size, modified time or
 * identity changes. Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a `state.json` read. Its prompt is at most 4,000 characters. */
export const MAX_STATE_BYTES = 1024 * 1024;

/** What `custom` says of a session made from another session for a client. */
const CHILD_KIND_KEY = "child_session_kind";

/** The keys `custom` holds for a session Kimi Code brought in from another program. */
const IMPORTED_KEYS = ["imported_from", "imported_from_kimi_cli"];

/** What is kept of a `state.json`. */
export interface SessionState {
  /** The session's folder: an absolute path, or null when the file's is not one. */
  folder: string | null;
  /** The title a model or a person set. Null for any other. */
  ownName: string | null;
  /** `createdAt`, when it is a number. Whether it is a time that could be right is asked later. */
  createdAt: number | null;
  /** `updatedAt`, when it is a number. */
  updatedAt: number | null;
  /** Whether the file says the last turn failed. */
  lastTurnFailed: boolean;
  /** False for a session the person archived and for a child session, which are not listed. */
  listed: boolean;
}

export type StateRead =
  | { state: "ok"; session: SessionState }
  /** No ordinary file in real folders, an open that failed, or not a `state.json`. */
  | { state: "none" }
  /** Over `MAX_STATE_BYTES`. */
  | { state: "too-large" };

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function ownNameOf(state: Record<string, unknown>, custom: Record<string, unknown>) {
  const { title, titleKind, isCustomTitle } = state;
  if (typeof title !== "string") return null;
  if (IMPORTED_KEYS.some((key) => key in custom)) return null;
  const set = titleKind === "custom" || titleKind === "generated" || isCustomTitle === true;
  return set ? title : null;
}

/** The kept fields of a `state.json`, or null when it is not a JSON object. A bad value in a field is treated as none. */
export function parseSessionState(content: string, platform: NodeJS.Platform): SessionState | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const custom = isRecord(value.custom) ? value.custom : {};
  return {
    folder: folderOf(value.cwd, platform),
    ownName: ownNameOf(value, custom),
    createdAt: numberOf(value.createdAt),
    updatedAt: numberOf(value.updatedAt),
    lastTurnFailed: value.lastTurnReason === "failed",
    listed: value.archived !== true && custom[CHILD_KIND_KEY] !== "child",
  };
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

export interface StateReader {
  /** What a session's `state.json` says, given its `lstat`, opened only when that changed. */
  read(place: SessionPlace, info: FileInfo): Promise<StateRead>;
  /** The `lstat` of a session's last read, or null with none remembered. */
  lastLook(sessionId: string): FileInfo | null;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

/** A reader of `state.json` files, which keeps what it read of each until it changes. */
export function createStateReader(
  home: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): StateReader {
  const remembered = new Map<string, { info: FileInfo; read: StateRead }>();

  async function readFile(place: SessionPlace): Promise<StateRead> {
    try {
      if (!(await stateFolderIsReal(home, place, io))) return { state: "none" };
      const handle = await io.openRegular(stateFilePath(home, place));
      try {
        const { size } = handle.info;
        if (size > MAX_STATE_BYTES) return { state: "too-large" };
        const bytes = await handle.read(0, size);
        const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
        const session = parseSessionState(text, platform);
        return session === null ? { state: "none" } : { state: "ok", session };
      } finally {
        await handle.close();
      }
    } catch {
      // Gone since its `lstat`, a link, a pipe or a folder at its name, or any
      // other failure: this is remembered like any read, so a file that could
      // not be opened is not tried again until it changes.
      return { state: "none" };
    }
  }

  return {
    async read(place, info) {
      const known = remembered.get(place.id);
      if (known && sameFile(known.info, info)) return known.read;
      const read = await readFile(place);
      remembered.set(place.id, { info, read });
      return read;
    },
    lastLook(sessionId) {
      return remembered.get(sessionId)?.info ?? null;
    },
    keepOnly(sessionIds) {
      for (const sessionId of remembered.keys()) {
        if (!sessionIds.has(sessionId)) remembered.delete(sessionId);
      }
    },
  };
}
