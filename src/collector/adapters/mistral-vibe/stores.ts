import path from "node:path";

import {
  SUBAGENT_ID_PREFIX,
  VIBE_SESSION_ID,
} from "../../../core/mapping/mistral-vibe/mistralVibeMapping.ts";
import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { envelopeOf, isRecord, type Envelope } from "./envelope.ts";

/**
 * Reading Vibe's session stores, for the little this adapter needs.
 *
 * Vibe keeps each session in `<session folder>/unified/<session id>/`
 * (harness/.../vibe/_storage.py at 2.26.1, store format
 * `mistral.vibe.unified-session-store/v1`, minor 8). Every file there is JSON
 * with its keys sorted, replaced whole through a temporary file, never written
 * in place:
 *
 * - `CURRENT`, a few hundred bytes, names the session's newest generation, a
 *   folder of 16 digits under `generations/`. Vibe moves it on each time it
 *   saves the session whole: when a turn ends with nothing left running, and
 *   when the session's folder, model or settings change.
 * - `generations/<g>/manifest.json` names the files of that generation and
 *   the journal segment that records what happened since,
 *   `journal/<16 digits>.jsonl` (`journal.ts`).
 * - `generations/<g>/projection-state.json` holds the session's public state
 *   as it was when the generation was saved (`envelope.ts`).
 * - `generations/<g>/runtime-state.json` holds, with much else, the session's
 *   folder (`session_metadata.cwd`), whether it is a session of its own, a
 *   fork or a subagent (`identity.kind`) and whether it is being deleted
 *   (`lifecycle.type`). Only those three are kept.
 *
 * A generation's files are written once and never change, so each is read
 * once while the adapter follows the session, when `CURRENT` names a new one.
 * A session it stops following and finds again is read afresh. Vibe keeps
 * only the two newest generations, so one can go between reading `CURRENT`
 * and reading its files. `CURRENT` is then read once more, as Vibe's own
 * readers do, and if that fails too, what was read before stands until the
 * next poll.
 *
 * Nothing else in a store is opened: not `checkpoint.json`, which holds the
 * whole conversation, nor `chunks/`, `attachments/`, `processes/`,
 * `quarantine/`, the sidecar `meta.json`, or `unified/.session-index.json`.
 */
export const STORE_DIR = "unified";

/** The only store format this adapter knows. */
export const STORE_FORMAT = "mistral.vibe.unified-session-store/v1";

/**
 * The newest minor of that format this adapter knows, Vibe 2.26.1's. Vibe's
 * own readers refuse a store of a higher minor, so this adapter shows its
 * sessions without a status.
 */
export const KNOWN_STORE_MINOR = 8;

/** The most of each file read. Vibe allows any of them 64 MiB, and writes far less. */
export const CURRENT_LIMIT_BYTES = 4 * 1024;
export const MANIFEST_LIMIT_BYTES = 256 * 1024;
export const PROJECTION_LIMIT_BYTES = 4 * 1024 * 1024;
export const RUNTIME_LIMIT_BYTES = 8 * 1024 * 1024;

const CURRENT = "CURRENT";
const GENERATIONS = "generations";
const JOURNAL = "journal";
const MANIFEST = "manifest.json";

/** A generation: 16 digits. */
const GENERATION = /^[0-9]{16}$/;

/** A journal segment's path, relative to its store, as a manifest names it. */
const JOURNAL_PATH = /^journal\/[0-9]{16}\.jsonl$/;

/**
 * The two files of a generation this adapter opens, by the names Vibe always
 * gives them. A manifest that names any other file for them, such as
 * `checkpoint.json`, names nothing this adapter opens.
 */
const PROJECTION_FILE = "projection-state.json";
const RUNTIME_FILE = "runtime-state.json";

/**
 * A folder the older engine wrote a session to, `<prefix>_<YYYYmmdd>_<HHMMSS>_<id[:8]>`
 * (vibe/core/session/session_logger.py). Its prefix is `session` unless set.
 */
const LEGACY_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9]{8}_[0-9]{6}_[A-Za-z0-9_-]{1,8}$/;

/** What is kept of one session's store. */
export interface Store {
  generation: string;
  /** True when the store's minor is above the one this adapter knows: its status is not shown. */
  tooNew: boolean;
  /** The journal segment the manifest names, relative to the store, or null when it names none that could be right. */
  journal: string | null;
  /** The public state when the generation was saved. Null when it could not be read. */
  snapshot: Envelope | null;
  /** The session's folder. */
  cwd: string | null;
  /** `root`, `fork` or `subagent`. Null when it could not be read. */
  kind: string | null;
  /** True while Vibe deletes the session and its subagents. */
  deleting: boolean;
}

export type StoreRead =
  /** No `CURRENT`: a session not saved yet, one deleted, or no store at all. */
  | { state: "missing" }
  /** A `CURRENT` this adapter cannot read: another store format, another session's, or no generation. */
  | { state: "invalid" }
  /** It could not be read this time, and was never read before. */
  | { state: "unreadable" }
  | { state: "ok"; store: Store; current: FileInfo };

/** Whether a name in `unified/` can be a session's own store: not hidden, not a subagent's. */
export function isStoreName(name: string): boolean {
  return (
    !name.startsWith(".") && !name.startsWith(SUBAGENT_ID_PREFIX) && VIBE_SESSION_ID.test(name)
  );
}

class Unreadable extends Error {}

/** A whole file, no larger than `limit`, as text. */
async function readWhole(io: ReadOnlyIo, file: string, limit: number): Promise<string> {
  const handle = await io.openRegular(file);
  try {
    const { size } = handle.info;
    if (size > limit) throw new Unreadable(`Larger than ${limit} bytes.`);
    const bytes = await handle.read(0, size);
    if (bytes.byteLength !== size) throw new Unreadable("The file changed while it was read.");
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** A whole file, no larger than `limit`, as a JSON object. Throws when it is not one. */
async function readObject(
  io: ReadOnlyIo,
  file: string,
  limit: number,
): Promise<Record<string, unknown>> {
  const text = await readWhole(io, file, limit);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Unreadable("Not JSON.");
  }
  if (!isRecord(value)) throw new Unreadable("Not a JSON object.");
  return value;
}

/** What `CURRENT` says. */
export interface Pointer {
  generation: string;
  minor: number;
}

/**
 * What a `CURRENT` file says, or null when it is not one of this store
 * format, names another session, or names no generation. Its minor is 1 when
 * it gives none, as Vibe reads it.
 */
export function readPointer(value: unknown, sessionId: string): Pointer | null {
  if (!isRecord(value)) return null;
  if (value.store_format !== STORE_FORMAT || value.session_id !== sessionId) return null;
  if (typeof value.generation !== "string" || !GENERATION.test(value.generation)) return null;
  const minor = value.store_format_minor ?? 1;
  if (typeof minor !== "number" || !Number.isSafeInteger(minor) || minor < 1) return null;
  return { generation: value.generation, minor };
}

/** A short word, such as a kind. */
function word(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : null;
}

/** A folder's path, when it is text that could be one. */
function folder(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 4096 ? value : null;
}

/** The file of a generation a manifest names, when it is the one expected. */
function generationFile(
  manifest: Record<string, unknown>,
  key: string,
  expected: string,
): string | null {
  const record = manifest[key];
  return isRecord(record) && record.path === expected ? expected : null;
}

/** Whether an error says a file is not there: a generation that went while it was read. */
function wentAway(error: unknown): boolean {
  return isMissing(error);
}

interface Cached {
  current: FileInfo;
  store: Store;
}

export interface StoreReader {
  /** What one session's store holds, read only as far as `CURRENT` moved since the last read. */
  read(sessionId: string): Promise<StoreRead>;
  /** Forgets every session not in this set. */
  keepOnly(sessionIds: ReadonlySet<string>): void;
}

/** A reader of the stores in `unified/`, which keeps what it read of each until it changes. */
export function createStoreReader(storesDir: string, io: ReadOnlyIo): StoreReader {
  const cache = new Map<string, Cached>();

  /** The files of one generation, read whole. Throws as reading them does. */
  async function readGeneration(root: string, sessionId: string, pointer: Pointer) {
    const dir = path.join(root, GENERATIONS, pointer.generation);
    const manifest = await readObject(io, path.join(dir, MANIFEST), MANIFEST_LIMIT_BYTES);
    if (manifest.session_id !== sessionId || manifest.generation !== pointer.generation) {
      throw new Unreadable("The manifest is another generation's.");
    }
    const segment = isRecord(manifest.recovery_journal_segment)
      ? manifest.recovery_journal_segment.path
      : undefined;
    const journal = typeof segment === "string" && JOURNAL_PATH.test(segment) ? segment : null;

    let snapshot: Envelope | null = null;
    const projectionFile = generationFile(manifest, "projection_state", PROJECTION_FILE);
    if (projectionFile !== null) {
      try {
        const projection = await readObject(
          io,
          path.join(dir, projectionFile),
          PROJECTION_LIMIT_BYTES,
        );
        if (projection.session_id === sessionId) snapshot = envelopeOf(projection.snapshot);
      } catch (error) {
        if (wentAway(error)) throw error;
      }
    }

    let cwd: string | null = null;
    let kind: string | null = null;
    let deleting = false;
    const runtimeFile = generationFile(manifest, "runtime_state", RUNTIME_FILE);
    if (runtimeFile !== null) {
      try {
        const runtime = await readObject(io, path.join(dir, runtimeFile), RUNTIME_LIMIT_BYTES);
        if (runtime.session_id === sessionId) {
          const metadata = isRecord(runtime.session_metadata) ? runtime.session_metadata : {};
          const identity = isRecord(runtime.identity) ? runtime.identity : {};
          const lifecycle = isRecord(runtime.lifecycle) ? runtime.lifecycle : {};
          cwd = folder(metadata.cwd);
          kind = word(identity.kind);
          deleting = lifecycle.type === "deleting_tree";
        }
      } catch (error) {
        if (wentAway(error)) throw error;
      }
    }

    return { journal, snapshot, cwd, kind, deleting };
  }

  /** `CURRENT`, read whole. Null when it says nothing this adapter can read. */
  async function readCurrent(root: string, sessionId: string): Promise<Pointer | null> {
    let value: Record<string, unknown>;
    try {
      value = await readObject(io, path.join(root, CURRENT), CURRENT_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof Unreadable) return null;
      throw error;
    }
    return readPointer(value, sessionId);
  }

  async function read(sessionId: string): Promise<StoreRead> {
    const root = path.join(storesDir, sessionId);
    const cached = cache.get(sessionId);

    let current: FileInfo;
    try {
      current = await io.lstat(path.join(root, CURRENT));
    } catch (error) {
      if (isMissing(error)) {
        cache.delete(sessionId);
        return { state: "missing" };
      }
      return cached ? { state: "ok", store: cached.store, current: cached.current } : unreadable();
    }
    if (current.kind !== "file") {
      cache.delete(sessionId);
      return { state: "missing" };
    }
    if (
      cached &&
      cached.current.ino === current.ino &&
      cached.current.size === current.size &&
      cached.current.mtimeMs === current.mtimeMs
    ) {
      return { state: "ok", store: cached.store, current };
    }

    try {
      // A store reached through a link is not one Vibe would use.
      const own = await io.lstat(root);
      if (own.kind !== "directory") {
        cache.delete(sessionId);
        return { state: "missing" };
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const pointer = await readCurrent(root, sessionId);
        if (pointer === null) {
          cache.delete(sessionId);
          return { state: "invalid" };
        }
        const tooNew = pointer.minor > KNOWN_STORE_MINOR;
        if (cached && cached.store.generation === pointer.generation && !tooNew) {
          cache.set(sessionId, { current, store: cached.store });
          return { state: "ok", store: cached.store, current };
        }
        try {
          const store: Store = {
            generation: pointer.generation,
            tooNew,
            ...(await readGeneration(root, sessionId, pointer)),
          };
          cache.set(sessionId, { current, store });
          return { state: "ok", store, current };
        } catch (error) {
          // A newer Vibe's generation may not read as this one's does. It is
          // shown without a status, and with no name or folder.
          if (tooNew && !wentAway(error)) {
            const store: Store = {
              generation: pointer.generation,
              tooNew,
              journal: null,
              snapshot: null,
              cwd: null,
              kind: null,
              deleting: false,
            };
            cache.set(sessionId, { current, store });
            return { state: "ok", store, current };
          }
          // The generation went as it was read: `CURRENT` has moved on. It is
          // read once more. Anything else is a generation this adapter cannot read.
          if (!wentAway(error)) break;
        }
      }
    } catch {
      // Not readable this time.
    }
    // What was read before stands until the next poll.
    return cached ? { state: "ok", store: cached.store, current: cached.current } : unreadable();
  }

  function unreadable(): StoreRead {
    return { state: "unreadable" };
  }

  return {
    read,
    keepOnly(sessionIds) {
      for (const id of cache.keys()) {
        if (!sessionIds.has(id)) cache.delete(id);
      }
    },
  };
}

/** A segment's name in a store's `journal/`: 16 digits. */
const SEGMENT = /^[0-9]{16}\.jsonl$/;

/**
 * When Vibe last wrote to a session's store: the later of the modified times
 * of its `CURRENT` and of the segments in its `journal/`, which Vibe keeps two
 * of. A rename is journaled with no save after it, so the journal can be
 * newer than `CURRENT`. Two `lstat`s, a listing of `journal/` and an `lstat`
 * for each segment. Nothing is opened. Null when there is no store there that
 * can be looked at: no folder, a link, or no `CURRENT`.
 */
export async function storeWrittenAt(
  storesDir: string,
  sessionId: string,
  io: ReadOnlyIo,
): Promise<number | null> {
  const root = path.join(storesDir, sessionId);
  let newest: number;
  try {
    if ((await io.lstat(root)).kind !== "directory") return null;
    const current = await io.lstat(path.join(root, CURRENT));
    if (current.kind !== "file") return null;
    newest = current.mtimeMs;
  } catch {
    // Gone, or not readable: not a store this time.
    return null;
  }
  let names: string[] = [];
  try {
    names = await io.readdir(path.join(root, JOURNAL));
  } catch {
    // No journal yet, or one that cannot be listed: `CURRENT`'s time stands.
  }
  for (const name of names.filter((each) => SEGMENT.test(each))) {
    try {
      const segment = await io.lstat(path.join(root, JOURNAL, name));
      if (segment.kind === "file") newest = Math.max(newest, segment.mtimeMs);
    } catch {
      // Gone between the listing and the look.
    }
  }
  return newest;
}

/** What a look through `unified/` found: the store of each session, with when Vibe last wrote to it. */
export type StoreScan =
  { state: "ok"; written: Map<string, number> } | { state: "missing" | "unreadable" };

/**
 * Every session's store in `unified/`, with when Vibe last wrote to it
 * (`storeWrittenAt`): one listing, and a few looks at each store. Hidden
 * names, such as Vibe's own `.session-index.json`, subagents' stores, names
 * that are not session ids, links and stores with no `CURRENT` are left out.
 */
export async function scanStores(storesDir: string, io: ReadOnlyIo): Promise<StoreScan> {
  let names: string[];
  try {
    names = await io.readdir(storesDir);
  } catch (error) {
    return { state: isMissing(error) ? "missing" : "unreadable" };
  }
  const written = new Map<string, number>();
  for (const name of names.filter(isStoreName).sort()) {
    const at = await storeWrittenAt(storesDir, name, io);
    if (at !== null) written.set(name, at);
  }
  return { state: "ok", written };
}

/**
 * When the older engine saved a session in the session folder at `since` or
 * later, from the modified times of its folders,
 * `<prefix>_<YYYYmmdd>_<HHMMSS>_<id>`: Vibe replaces a folder's `meta.json`
 * each time it saves, which moves the folder's time on. The folders are
 * looked at newest-named first, and the look stops at the first one saved
 * since then. Null when none was. Nothing inside a folder is read.
 */
export async function legacyWrittenSince(
  sessionDir: string,
  io: ReadOnlyIo,
  since: number,
): Promise<number | null> {
  let names: string[];
  try {
    names = await io.readdir(sessionDir);
  } catch {
    return null;
  }
  for (const name of names
    .filter((each) => LEGACY_FOLDER.test(each))
    .sort()
    .reverse()) {
    try {
      const info = await io.lstat(path.join(sessionDir, name));
      if (info.kind === "directory" && info.mtimeMs >= since) return info.mtimeMs;
    } catch {
      // Gone between the listing and the look.
    }
  }
  return null;
}
