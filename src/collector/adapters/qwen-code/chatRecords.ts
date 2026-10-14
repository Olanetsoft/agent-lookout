import {
  foldQwenCodeRecord,
  startQwenCodeFold,
  type QwenCodeFold,
  type QwenCodeLifecycle,
  type QwenCodeRecord,
} from "../../../core/mapping/qwen-code/qwenCodeMapping.ts";
import { sessionName } from "../../../core/text.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading one Qwen Code chat file for the little this adapter needs.
 *
 * A chat file is JSON Lines, one record per line, appended as the session
 * works and never rewritten (`chatRecordingService.ts` at v0.25.1). Each line
 * holds a whole prompt, reply or tool result, so it is read narrowly and
 * almost nothing is kept: of each line, its type, subtype and time, and
 *
 * - of a `user` line, whether it is a notification stamped as a turn's first line;
 * - of an `assistant` line, whether it holds a reply and whether that calls a tool;
 * - of a `tool_result` line, whether the call was stopped or declined;
 * - of a `request_lifecycle` event, whether a request started or ended, how it
 *   ended and whether a subagent made it;
 * - of a `custom_title` line, the title;
 * - whether a line belongs to a Managed Session log.
 *
 * Nothing else is kept: no prompt, reply, thought, tool input or output, folder
 * or branch. Each line is parsed and dropped at once, and only what it says is
 * folded in (`qwenCodeMapping.ts`). A line a subagent wrote into the file is
 * skipped.
 *
 * Every read is bounded. The first reads at most the last 8 MiB, and drops the
 * line it cut into. Each one after reads only what was appended since, at most
 * 8 MiB at once, and a line still being written is left for the next. A line
 * over 4 MiB is not parsed: its type, subtype and time are read from its first
 * 64 KiB. A file that shrank, or was replaced, is read again from the end.
 *
 * Built from Qwen Code's source at v0.25.1 and not yet checked on a machine
 * running it.
 */

/** The most of a file's end read at once. */
export const TAIL_LIMIT_BYTES = 8 * 1024 * 1024;

/** The longest line parsed. */
export const LINE_LIMIT_BYTES = 4 * 1024 * 1024;

/** How much of a longer line is read for its type, subtype and time. */
export const PREFIX_BYTES = 64 * 1024;

const NEWLINE = 0x0a;

/** Qwen Code writes times as `YYYY-MM-DDTHH:MM:SS.mmmZ`. Anything else is not read as a time. */
const QWEN_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** A line's type, as Qwen Code writes one. */
const TYPE = /^[a-z][a-z0-9_]{0,39}$/;

/** A subtype, as Qwen Code writes one. */
const SUBTYPE = /^[a-z0-9_]{1,40}$/;

/** How a request ended, as Qwen Code writes it. */
const OUTCOME = /^[a-z_]{1,20}$/;

/**
 * The start of a line too long to parse, as Qwen Code writes every line: its
 * session id, time and type, in that order, near the start.
 */
const LINE_START =
  /"sessionId":"[^"\\]{0,64}","timestamp":"([^"\\]{1,40})","type":"([a-z][a-z0-9_]{0,39})"/;

/** The subtype of a line too long to parse, which comes before its payload. */
const LINE_SUBTYPE = /"subtype":"([a-z0-9_]{1,40})"/;

/** Where a line's payload begins: the subtype is looked for only before it. */
const PAYLOAD_KEYS = ['"message":', '"systemPayload":'];

/** Epoch milliseconds of a time Qwen Code wrote, or null. */
export function parseQwenTime(value: unknown): number | null {
  if (typeof value !== "string" || !QWEN_TIME.test(value)) return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a `ui_telemetry` line says of a request to the model, when it is about one. */
function lifecycleOf(payload: unknown): QwenCodeLifecycle | undefined {
  const event = isRecord(payload) ? payload.uiEvent : undefined;
  if (!isRecord(event) || event["event.name"] !== "request_lifecycle") return undefined;
  const { phase, outcome } = event;
  if (phase !== "started" && phase !== "ended") return undefined;
  return {
    phase,
    ...(typeof outcome === "string" && OUTCOME.test(outcome) ? { outcome } : {}),
    subagent: typeof event.subagentId === "string" || typeof event.subagent_id === "string",
  };
}

/** Whether a reply's parts include a call to a tool. */
function callsATool(message: Record<string, unknown>): boolean {
  const { parts } = message;
  return (
    Array.isArray(parts) && parts.some((part) => isRecord(part) && isRecord(part.functionCall))
  );
}

/**
 * The kept fields of one line, or null for a line that is not a record, or
 * one a subagent wrote.
 */
export function recordOf(line: string): QwenCodeRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.isSidechain === true) return null;
  if (typeof value.type !== "string" || !TYPE.test(value.type)) return null;
  const record: QwenCodeRecord = { type: value.type, at: parseQwenTime(value.timestamp) };
  if (typeof value.subtype === "string") {
    // A subtype it cannot read is still a subtype, so the line is not taken for a prompt.
    record.subtype = SUBTYPE.test(value.subtype) ? value.subtype : "unreadable";
  }
  const payload = value.systemPayload;
  switch (value.type) {
    case "user":
      if (value.deliveredTurn === true) record.deliveredTurn = true;
      break;
    case "assistant":
      if (isRecord(value.message)) {
        record.message = true;
        if (callsATool(value.message)) record.calls = true;
      }
      break;
    case "tool_result":
      if (isRecord(value.toolCallResult) && value.toolCallResult.status === "cancelled") {
        record.cancelled = true;
      }
      break;
    case "system":
      if (record.subtype === "ui_telemetry") {
        const lifecycle = lifecycleOf(payload);
        if (lifecycle) record.lifecycle = lifecycle;
      } else if (record.subtype === "custom_title" && isRecord(payload)) {
        const title = sessionName(
          typeof payload.customTitle === "string" ? payload.customTitle : "",
        );
        if (title !== undefined) record.title = title;
      } else if (
        record.subtype === "session_execution_engine" &&
        isRecord(payload) &&
        payload.engine === "managed"
      ) {
        record.managed = true;
      }
      break;
  }
  return record;
}

/**
 * The type, subtype and time of a line too long to parse, from its start, or a
 * line of no type it knows when even those cannot be found there.
 */
export function oversizedRecordOf(start: string): QwenCodeRecord {
  const match = LINE_START.exec(start);
  if (!match) return { type: "unreadable", at: null, oversized: true };
  const [, time, type] = match as unknown as [string, string, string];
  const record: QwenCodeRecord = { type, at: parseQwenTime(time), oversized: true };
  let rest = start.slice(match.index + match[0].length);
  for (const key of PAYLOAD_KEYS) {
    const at = rest.indexOf(key);
    if (at !== -1) rest = rest.slice(0, at);
  }
  const subtype = LINE_SUBTYPE.exec(rest)?.[1];
  if (subtype !== undefined) record.subtype = subtype;
  return record;
}

/** What is known of one chat file. */
export interface ChatState {
  /** What its lines say, folded in order. */
  fold: QwenCodeFold;
  /** The time of its first line with one, when the file was read from its start. */
  firstAt: number | null;
}

/** What is kept of one file between polls. */
interface Cached extends ChatState {
  ino: number;
  size: number;
  mtimeMs: number;
  /** Where the lines read so far end, always at a line's start. Null when not known. */
  offset: number | null;
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

/**
 * Folds every whole line in `data`, which begins at a line's start, and says
 * how many of its bytes those lines take: the rest is a line still being written.
 */
function foldLines(data: Buffer, state: ChatState): { state: ChatState; used: number } {
  let { fold, firstAt } = state;
  let start = 0;
  let newline = data.indexOf(NEWLINE);
  while (newline !== -1) {
    const length = newline - start;
    if (length > 0) {
      const record =
        length > LINE_LIMIT_BYTES
          ? oversizedRecordOf(data.toString("utf8", start, start + PREFIX_BYTES))
          : recordOf(data.toString("utf8", start, newline));
      if (record !== null) {
        if (fold.whole && firstAt === null && record.at !== null) firstAt = record.at;
        fold = foldQwenCodeRecord(fold, record);
      }
    }
    start = newline + 1;
    newline = data.indexOf(NEWLINE, start);
  }
  return { state: { fold, firstAt }, used: start };
}

function stateOf(cached: Cached): ChatState {
  return { fold: cached.fold, firstAt: cached.firstAt };
}

export interface ChatReader {
  /**
   * What is known of a file, read only as far as it changed since the last
   * call. `info` is what a `lstat` of it said this poll. When it cannot be
   * read, what was known of it before stands; it throws only when nothing was.
   */
  read(file: string, info: FileInfo): Promise<ChatState>;
  /** Forgets every file not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createChatReader(io: ReadOnlyIo): ChatReader {
  const cache = new Map<string, Cached>();

  /** Reads the file's end, at most 8 MiB, folding from the first line that starts in it. */
  async function readEnd(file: string, keptFirstAt: number | null): Promise<Cached> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const from = Math.max(0, info.size - TAIL_LIMIT_BYTES);
      const data = await readExactly(handle, from, info.size - from);
      const whole = from === 0;
      // A read that begins inside the file begins inside a line, which is dropped.
      const first = whole ? 0 : data.indexOf(NEWLINE) + 1;
      if (!whole && first === 0) {
        // No line ends in the whole of the end read: nothing to fold until one does.
        return {
          fold: startQwenCodeFold(false),
          firstAt: keptFirstAt,
          ino: info.ino,
          size: info.size,
          mtimeMs: info.mtimeMs,
          offset: null,
        };
      }
      const { state, used } = foldLines(data.subarray(first), {
        fold: startQwenCodeFold(whole),
        firstAt: whole ? null : keptFirstAt,
      });
      return {
        ...state,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        offset: from + first + used,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads only what was appended since the last read. Null when the file has
   * to be read again from its end: it is another file, it shrank, it was
   * written over in place, or where the last read ended is not known.
   * `"too-much"` when more than 8 MiB was appended at once.
   */
  async function readOnward(
    file: string,
    cached: Cached,
    info: FileInfo,
  ): Promise<Cached | null | "too-much"> {
    const offset = cached.offset;
    if (offset === null) return null;
    if (info.ino !== cached.ino || info.size <= cached.size || info.size < offset) return null;
    if (info.size - offset > TAIL_LIMIT_BYTES) return "too-much";

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      if (opened.ino !== cached.ino || opened.size < offset) return null;
      if (opened.size - offset > TAIL_LIMIT_BYTES) return "too-much";
      // One byte more than the new lines, so the line end before them can be
      // checked. Without it there, the file was written over and the offset
      // means nothing.
      const from = offset > 0 ? offset - 1 : 0;
      const read = await readExactly(handle, from, opened.size - from);
      if (offset > 0 && read[0] !== NEWLINE) return null;
      const added = offset > 0 ? read.subarray(1) : read;
      const { state, used } = foldLines(added, stateOf(cached));
      return {
        ...state,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        offset: offset + used,
      };
    } finally {
      await handle.close();
    }
  }

  async function readChanged(file: string, info: FileInfo, cached?: Cached): Promise<Cached> {
    if (cached === undefined) return readEnd(file, null);
    const onward = await readOnward(file, cached, info);
    if (onward === "too-much") {
      // The same file, grown: where it began has not changed.
      return readEnd(file, cached.firstAt);
    }
    return onward ?? readEnd(file, null);
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
        return stateOf(cached);
      }
      let next: Cached;
      try {
        next = await readChanged(file, info, cached);
      } catch (error) {
        // Unreadable this time: what was read of it before stands, and it is tried again next poll.
        if (cached) return stateOf(cached);
        throw error;
      }
      cache.set(file, next);
      return stateOf(next);
    },
    keepOnly(files) {
      for (const file of cache.keys()) if (!files.has(file)) cache.delete(file);
    },
  };
}
