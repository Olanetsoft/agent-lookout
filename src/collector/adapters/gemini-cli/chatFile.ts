import {
  applyGeminiCliRecord,
  emptyGeminiCliReplay,
  GEMINI_CLI_MESSAGE_TYPES,
  mapGeminiCliStatus,
  type GeminiCliContent,
  type GeminiCliMessage,
  type GeminiCliMessageType,
  type GeminiCliRecord,
  type GeminiCliReplay,
  type GeminiCliStatus,
  type GeminiCliToolCalls,
  type GeminiCliUpdate,
} from "../../../core/mapping/gemini-cli/geminiCliMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading one Gemini CLI session file for the little this adapter needs.
 *
 * Gemini CLI 0.39 and later writes each session to
 * `<gemini folder>/tmp/<project>/chats/session-<time>-<id>.jsonl`, one JSON
 * object a line, each added with `JSON.stringify(record) + "\n"`
 * (packages/core/src/services/chatRecordingService.ts at v0.64.0). The first
 * line is the session's header. Every later line is a message, a `$rewindTo`,
 * a `$patch` or a `$set`, which Gemini CLI replays in order: see
 * `src/core/mapping/gemini-cli/geminiCliMapping.ts`. The file holds the whole
 * conversation, so each line is parsed, the little below is taken from it and
 * the rest is dropped at once:
 *
 * - From the header: `sessionId`, `startTime`, `lastUpdated`, `kind` and the
 *   title, `summary`, and only whether `projectHash` is there. A header of a
 *   session someone imported also holds the text of its first prompt, which is
 *   never kept.
 * - From a message: its `id`, `type` and `timestamp`, the shape of its content
 *   (`GeminiCliContent`: whether it is "", asks for a tool, answers one, is
 *   only thoughts, or begins as a note Gemini CLI writes itself), and for a
 *   reply whether every tool call was cancelled and when the newest ended.
 * - From a `$rewindTo`, its id. From a `$patch`, the ids it changes, removes
 *   and reorders, and the shape of any new content.
 * - From a `$set`, its `lastUpdated`, its title, whether it sets `sessionId`,
 *   and its `messages` taken as messages are.
 *
 * No other text is kept: not a prompt, a reply, a thought, a tool's arguments or
 * result, `displayContent`, `memoryScratchpad`, `directories` or `projectHash`.
 * A line that does not parse is passed over, as Gemini CLI passes it over. A
 * line of a kind Gemini CLI 0.64.0 does not write makes the status unknown.
 *
 * Every read is bounded: the header within 8 MiB, at most the last 8 MiB of the
 * file on the first read, and after that only what was added since, in pieces
 * of 1 MiB, up to 64 MiB. A file that grew by more, or was replaced or
 * rewritten, is read again as on its first read. A line longer than 8 MiB is
 * not parsed: it is told apart from its first 512 bytes alone, and if those do
 * not say what it is, the status is unknown. A last line that is still being
 * written is left for the next read.
 */

/** The longest line parsed, and the most of a file's end read on its first read. */
export const LINE_LIMIT_BYTES = 8 * 1024 * 1024;

/** The header is looked for in this much first, which holds the header of an ordinary file. */
export const FIRST_HEAD_BYTES = 64 * 1024;

/**
 * The most added to a file since the last read that is read onward, rather than
 * afresh from its end. More than the line limit, so a line too long to parse
 * that Gemini CLI added at once is read past, told apart from its first bytes,
 * and the lines before it stay replayed.
 */
export const ONWARD_LIMIT_BYTES = 64 * 1024 * 1024;

/** How much of a line too long to parse is read, to tell what it is. */
export const PREFIX_BYTES = 512;

/** Files are read forward in pieces of this size. */
const CHUNK_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

/** The longest id kept. A longer one is not an id Gemini CLI gives, and the line is not read as a message. */
const MAX_ID_LENGTH = 256;

/** The longest title kept here. The session's name is cut shorter still. */
const MAX_SUMMARY_LENGTH = 1_000;

/** The session ids Gemini CLI gives, and `--session-id` allows: letters, digits, `_` and `-`. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** ISO 8601, as `new Date().toISOString()` writes it, or with an offset. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The start of a message line as Gemini CLI's recorder writes one: `id`,
 * `timestamp`, `type`, in that order. A message it copied in from another file,
 * as an import or a resumed older session does, can have its keys in another
 * order, and is then not told apart.
 */
const MESSAGE_PREFIX =
  /^\{"id":"([^"\\]{1,128})","timestamp":"([^"\\]{1,40})","type":"(user|gemini|info|warning|error)"/;

/** The start of a `$set` that replaces every message, written by Gemini CLI 0.44 to 0.63. */
const SET_MESSAGES_PREFIX = /^\{"\$set":\{"messages"/;

/**
 * How messages Gemini CLI writes itself as if the person had typed them begin,
 * which start no request: the session's context, a SessionStart hook's
 * context, the output of a shell command run with `!`, the folders added with
 * `/directory add`, and leaving Plan Mode by hand (packages/core/src/utils/
 * environmentContext.ts, packages/cli/src/ui/AppContainer.tsx,
 * packages/cli/src/ui/hooks/useExecutionLifecycle.ts and useGeminiStream.ts).
 */
export const NOTE_STARTS = [
  "<session_context>",
  "<hook_context>",
  "I ran the following shell command:",
  "- **Workspace Directories:**",
  "User has manually exited Plan Mode.",
] as const;

/** What is kept of a session file's header. */
export interface ChatHeader {
  sessionId: string;
  /** `main` or `subagent`, as Gemini CLI writes it. Left out when the header has none. */
  kind?: string;
  startedAt: number | null;
  updatedAt: number | null;
  summary?: string;
}

/** What is known about one session file. */
export interface ChatFileState {
  /** Null when the first line is not a Gemini CLI session's header: the file is then not listed. */
  header: ChatHeader | null;
  /** The status and since when, from the lines read (`mapGeminiCliStatus`). */
  status: GeminiCliStatus;
  /** The title Gemini CLI saved last, as it wrote it. */
  summary?: string;
  /** The last `lastUpdated` written. */
  updatedAt: number | null;
  /** The time of the last message line written. */
  messageAt: number | null;
  /** The newest time a tool call ended, of the last reply written with tool calls. */
  toolAt: number | null;
  /** How many lines did not parse and were passed over. */
  skipped: number;
}

/** Epoch milliseconds of a time Gemini CLI wrote, or null. Whether it could be right is decided where the clock is known. */
export function parseGeminiTime(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIME.test(value)) return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_ID_LENGTH ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A message's content as Gemini CLI's own reader takes it: a list of parts. */
function partsOf(content: unknown): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? { text: part } : part));
  }
  return content === undefined || content === null ? [] : [content];
}

/** The shape of a message's content, with none of its text. */
export function contentShapeOf(content: unknown): GeminiCliContent {
  const parts = partsOf(content).filter(isRecord);
  const text = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trimStart();
  return {
    empty: content === "",
    functionCall: parts.some((part) => has(part, "functionCall")),
    functionResponse: parts.some((part) => has(part, "functionResponse")),
    thoughtOnly:
      Array.isArray(content) &&
      content.length > 0 &&
      content.every((part) => isRecord(part) && part.thought === true),
    note: NOTE_STARTS.some((start) => text.startsWith(start)),
  };
}

function toolCallsOf(value: unknown): GeminiCliToolCalls | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  let lastAt: number | null = null;
  for (const call of value) {
    const at = isRecord(call) ? parseGeminiTime(call.timestamp) : null;
    if (at !== null && (lastAt === null || at > lastAt)) lastAt = at;
  }
  return {
    allCancelled: value.every((call) => isRecord(call) && call.status === "cancelled"),
    lastAt,
  };
}

function messageType(value: unknown): GeminiCliMessageType | "other" {
  return (GEMINI_CLI_MESSAGE_TYPES as readonly unknown[]).includes(value)
    ? (value as GeminiCliMessageType)
    : "other";
}

/** A message line as it is kept, or null when its id is not one. */
function messageOf(value: Record<string, unknown>): GeminiCliMessage | null {
  const id = idOf(value.id);
  if (id === null) return null;
  const type = messageType(value.type);
  return {
    id,
    type,
    at: parseGeminiTime(value.timestamp),
    content: contentShapeOf(value.content),
    toolCalls: type === "gemini" ? toolCallsOf(value.toolCalls) : null,
  };
}

/** Whether a parsed line is a message, as Gemini CLI's reader tells: a string `id` and no `$patch`. */
function isMessage(value: Record<string, unknown>): boolean {
  return typeof value.id === "string" && !has(value, "$patch");
}

/** Whether a parsed line is a header, as Gemini CLI's reader tells: a string `sessionId` and `projectHash`. */
function isHeader(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && typeof value.projectHash === "string";
}

function summaryOf(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_SUMMARY_LENGTH) : undefined;
}

function patchOf(patch: Record<string, unknown>): GeminiCliRecord {
  const updates: GeminiCliUpdate[] = [];
  const change = (value: Record<string, unknown>) => {
    const id = idOf(value.id);
    if (id === null) return;
    updates.push(has(value, "content") ? { id, content: contentShapeOf(value.content) } : { id });
  };
  // Gemini CLI applies a change to one message given at the top first, then `updates`.
  if (typeof patch.id === "string") change(patch);
  if (Array.isArray(patch.updates)) {
    for (const update of patch.updates) if (isRecord(update)) change(update);
  }
  return {
    kind: "patch",
    updates,
    removeIds: strings(patch.removeIds),
    orderIds: Array.isArray(patch.orderIds) ? strings(patch.orderIds) : null,
  };
}

function setOf(set: Record<string, unknown>): GeminiCliRecord {
  const record: GeminiCliRecord & { kind: "set" } = {
    kind: "set",
    reattach: has(set, "sessionId"),
  };
  if (has(set, "lastUpdated")) record.updatedAt = parseGeminiTime(set.lastUpdated);
  const summary = summaryOf(set.summary);
  if (summary !== undefined) record.summary = summary;
  if (Array.isArray(set.messages)) {
    record.messages = set.messages.flatMap((message) => {
      if (!isRecord(message) || !isMessage(message)) return [];
      const kept = messageOf(message);
      return kept ? [kept] : [];
    });
  }
  return record;
}

/** The fields kept from a header, or null when the line is not one. */
export function readHeaderLine(line: string): ChatHeader | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (typeof value.$rewindTo === "string" || isRecord(value.$patch) || isMessage(value))
    return null;
  if (isRecord(value.$set) || !isHeader(value)) return null;
  const sessionId = value.sessionId as string;
  if (!SESSION_ID.test(sessionId)) return null;
  const header: ChatHeader = {
    sessionId,
    startedAt: parseGeminiTime(value.startTime),
    updatedAt: parseGeminiTime(value.lastUpdated),
  };
  if (typeof value.kind === "string" && value.kind.length <= 32) header.kind = value.kind;
  const summary = summaryOf(value.summary);
  if (summary !== undefined) header.summary = summary;
  return header;
}

/** What one line read whole says, or null when it does not parse and is passed over. */
export function readLine(line: string, otherId: () => string): GeminiCliRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const other = (): GeminiCliRecord => ({
    kind: "message",
    message: { id: otherId(), type: "other", at: null, content: null, toolCalls: null },
  });
  // In the order Gemini CLI's own reader tries them.
  if (!isRecord(value)) return other();
  if (typeof value.$rewindTo === "string") return { kind: "rewind", id: value.$rewindTo };
  if (isRecord(value.$patch)) return patchOf(value.$patch);
  if (isMessage(value)) {
    const message = messageOf(value);
    return message ? { kind: "message", message } : other();
  }
  if (isRecord(value.$set)) return setOf(value.$set);
  if (isHeader(value)) {
    const header = readHeaderLine(line);
    if (header) {
      const record: GeminiCliRecord = {
        kind: "header",
        startedAt: header.startedAt,
        updatedAt: header.updatedAt,
      };
      if (header.summary !== undefined) record.summary = header.summary;
      return record;
    }
  }
  return other();
}

/**
 * What a line too long to parse says, from its first bytes alone: a message as
 * the recorder writes one, whose content is then not known, or a `$set` that
 * replaces every message with ones not known. Anything else is not known.
 */
export function readLongLine(prefix: string, otherId: () => string): GeminiCliRecord {
  const unknown: GeminiCliMessage = {
    id: otherId(),
    type: "other",
    at: null,
    content: null,
    toolCalls: null,
  };
  const message = MESSAGE_PREFIX.exec(prefix);
  if (message) {
    const [, id = "", timestamp, type] = message;
    return {
      kind: "message",
      message: {
        id,
        type: messageType(type),
        at: parseGeminiTime(timestamp),
        content: null,
        toolCalls: null,
      },
    };
  }
  if (SET_MESSAGES_PREFIX.test(prefix)) {
    return { kind: "set", reattach: false, messages: [unknown] };
  }
  return { kind: "message", message: unknown };
}

function bytes(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Reads exactly `length` bytes, or throws: a file that shrank while being read is read again later. */
async function readExactly(file: OpenFile, position: number, length: number): Promise<Buffer> {
  const data = bytes(await file.read(position, length));
  if (data.byteLength !== length) throw new Error("The file changed while it was read.");
  return data;
}

/** One line as the scan found it: whole, or only its first bytes when it is too long to parse. */
type FoundLine = { whole: string } | { prefix: string };

/**
 * Reads forward from `from` to `to`, a piece at a time, and hands over each
 * line that has its newline. With `skipFirst`, the first line is dropped: it
 * began before `from`. Returns where the lines handed over end, the byte after
 * the last newline, so what comes after it is read again next time.
 */
async function scanLines(
  file: OpenFile,
  from: number,
  to: number,
  skipFirst: boolean,
  take: (line: FoundLine) => void,
): Promise<number> {
  let position = from;
  let end = from;
  let skip = skipFirst;
  /** The pieces of the line not yet ended, while it is short enough to parse. */
  let pieces: Buffer[] = [];
  let pieceBytes = 0;
  /** The line's first bytes. */
  let head = Buffer.alloc(0);
  let tooLong = false;

  const add = (piece: Buffer) => {
    if (head.byteLength < PREFIX_BYTES) {
      head = Buffer.concat([head, piece.subarray(0, PREFIX_BYTES - head.byteLength)]);
    }
    if (tooLong) return;
    if (pieceBytes + piece.byteLength > LINE_LIMIT_BYTES) {
      tooLong = true;
      pieces = [];
      pieceBytes = 0;
      return;
    }
    // A copy, so the piece read does not stay in memory with the whole chunk.
    pieces.push(Buffer.from(piece));
    pieceBytes += piece.byteLength;
  };

  while (position < to) {
    const length = Math.min(CHUNK_BYTES, to - position);
    const chunk = await readExactly(file, position, length);
    let start = 0;
    let newline = chunk.indexOf(NEWLINE);
    while (newline !== -1) {
      if (skip) {
        skip = false;
      } else if (pieceBytes === 0 && !tooLong) {
        // The whole line is in this piece, which is shorter than the limit.
        take({ whole: chunk.toString("utf8", start, newline) });
      } else {
        add(chunk.subarray(start, newline));
        take(
          tooLong
            ? { prefix: head.toString("utf8") }
            : { whole: Buffer.concat(pieces, pieceBytes).toString("utf8") },
        );
      }
      pieces = [];
      pieceBytes = 0;
      head = Buffer.alloc(0);
      tooLong = false;
      start = newline + 1;
      end = position + start;
      newline = chunk.indexOf(NEWLINE, start);
    }
    // The first line, which began before `from`, is not kept while it goes on.
    if (start < chunk.byteLength && !skip) add(chunk.subarray(start));
    position += length;
  }
  return end;
}

/** The header, from the file's first line, read within the line limit. */
async function readHead(file: OpenFile, size: number): Promise<ChatHeader | null> {
  for (const limit of [FIRST_HEAD_BYTES, LINE_LIMIT_BYTES]) {
    const length = Math.min(limit, size);
    const head = await readExactly(file, 0, length);
    const end = head.indexOf(NEWLINE);
    if (end !== -1) return readHeaderLine(head.toString("utf8", 0, end));
    // The first line goes on past what was read: read more, or give up at the limit.
    if (length >= size) return null;
  }
  return null;
}

/** What is cached for one file between polls. */
interface Cached {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the lines read so far end, always at a line's start. */
  offset: number;
  header: ChatHeader | null;
  replay: GeminiCliReplay;
  skipped: number;
  /** How many lines of unknown kinds have been given ids of their own. */
  others: number;
  /** What the lines read so far say, worked out once after each read that changed them. */
  state?: ChatFileState;
}

function stateOf(cached: Cached): ChatFileState {
  const { replay } = cached;
  const state: ChatFileState = {
    header: cached.header,
    status: mapGeminiCliStatus(replay),
    updatedAt: replay.updatedAt,
    messageAt: replay.messageAt,
    toolAt: replay.toolAt,
    skipped: cached.skipped,
  };
  if (replay.summary !== undefined) state.summary = replay.summary;
  return state;
}

/** The records of the lines between `from` and `to`, and where those lines end. */
async function recordsBetween(
  file: OpenFile,
  cached: Cached,
  from: number,
  skipFirst: boolean,
): Promise<{ records: GeminiCliRecord[]; skipped: number; end: number }> {
  const records: GeminiCliRecord[] = [];
  let skipped = 0;
  // A line of a kind not known gets an id no real message can have, so a later
  // line can never replace it by its id.
  const otherId = () => `\u0000other:${(cached.others += 1)}`;
  const end = await scanLines(file, from, file.info.size, skipFirst, (line) => {
    if ("prefix" in line) {
      records.push(readLongLine(line.prefix, otherId));
      return;
    }
    if (line.whole.trim() === "") return;
    const record = readLine(line.whole, otherId);
    if (record === null) skipped += 1;
    else records.push(record);
  });
  return { records, skipped, end };
}

export interface ChatFileReader {
  /**
   * What is known about a file, read only as far as it changed since the last
   * call. `info` is what a `lstat` of it said this poll. Throws when the file
   * cannot be read; the caller skips it for this poll.
   */
  read(file: string, info: FileInfo): Promise<ChatFileState>;
  /** Forgets every file not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createChatFileReader(io: ReadOnlyIo): ChatFileReader {
  const cache = new Map<string, Cached>();

  async function readFresh(file: string): Promise<Cached> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const header = await readHead(handle, info.size);
      const start = Math.max(0, info.size - LINE_LIMIT_BYTES);
      // The tail begins at a line's start only when the byte before it ends a line.
      const cut = start > 0 && (await readExactly(handle, start - 1, 1))[0] !== NEWLINE;
      const cached: Cached = {
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: start,
        header,
        replay: emptyGeminiCliReplay(start === 0),
        skipped: 0,
        others: 0,
      };
      if (header === null) return cached;
      // Read from the start, the header is the first line. Otherwise its details are taken from the head.
      if (start > 0) {
        const record: GeminiCliRecord = {
          kind: "header",
          startedAt: header.startedAt,
          updatedAt: header.updatedAt,
        };
        if (header.summary !== undefined) record.summary = header.summary;
        applyGeminiCliRecord(cached.replay, record);
      }
      const { records, skipped, end } = await recordsBetween(handle, cached, start, cut);
      for (const record of records) applyGeminiCliRecord(cached.replay, record);
      cached.skipped = skipped;
      cached.offset = end;
      return cached;
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads only what was added since the last read. Returns null when the file
   * has to be read afresh: it is a different file, it shrank, it was rewritten
   * in place, too much was added at once, or it had no header yet.
   */
  async function readOnward(file: string, cached: Cached, info: FileInfo): Promise<Cached | null> {
    const { offset } = cached;
    if (cached.header === null) return null;
    if (info.ino !== cached.ino || info.size <= cached.size || info.size < offset) return null;
    if (info.size - offset > ONWARD_LIMIT_BYTES) return null;

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      if (opened.ino !== cached.ino || opened.size < offset) return null;
      // If the byte before the new lines does not end a line, the file was
      // rewritten and the offset means nothing.
      if (offset > 0 && (await readExactly(handle, offset - 1, 1))[0] !== NEWLINE) return null;
      // The records are applied only once every line is read, so a read that
      // fails part way leaves the replay as it was.
      const { records, skipped, end } = await recordsBetween(handle, cached, offset, false);
      for (const record of records) applyGeminiCliRecord(cached.replay, record);
      cached.skipped += skipped;
      cached.offset = end;
      cached.ino = opened.ino;
      cached.size = opened.size;
      cached.mtimeMs = opened.mtimeMs;
      return cached;
    } finally {
      await handle.close();
    }
  }

  return {
    async read(file, info) {
      const cached = cache.get(file);
      if (
        cached &&
        cached.ino === info.ino &&
        cached.size === info.size &&
        cached.mtimeMs === info.mtimeMs
      ) {
        cached.state ??= stateOf(cached);
        return { ...cached.state, status: { ...cached.state.status } };
      }
      // A read onward that fails leaves the cache as it was: its lines are
      // applied only once all of them were read.
      const next = (cached && (await readOnward(file, cached, info))) || (await readFresh(file));
      next.state = stateOf(next);
      cache.set(file, next);
      return { ...next.state, status: { ...next.state.status } };
    },
    keepOnly(files) {
      for (const file of cache.keys()) {
        if (!files.has(file)) cache.delete(file);
      }
    },
  };
}
