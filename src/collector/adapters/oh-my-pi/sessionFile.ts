import path from "node:path";

import { QUIET_MS } from "../../../core/mapping/oh-my-pi/ohMyPiMapping.ts";
import { WRITE_TIME_STEP_MS } from "../../../core/time.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { bytesAt, literalOf } from "../autohand-code/jsonBytes.ts";
import { MAX_HEAD_BYTES, parseHeader } from "../pi/sessionFile.ts";
import type { SessionFileRef } from "../pi/sessionFiles.ts";
import { ownCopy, readFromEnd, readOnwards, viewOf, type Tail, type TailView } from "./tail.ts";

/**
 * Reading the little this adapter needs from an Oh My Pi session file. Built
 * from Oh My Pi's source at v19.0.0 and not yet checked on a computer running
 * it.
 *
 * Each session is one JSONL file (docs/session.md:65-69). Its first line is a
 * title slot of exactly 256 bytes with its line break,
 * `{"type":"title","v":1,"title":"…","source":"auto"|"user","updatedAt":"…",
 * "pad":"…"}`, with no `source` while no title is set
 * (packages/coding-agent/src/session/session-title-slot.ts:21-59, :111-122;
 * session-entries.ts:19-35). Oh My Pi rewrites it in place when the title
 * changes (session-storage.ts:1054-1071). Its second line is the header, as
 * Pi's, at version 3 (session-entries.ts:17, session-manager.ts:2091-2100),
 * and the entries follow, one a line (`tail.ts`). So:
 *
 * - The slot, bytes 0 to 255, is read each time the file changes, and again
 *   on each poll until two reads in a row gave the same bytes, the later at
 *   least 2 seconds after the file's modified time, as a disk can keep a
 *   write's time rounded down. Its title is shown only once two reads in a row
 *   agree, as a read made while Oh My Pi rewrites it can catch half of each.
 *   The title is turned into text only when the bytes after it say it was set
 *   by the person (`user`) or by a model (`auto`), and for `auto` only when
 *   the session is not one Oh My Pi made from a Codex session, whose title
 *   can be the first prompt typed in Codex: its third line begins
 *   `{"type":"<word>","id":"codex-<number>",` (codex-session-store.ts:620,
 *   :670), and Oh My Pi's own IDs never begin so (session-migrations.ts:5-11).
 *   A slot read that is not one Oh My Pi writes keeps the title from before.
 * - The `MAX_HEAD_BYTES` and `LINE3_BYTES` after the slot, or as many as the
 *   file holds, are read in one piece when the file's identity changes, and
 *   on each change until a header is found. Of them, the header, from byte
 *   256 to its line break within `MAX_HEAD_BYTES`, is turned into text and
 *   parsed. Only its `id`, `timestamp`, `cwd` and `version` are kept, by Pi's
 *   `parseHeader`, with Oh My Pi's newest version. Everything else in it, its
 *   own copy of the title among them, is dropped with the parsed line.
 * - Of the rest, only the first `LINE3_BYTES` of the third line are compared
 *   as bytes, for the Codex check alone, and the rest is dropped. Once a
 *   header is known, while those bytes are too few to tell, the
 *   `LINE3_BYTES` at `line3At`, where the third line begins, are read again
 *   alone each time the slot is read, and compared the same way.
 * - A file whose first 256 bytes are not a title slot is not a session this
 *   reads: an Oh My Pi file from before v16.5.2, which began with its
 *   header, or a Pi file in a folder both keep. Nothing of it is turned into
 *   text.
 *
 * A file is opened only when its size, modified time or identity changes, or
 * while its slot is not settled, read only, without following a link at its
 * name and, in a project folder, only when that folder is a real folder. Its
 * modified time is the open file's, when that is later than its `lstat`'s.
 * Nothing here writes, renames, deletes or locks anything.
 */

/** The title slot's size, its line break included (session-entries.ts:19). */
export const SLOT_BYTES = 256;

/** The newest format this reads (session-entries.ts:17). A higher one is a newer Oh My Pi's. */
export const OMP_SESSION_VERSION = 3;

/** The most of the third line compared, for the Codex check. */
export const LINE3_BYTES = 64;

const NEWLINE = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SPACE = 0x20;

const SLOT_START = Buffer.from('{"type":"title","v":1,"title":');
const SLOT_END = Buffer.from('"}\n');
const SOURCE_USER = Buffer.from(',"source":"user"');
const SOURCE_AUTO = Buffer.from(',"source":"auto"');
const UPDATED_AT = Buffer.from(',"updatedAt":"');
const PAD = Buffer.from('","pad":"');
const CODEX_TYPE = Buffer.from('{"type":"');
const CODEX_ID = Buffer.from('","id":"codex-');

/** The longest time read in the slot. Oh My Pi writes 24 bytes. */
const MAX_TIME_BYTES = 40;

/** A leading icon Oh My Pi's title card puts before a title: up to 8 code points of a font's own, and a space (utils/title-card.ts:43, :49-56, :102-104). */
const LEADING_ICON = /^\p{Co}{1,8} /u;

/** The kept fields of a header. */
export interface OmpHeader {
  id: string;
  /** The session's folder: an absolute path, or null when the header's is not one. */
  cwd: string | null;
  /** `timestamp` in epoch milliseconds, or null when it is not a time. */
  startedAt: number | null;
}

/** What one session file shows. */
export interface OmpSessionFile extends OmpHeader {
  /** The title to show, or null for none. */
  title: string | null;
  /** What its newest lines say: never `none`, as a file none of whose lines decides, with no approval that waits, is not shown. */
  tail: Exclude<TailView, { state: "none" }>;
}

export type OmpFileRead =
  | {
      state: "ok";
      file: OmpSessionFile;
      /** Its modified time as it was opened for this, never before its `lstat`'s. */
      writtenAt: number;
      /**
       * The open file's identity, size and time its lines were read at, which can be later than its
       * `lstat`'s, or this poll's `lstat` when the file could not be read again after that changed.
       */
      info: FileInfo;
      /** False when the file changed since what it shows was read and could not be read again. */
      current: boolean;
    }
  /** No session yet: gone, not in a real folder, not whole, or with no line that decides and no approval that waits. */
  | { state: "none" }
  /** Not a session file this reads: no title slot, or no header it reads. */
  | { state: "other" }
  /** Of a newer format than this reads. */
  | { state: "newer" };

const isDigitOrTime = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x30 && byte <= 0x39) ||
    byte === 0x3a ||
    byte === 0x2e ||
    byte === 0x54 ||
    byte === 0x5a ||
    byte === 0x2b ||
    byte === 0x2d);

/** Whether the bytes have the frame every title slot has, whatever its title. */
export function isSlot(slot: Buffer): boolean {
  return (
    slot.byteLength === SLOT_BYTES &&
    bytesAt(slot, 0, SLOT_START) &&
    bytesAt(slot, SLOT_BYTES - SLOT_END.byteLength, SLOT_END)
  );
}

/** What a slot says, from its bytes. */
export type SlotRead =
  /** A slot Oh My Pi writes: its title and who set it, without the title's text. */
  | { state: "ok"; source: "user" | "auto" | null; titleAt: number }
  /** Not one Oh My Pi writes, as a read that caught a rewrite half done can be. */
  | { state: "unread" };

/**
 * A slot's shape, compared as bytes: the title, as one JSON string, then
 * perhaps who set it, then `updatedAt` and the spaces that pad it to its
 * 256th byte. Nothing is turned into text.
 */
export function slotShape(slot: Buffer): SlotRead {
  if (!isSlot(slot)) return { state: "unread" };
  const titleAt = SLOT_START.byteLength;
  if (slot[titleAt] !== QUOTE) return { state: "unread" };
  let end = titleAt + 1;
  while (end < SLOT_BYTES && slot[end] !== QUOTE) {
    const byte = slot[end] as number;
    if (byte < SPACE) return { state: "unread" };
    end += byte === BACKSLASH ? 2 : 1;
  }
  if (end >= SLOT_BYTES) return { state: "unread" };
  let cursor = end + 1;
  let source: "user" | "auto" | null = null;
  if (bytesAt(slot, cursor, SOURCE_USER)) source = "user";
  else if (bytesAt(slot, cursor, SOURCE_AUTO)) source = "auto";
  if (source !== null) cursor += SOURCE_USER.byteLength;
  if (!bytesAt(slot, cursor, UPDATED_AT)) return { state: "unread" };
  cursor += UPDATED_AT.byteLength;
  const timeStart = cursor;
  while (
    cursor < SLOT_BYTES &&
    cursor - timeStart < MAX_TIME_BYTES &&
    isDigitOrTime(slot[cursor])
  ) {
    cursor += 1;
  }
  if (cursor === timeStart || !bytesAt(slot, cursor, PAD)) return { state: "unread" };
  cursor += PAD.byteLength;
  const padEnd = SLOT_BYTES - SLOT_END.byteLength;
  while (cursor < padEnd && slot[cursor] === SPACE) cursor += 1;
  return cursor === padEnd ? { state: "ok", source, titleAt } : { state: "unread" };
}

/**
 * The title a slot holds, as text, when it was set by the person, or by a
 * model in a session that is not a Codex session's copy, else null.
 * Undefined when the slot is not one Oh My Pi writes. A leading icon of
 * Oh My Pi's title card is dropped.
 */
export function slotTitle(slot: Buffer, codex: boolean | null): string | null | undefined {
  const shape = slotShape(slot);
  if (shape.state !== "ok") return undefined;
  if (shape.source === null || (shape.source === "auto" && codex !== false)) return null;
  const title = literalOf(slot, shape.titleAt, SLOT_BYTES);
  if (title === null) return undefined;
  return title.replace(LEADING_ICON, "");
}

const isWordByte = (byte: number | undefined) =>
  byte !== undefined &&
  ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x5f);
const isBase36Byte = (byte: number | undefined) =>
  byte !== undefined && ((byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39));

/**
 * Whether a third line is a Codex session's copy's, from its first bytes:
 * `{"type":"<word>","id":"codex-<base 36>",`. Null while the bytes end before
 * that can be told, as when the line is not yet written.
 */
export function codexImport(line: Buffer): boolean | null {
  const newline = line.indexOf(NEWLINE);
  const bytes = newline < 0 ? line : line.subarray(0, newline);
  const whole = newline >= 0 || line.byteLength >= LINE3_BYTES;
  const short = whole ? false : null;
  const prefix = (at: number, word: Buffer): boolean | null => {
    const shared = Math.min(word.byteLength, bytes.byteLength - at);
    for (let index = 0; index < shared; index += 1) {
      if (bytes[at + index] !== word[index]) return false;
    }
    return shared === word.byteLength ? true : short;
  };
  const start = prefix(0, CODEX_TYPE);
  if (start !== true) return start;
  let at = CODEX_TYPE.byteLength;
  while (at < bytes.byteLength && isWordByte(bytes[at])) at += 1;
  if (at === CODEX_TYPE.byteLength) return at < bytes.byteLength ? false : short;
  const id = prefix(at, CODEX_ID);
  if (id !== true) return id;
  const numberAt = at + CODEX_ID.byteLength;
  at = numberAt;
  while (at < bytes.byteLength && isBase36Byte(bytes[at])) at += 1;
  if (at === numberAt) return at < bytes.byteLength ? false : short;
  return prefix(at, Buffer.from('",'));
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function sameFile(a: FileInfo, b: FileInfo): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** What is kept of one file between polls. */
interface Known {
  /** The open file's size, time and identity as it was last read. */
  info: FileInfo;
  verdict: "ok" | "none" | "other" | "newer";
  header: OmpHeader | null;
  /** Where the third line begins, and what the Codex check said of it. */
  line3At: number;
  codex: boolean | null;
  /** The bytes of the slot as last read. */
  slot: Buffer | null;
  /** The title shown, and the bytes and Codex answer it was taken from. */
  title: string | null;
  titleFrom: { slot: Buffer; codex: boolean | null } | null;
  /** Whether the slot holds still: two reads in a row agreed, late enough after the last write. */
  settled: boolean;
  /** When it was last read, on the clock then. */
  readAt: number;
  tail: Tail | null;
}

export interface OmpSessionReader {
  /** What a session file shows, given its `lstat`, opened only when that changed or its slot is not settled. */
  read(ref: SessionFileRef, now: number): Promise<OmpFileRead>;
  /** Forgets every file not in this set. */
  keepOnly(paths: ReadonlySet<string>): void;
  /** How many files it keeps, for the tests that check none is kept once it has gone. */
  readonly kept: number;
}

class Replaced extends Error {}

/** A reader of Oh My Pi's session files, which keeps what it read of each until it changes. */
export function createOmpSessionReader(
  sessionsDir: string,
  io: ReadOnlyIo,
  platform: NodeJS.Platform,
): OmpSessionReader {
  const remembered = new Map<string, Known>();

  function answer(
    known: Known,
    writtenAt: number,
    info: FileInfo = known.info,
    current = true,
  ): OmpFileRead {
    if (known.verdict !== "ok" || known.header === null || known.tail === null) {
      return { state: known.verdict === "ok" ? "none" : known.verdict };
    }
    const tail = viewOf(known.tail, known.info.size);
    if (tail.state === "none") return { state: "none" };
    return {
      state: "ok",
      file: { ...known.header, title: known.title, tail },
      writtenAt,
      info,
      current,
    };
  }

  /** The header and the start of the third line, from byte 256, or what the file is instead. */
  async function headerOf(
    file: OpenFile,
  ): Promise<
    | { state: "ok"; header: OmpHeader; line3At: number; codex: boolean | null }
    | { state: "none" | "other" | "newer" }
  > {
    const head = asBuffer(await file.read(SLOT_BYTES, MAX_HEAD_BYTES + LINE3_BYTES));
    const end = head.indexOf(NEWLINE);
    if (end < 0 || end >= MAX_HEAD_BYTES) {
      // Half written, or a header too long to be one.
      return { state: head.byteLength < MAX_HEAD_BYTES ? "none" : "other" };
    }
    const header = parseHeader(head.toString("utf8", 0, end), platform, OMP_SESSION_VERSION);
    if (header === "newer") return { state: "newer" };
    if (header === null) return { state: "other" };
    const line3 = head.subarray(end + 1, end + 1 + LINE3_BYTES);
    return { state: "ok", header, line3At: SLOT_BYTES + end + 1, codex: codexImport(line3) };
  }

  async function readFile(ref: SessionFileRef, known: Known | undefined, now: number) {
    const file = await io.openRegular(ref.path);
    try {
      const { info } = file;
      // Another file than the one its `lstat` found, as when it was replaced since: tried again next poll.
      if (info.ino !== ref.info.ino) throw new Replaced("The file was replaced.");
      const fresh = known === undefined || known.info.ino !== info.ino;
      const base = {
        info,
        header: null,
        line3At: 0,
        codex: null,
        slot: null,
        title: known?.title ?? null,
        titleFrom: null,
        settled: true,
        readAt: now,
        tail: null,
      };
      const slot = asBuffer(await file.read(0, SLOT_BYTES));
      if (slot.byteLength < SLOT_BYTES) return { ...base, verdict: "none" } satisfies Known;
      if (!isSlot(slot)) return { ...base, title: null, verdict: "other" } satisfies Known;

      let header: OmpHeader;
      let line3At: number;
      let codex: boolean | null;
      if (fresh || known.header === null) {
        const read = await headerOf(file);
        if (read.state !== "ok")
          return { ...base, title: null, verdict: read.state } satisfies Known;
        ({ header, line3At, codex } = read);
      } else {
        header = known.header;
        line3At = known.line3At;
        codex = known.codex;
        if (codex === null) codex = codexImport(asBuffer(await file.read(line3At, LINE3_BYTES)));
      }

      // A file shorter than when it was last read, even by a half-written line
      // cut off again, is read from its end: a first read of it may reach further back.
      // In one not written for 30 minutes no wait shows, so it is not read past its
      // turn for one, and once it is written again it is read from its end.
      const writtenAt = Math.max(ref.info.mtimeMs, info.mtimeMs);
      const tail =
        (!fresh && known.tail !== null && info.size >= known.info.size
          ? await readOnwards(file, info.size, known.tail)
          : null) ?? (await readFromEnd(file, info.size, now - writtenAt < QUIET_MS));

      // A title is taken only from two reads in a row that agree, of one session's file.
      const sameSession = !fresh || known?.header?.id === header.id;
      const before = fresh ? null : known.slot;
      const agreed = before !== null && before.equals(slot);
      let title = sameSession ? (known?.title ?? null) : null;
      let titleFrom = sameSession && !fresh ? (known?.titleFrom ?? null) : null;
      const takenFrom = titleFrom;
      if (
        agreed &&
        (takenFrom === null || !takenFrom.slot.equals(slot) || takenFrom.codex !== codex)
      ) {
        const read = slotTitle(slot, codex);
        // A slot not as Oh My Pi writes it keeps the title from before.
        if (read !== undefined) {
          title = read;
          titleFrom = { slot: ownCopy(slot), codex };
        }
      }
      const next: Known = {
        ...base,
        verdict: "ok",
        header,
        line3At,
        codex,
        slot: ownCopy(slot),
        title,
        titleFrom,
        settled: agreed && now >= writtenAt + WRITE_TIME_STEP_MS,
        tail,
      };
      return next;
    } finally {
      await file.close().catch(() => {});
    }
  }

  return {
    async read(ref, now) {
      const known = remembered.get(ref.path);
      // Read again while the slot is not settled, or the clock was set back since it was read.
      if (
        known &&
        sameFile(known.info, ref.info) &&
        (known.verdict !== "ok" || (known.settled && now >= known.readAt))
      ) {
        return answer(known, ref.info.mtimeMs);
      }
      try {
        // A link at the folder's name would lead out of the sessions folder,
        // and opening a file does not look at the names before its own. Not
        // remembered: it says nothing of the file.
        const parent = path.dirname(ref.path);
        if (parent !== sessionsDir && (await io.lstat(parent)).kind !== "directory") {
          return { state: "none" };
        }
        const next = await readFile(ref, known, now);
        remembered.set(ref.path, next);
        return answer(next, Math.max(ref.info.mtimeMs, next.info.mtimeMs));
      } catch {
        // Gone since its `lstat`, replaced, refused, or a read error: what it
        // showed stands, and it is tried again on the next poll, since
        // nothing here took note of it.
        // This poll's `lstat` stands for what was read, so a write since an answer is never taken
        // for one read before it.
        return known === undefined
          ? { state: "none" }
          : answer(known, ref.info.mtimeMs, ref.info, false);
      }
    },
    keepOnly(paths) {
      for (const file of remembered.keys()) if (!paths.has(file)) remembered.delete(file);
    },
    get kept() {
      return remembered.size;
    },
  };
}
