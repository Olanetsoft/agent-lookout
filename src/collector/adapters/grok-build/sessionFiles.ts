import path from "node:path";

import { sessionName } from "../../../core/text.ts";
import type { FileInfo, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { isMissing } from "../../files/readOnlyIo.ts";
import {
  bytesAt,
  isWholeObject,
  literalOf,
  topKey,
  valueAfter,
} from "../autohand-code/jsonBytes.ts";
import { trustedFile } from "./folders.ts";

/**
 * Reading two small files in a Grok Build session's folder: `summary.json`,
 * for a title the person set, and `plan_mode.json`, for whether a plan waits
 * for their approval. Built from Grok Build's source at 1.0.45 (commit
 * 2bdd1d6) and not yet checked on a machine running it.
 *
 * Grok Build writes both with serde's pretty printer
 * (`xai-grok-shell/src/session/storage/jsonl/mod.rs:766`, `:1457-1465`,
 * `summary_write.rs:466`): a
 * line break and two spaces before each key of the outer object, four or more
 * before one inside it, and a line break inside a string only as `\n`. So a
 * line break, two spaces and `"<key>": ` begin a key of the outer object and
 * nothing else (`../autohand-code/jsonBytes.ts`). A file written another way,
 * as an import writes its client's own JSON, has no such bytes, and its fields
 * are not known, never wrong.
 *
 * - `summary.json` holds the session's title, `generated_title`, and
 *   `title_is_manual`, written only when it is true. Its other fields, the
 *   summaries a model wrote of the conversation, its git remotes, branch and
 *   the rest, are never looked at. The title is read only when
 *   `title_is_manual` is true, as `/rename` sets it
 *   (`xai-grok-shell/src/session/storage/summary_write.rs:198-201`): a title
 *   Grok Build made can be the first ten words of the first prompt, with no
 *   mark (`xai-grok-shell/src/session/helpers/session_summary.rs:174-186`,
 *   `:255`). It is read as one JSON string of at most 1 KiB, alone, and
 *   cleaned and cut as every name is.
 * - `plan_mode.json` holds `awaiting_plan_approval`, true while the person is
 *   shown a plan to approve and has not answered
 *   (`xai-grok-shell/src/session/plan_mode.rs:56-66`). Only that `true` or
 *   `false` is kept, with the file's modified time.
 *
 * Each is looked at with `lstat` every poll and read only when its size,
 * modified time or identity changed, opened without following a link, only as
 * an ordinary file with one name of the user Agent Lookout runs as, at most
 * 1 MiB for `summary.json` and 64 KiB for `plan_mode.json`, and only when it
 * is a whole object, `{` to `}`. A read that fails is never kept. Nothing here
 * writes, renames, locks or deletes anything, and `summary.json.lock` and the
 * temporary files beside them are never opened.
 */

export const SUMMARY_FILE = "summary.json";
export const PLAN_FILE = "plan_mode.json";

/** The largest `summary.json` read. */
export const MAX_SUMMARY_BYTES = 1_048_576;

/** The largest `plan_mode.json` read. */
export const MAX_PLAN_BYTES = 64 * 1024;

/** The longest title read, in bytes. Grok Build allows 100 characters (`persistence.rs:52-54`). */
const MAX_TITLE_BYTES = 1_024;

const MANUAL = Buffer.from('\n  "title_is_manual": true');
const TITLE = topKey("generated_title");
const AWAITING = topKey("awaiting_plan_approval");
const TRUE = Buffer.from("true");
const FALSE = Buffer.from("false");

const COMMA = 0x2c;
const NEWLINE = 0x0a;

/** Whether `at` holds one of the bytes that can follow a value of the outer object. */
const endsValue = (bytes: Buffer, at: number) => bytes[at] === COMMA || bytes[at] === NEWLINE;

/** The title a `summary.json` marks as set by the person, cleaned and cut, or null. */
export function titleOf(bytes: Buffer): string | null {
  if (!isWholeObject(bytes)) return null;
  let manual = false;
  for (let at = bytes.indexOf(MANUAL); at >= 0; at = bytes.indexOf(MANUAL, at + 1)) {
    if (endsValue(bytes, at + MANUAL.byteLength)) {
      manual = true;
      break;
    }
  }
  if (!manual) return null;
  const text = literalOf(bytes, valueAfter(bytes, TITLE), MAX_TITLE_BYTES);
  return text === null ? null : (sessionName(text) ?? null);
}

/** What a `plan_mode.json` says of a plan waiting: true, false, or null when it is not a whole object. */
export function planWaitsIn(bytes: Buffer): boolean | null {
  if (!isWholeObject(bytes)) return null;
  const at = valueAfter(bytes, AWAITING);
  // Without the field the file is an older Grok Build's, which reads it as false.
  if (at < 0) return false;
  if (bytesAt(bytes, at, TRUE) && endsValue(bytes, at + TRUE.byteLength)) return true;
  if (bytesAt(bytes, at, FALSE) && endsValue(bytes, at + FALSE.byteLength)) return false;
  return null;
}

/** What a session's `plan_mode.json` says now. */
export type PlanRead =
  | { state: "ok"; waits: boolean; writtenAt: number }
  /** No file, which is no plan waiting. */
  | { state: "missing" }
  /** One that could not be read, is over the limit, is not an ordinary file of this user's, or not a whole object. */
  | { state: "unknown" };

interface Remembered<T> {
  folder: string;
  info: FileInfo;
  value: T;
}

const sameFile = (a: FileInfo, b: FileInfo) =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export interface SessionFilesOptions {
  io: ReadOnlyIo;
  platform: NodeJS.Platform;
  euid: number | null;
}

export interface SessionFiles {
  /** The title a session's `summary.json` marks as set by the person, or null. */
  title(sessionId: string, folder: string): Promise<string | null>;
  /** What a session's `plan_mode.json` says of a plan waiting. */
  plan(sessionId: string, folder: string): Promise<PlanRead>;
  /** Forgets every session not in this set. */
  keepOnly(ids: ReadonlySet<string>): void;
  /** How many sessions it keeps a read of, for the tests that check none is kept once its session has gone. */
  readonly kept: number;
}

/** A reader of both files, which keeps what it read of each until it changes. */
export function createSessionFiles(options: SessionFilesOptions): SessionFiles {
  const { io, platform, euid } = options;
  const titles = new Map<string, Remembered<string | null>>();
  const plans = new Map<string, Remembered<{ waits: boolean | null; writtenAt: number }>>();

  /**
   * What `parse` makes of a file, read when it changed, or why there is
   * nothing: no file, or one this would not read or could not. Only a read
   * that worked is kept.
   */
  async function readOne<T>(
    kept: Map<string, Remembered<T>>,
    sessionId: string,
    folder: string,
    name: string,
    max: number,
    parse: (bytes: Buffer, writtenAt: number) => T,
  ): Promise<{ state: "ok"; value: T } | { state: "missing" } | { state: "unknown" }> {
    const file = path.join(folder, name);
    let looked: FileInfo;
    try {
      looked = await io.lstat(file);
    } catch (error) {
      kept.delete(sessionId);
      return isMissing(error) ? { state: "missing" } : { state: "unknown" };
    }
    // Checked before what was read is reused: a second name or another owner
    // leaves the size, time and identity as they were.
    if (!trustedFile(looked, platform, euid) || looked.size > max) return { state: "unknown" };
    const known = kept.get(sessionId);
    if (known && known.folder === folder && sameFile(known.info, looked)) {
      return { state: "ok", value: known.value };
    }
    try {
      const handle = await io.openRegular(file);
      try {
        const { info } = handle;
        if (!trustedFile(info, platform, euid) || info.size > max) return { state: "unknown" };
        const data = await handle.read(0, info.size);
        if (data.byteLength !== info.size) return { state: "unknown" };
        const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        // The time the file had as it was opened, and never one before its `lstat`'s.
        const value = parse(bytes, Math.max(looked.mtimeMs, info.mtimeMs));
        kept.set(sessionId, { folder, info, value });
        return { state: "ok", value };
      } finally {
        await handle.close().catch(() => {});
      }
    } catch {
      return { state: "unknown" };
    }
  }

  return {
    async title(sessionId, folder) {
      const read = await readOne(
        titles,
        sessionId,
        folder,
        SUMMARY_FILE,
        MAX_SUMMARY_BYTES,
        titleOf,
      );
      return read.state === "ok" ? read.value : null;
    },
    async plan(sessionId, folder) {
      const read = await readOne(
        plans,
        sessionId,
        folder,
        PLAN_FILE,
        MAX_PLAN_BYTES,
        (bytes, at) => ({
          waits: planWaitsIn(bytes),
          writtenAt: at,
        }),
      );
      if (read.state === "missing") return { state: "missing" };
      if (read.state === "unknown" || read.value.waits === null) return { state: "unknown" };
      return { state: "ok", waits: read.value.waits, writtenAt: read.value.writtenAt };
    },
    keepOnly(ids) {
      for (const id of titles.keys()) if (!ids.has(id)) titles.delete(id);
      for (const id of plans.keys()) if (!ids.has(id)) plans.delete(id);
    },
    get kept() {
      return new Set([...titles.keys(), ...plans.keys()]).size;
    },
  };
}
