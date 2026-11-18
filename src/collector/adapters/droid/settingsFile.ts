import path from "node:path";

import { isMissing, type FileInfo, type ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { holdsToken } from "./sessionFile.ts";

/**
 * Whether a Droid session is archived, from the `<id>.settings.json` beside
 * its file. Built from Factory's Droid SDKs, droid-sdk 0.5.0 and
 * @factory/droid-sdk 0.11.0, and not yet checked on a computer running Droid.
 *
 * Both SDKs leave a session out of their lists when its settings file has an
 * `archivedAt` that is set, and keep it when the file is missing or cannot be
 * parsed (`_parse_session` in the Python SDK's `discovery.py`, and the
 * TypeScript SDK's `parseSessionFile`). The file also holds the session's
 * tags, which a person can write, its model and its token counts, so:
 *
 * - It is looked up with `lstat` on every poll, and opened only when its size,
 *   modified time or identity changes and it is `MAX_SETTINGS_BYTES` or less,
 *   read only, without following a link at its name and, in a project folder,
 *   only when that folder is a real folder. At most `MAX_SETTINGS_BYTES` and
 *   one byte are read, and a file that gives more is not parsed.
 * - Only a file that looks whole and holds `"archivedAt"` as bytes is turned
 *   into text and parsed, and only whether `archivedAt` is text that is not
 *   empty is kept.
 * - A file that is larger or a link leaves the session listed, and so does one
 *   that is missing, looks half written or does not parse, once it holds still
 *   for a poll. Until then it shows what it showed, as while Droid writes it.
 *
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The most of a settings file read. A larger one is not opened, and counts as not archived. */
export const MAX_SETTINGS_BYTES = 16 * 1024;

const SETTINGS_ENDING = ".settings.json";

const ARCHIVED_AT = Buffer.from('"archivedAt"');

const CLOSE = 0x7d;

/** The bytes JSON counts as space. */
const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0d, 0x0a]);

/** The settings file beside a session's file, in the same folder, named for its ID. */
export function settingsPathFor(sessionPath: string, id: string): string {
  return path.join(path.dirname(sessionPath), `${id}${SETTINGS_ENDING}`);
}

/** Whether a file's bytes end as a JSON object does, with `}` after any space. */
export function looksWhole(bytes: Buffer): boolean {
  let at = bytes.byteLength - 1;
  while (at >= 0 && WHITESPACE.has(bytes[at] as number)) at -= 1;
  return at >= 0 && bytes[at] === CLOSE;
}

/** Whether a file's bytes hold `"archivedAt"` as a key or a value. Nothing is turned into text. */
export function holdsArchivedAt(bytes: Buffer): boolean {
  return holdsToken(bytes, ARCHIVED_AT);
}

/**
 * Whether a parsed settings file marks its session archived: `archivedAt` is
 * text that is not empty, as the TypeScript SDK's schema has it. Undefined
 * when the text is not a JSON object.
 */
export function archivedIn(text: string): boolean | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { archivedAt } = value as Record<string, unknown>;
  return typeof archivedAt === "string" && archivedAt !== "";
}

export interface SettingsReader {
  /**
   * Whether the session whose settings file is at this path is archived,
   * opened only when it changed. Never rejects.
   */
  archived(settingsPath: string): Promise<boolean>;
  /** Forgets every settings file not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
}

interface Remembered {
  /** The file's `lstat` when it was last looked at, or "missing" when there was none. */
  seen: FileInfo | "missing";
  /** What it showed then. */
  shown: boolean;
  /** What the file as it was then holds, which it shows once it holds still. */
  holds: boolean;
}

function sameFile(a: FileInfo | "missing", b: FileInfo | "missing"): boolean {
  if (a === "missing" || b === "missing") return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** What a settings file holds: archived, not archived, or "unsure" when it is not whole or not JSON. */
type Holds = boolean | "unsure";

/** A reader of the settings files beside Droid's session files, which keeps only a yes or no for each. */
export function createSettingsReader(sessionsDir: string, io: ReadOnlyIo): SettingsReader {
  const remembered = new Map<string, Remembered>();

  /**
   * Notes what a file holds as it was seen, and gives what it shows. One that
   * is unsure, or that went, counts as not archived, but shows what it showed
   * until it holds still.
   */
  function note(
    target: string,
    known: Remembered | undefined,
    seen: FileInfo | "missing",
    holds: Holds,
  ): boolean {
    const settled = holds === true;
    const unsure = holds === "unsure" || seen === "missing";
    const shown = unsure && known?.shown === true ? true : settled;
    remembered.set(target, { seen, shown, holds: settled });
    return shown;
  }

  async function holdsOf(target: string, info: FileInfo): Promise<Holds> {
    const file = await io.openRegular(target);
    try {
      // Another file than the one its `lstat` found, as when it was replaced since.
      if (file.info.ino !== info.ino) throw new Error("The file was replaced.");
      if (file.info.size > MAX_SETTINGS_BYTES) return false;
      const bytes = asBuffer(await file.read(0, MAX_SETTINGS_BYTES + 1));
      if (bytes.byteLength > MAX_SETTINGS_BYTES) return false;
      if (!looksWhole(bytes)) return "unsure";
      if (!holdsArchivedAt(bytes)) return false;
      return archivedIn(bytes.toString("utf8")) ?? "unsure";
    } finally {
      await file.close();
    }
  }

  return {
    async archived(target) {
      const known = remembered.get(target);
      let seen: FileInfo | "missing";
      try {
        seen = await io.lstat(target);
      } catch (error) {
        // It could not be looked up: what it showed stands, and it is looked up again next poll.
        if (!isMissing(error)) return known?.shown ?? false;
        seen = "missing";
      }
      if (known && sameFile(known.seen, seen)) {
        // The file held still since it was looked at, so what it holds is what it shows.
        remembered.set(target, { ...known, shown: known.holds });
        return known.holds;
      }
      // None there, as for a moment while Droid writes one anew; a link, a
      // folder, a pipe or a device; or a file too large to be read.
      if (seen === "missing" || seen.kind !== "file" || seen.size > MAX_SETTINGS_BYTES) {
        return note(target, known, seen, false);
      }
      try {
        // A link at the folder's name would lead out of the sessions folder.
        // Not remembered: it says nothing of the file.
        const parent = path.dirname(target);
        if (parent !== sessionsDir && (await io.lstat(parent)).kind !== "directory") return false;
        return note(target, known, seen, await holdsOf(target, seen));
      } catch {
        // Gone since its `lstat`, replaced, or a read error: what it showed
        // stands, and it is read again next poll, since nothing here took note of it.
        return known?.shown ?? false;
      }
    },
    keepOnly(paths) {
      for (const file of remembered.keys()) if (!paths.has(file)) remembered.delete(file);
    },
  };
}
