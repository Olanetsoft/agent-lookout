import { createHash } from "node:crypto";

import {
  isAsideStep,
  openStatusOf,
  stepStatusName,
  stepTypeName,
  type AntigravityStep,
} from "../../../core/mapping/antigravityMapping.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../files/readOnlyIo.ts";

/**
 * Reading one Antigravity CLI transcript for the little this adapter needs.
 *
 * agy writes each conversation to
 * `<agy folder>/brain/<conversation id>/.system_generated/logs/transcript.jsonl`,
 * one JSON object a line, each line one step: `step_index`, `source`, `type`,
 * `status`, `created_at`, `content`, `thinking`, `tool_calls`, `media` and,
 * when something was cut short, `truncated_fields` (docs/adapters/antigravity.md).
 * It holds the whole conversation, so almost nothing is kept:
 *
 * - From the first line, its `step_index` and `created_at`, for when the
 *   conversation began.
 * - From the end, the last step that says how the conversation stands, its
 *   `type`, its `status` and whether it has any `tool_calls`, when the run of
 *   steps that say the same began, and when the last step was made.
 *
 * `content`, `thinking`, `media`, `source` and the tool calls themselves are
 * never kept: each line is parsed, those four fields are read and the rest is
 * dropped at once. A line that does not parse is passed over, since agy can
 * leave one broken when it rewrites the file as it compacts a conversation.
 *
 * Every read is bounded: the first line within 256 KiB, and at most the last
 * 2 MiB. After the first read, only what was added since is read. The file is
 * not only added to: agy rewrites it when it compacts a conversation, which is
 * noticed by its size, its identity or its first 4 KiB, and it is read afresh.
 */

/** The most of a file's start that is searched for the end of its first line. */
export const HEAD_LIMIT_BYTES = 256 * 1024;

/** The most of a file's end that is read for its last steps, and the most read onward at once. */
export const TAIL_LIMIT_BYTES = 2 * 1024 * 1024;

/** The tail is read backwards in pieces of this size. */
const TAIL_CHUNK_BYTES = 64 * 1024;

/** How much of the start is hashed, to notice the file rewritten with more in it than before. */
const HEAD_HASH_BYTES = 4 * 1024;

const NEWLINE = 0x0a;

/** One step as it is kept: what `AntigravityStep` holds, its index and its time. */
export interface TranscriptStep extends AntigravityStep {
  /** `step_index`. Null when it is not a whole number. */
  index: number | null;
  /** `created_at`, in epoch milliseconds. Null when it is not an ISO 8601 time. */
  at: number | null;
}

/** What is known about one transcript. */
export interface TranscriptState {
  /** When the first step was made, when the file still begins with step 0. */
  firstAt: number | null;
  /**
   * The last step that is not passed over (`isAsideStep`). Null when the whole
   * file has been read and holds none. Undefined when none was found within
   * the part read.
   */
  last: TranscriptStep | null | undefined;
  /**
   * When the steps at the end of the file that say what the last one says
   * began, as working since the turn's first step. Null when not known.
   */
  since: number | null;
  /** When the last step of any kind was made. */
  lastAt: number | null;
}

/** ISO 8601, as agy writes `created_at`: a date, a time, a fraction of a second and a zone. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of a time agy wrote, or null. Whether it could be right is decided where the clock is known. */
export function parseStepTime(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_TIME.test(value)) return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) ? at : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The kept fields of one line, or null when the line is not a step: it does
 * not parse, is not an object, or has neither a `type` nor a `status`.
 */
export function readStepLine(line: string): TranscriptStep | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const type = stepTypeName(value.type);
  const status = stepStatusName(value.status);
  if (type === null && status === null) return null;
  const index = value.step_index;
  return {
    index: Number.isSafeInteger(index) && (index as number) >= 0 ? (index as number) : null,
    type,
    status,
    toolCalls: Array.isArray(value.tool_calls) && value.tool_calls.length > 0,
    at: parseStepTime(value.created_at),
  };
}

/** The state of a file with no steps read yet. */
function emptyState(): TranscriptState {
  return { firstAt: null, last: undefined, since: null, lastAt: null };
}

/** Moves the state on by one step, read in the order agy wrote them. */
function addStep(state: TranscriptState, step: TranscriptStep): void {
  if (step.at !== null) state.lastAt = step.at;
  if (isAsideStep(step)) return;
  const was = state.last ? openStatusOf(state.last) : null;
  if (was !== openStatusOf(step)) state.since = step.at;
  state.last = step;
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

async function headHash(file: OpenFile, size: number): Promise<string> {
  const head = await readExactly(file, 0, Math.min(HEAD_HASH_BYTES, size));
  return createHash("sha256").update(head).digest("hex");
}

/** When the conversation began, from the first line, if it is step 0. */
async function readFirstAt(file: OpenFile, size: number): Promise<number | null> {
  const head = await readExactly(file, 0, Math.min(HEAD_LIMIT_BYTES, size));
  const end = head.indexOf(NEWLINE);
  // A first line longer than the limit is not read; one with no newline yet may still be whole.
  if (end === -1 && head.byteLength < size) return null;
  const step = readStepLine(head.toString("utf8", 0, end === -1 ? head.byteLength : end));
  return step?.index === 0 ? step.at : null;
}

interface Tail {
  state: TranscriptState;
  /** Where the complete lines end. Null when no line end was found within the limit. */
  end: number | null;
}

/**
 * Reads backwards from the end until it has the last step that is not passed
 * over and the start of the run of steps that say the same, reaches the start
 * of the file, or has read the tail limit. The bytes after the last newline are
 * a line still being written, and are used only if they are already a whole step.
 */
async function scanTail(file: OpenFile, size: number): Promise<Tail> {
  const state = emptyState();
  let position = size;
  let budget = TAIL_LIMIT_BYTES;
  /** The bytes from `position` to the first newline after it: not yet known to be a whole line. */
  let fragment: Buffer = Buffer.alloc(0);
  let end: number | null = null;
  /** Whether the run the last step belongs to has been followed back to its start. */
  let settled = false;

  /** Takes one step, newest first. Returns true once nothing older is needed. */
  const take = (step: TranscriptStep | null): boolean => {
    if (step === null) return false;
    if (state.lastAt === null && step.at !== null) state.lastAt = step.at;
    if (isAsideStep(step)) return false;
    if (state.last === undefined || state.last === null) {
      state.last = step;
      state.since = step.at;
      return false;
    }
    if (openStatusOf(step) !== openStatusOf(state.last)) return true;
    // The same run goes back further. A step with no time leaves the start as it was.
    if (step.at !== null) state.since = step.at;
    return false;
  };

  while (position > 0 && budget > 0 && !settled) {
    const length = Math.min(TAIL_CHUNK_BYTES, position, budget);
    const start = position - length;
    const chunk = await readExactly(file, start, length);
    budget -= length;
    position = start;
    const buffer = fragment.byteLength > 0 ? Buffer.concat([chunk, fragment]) : chunk;

    let cut = buffer.byteLength;
    if (end === null) {
      const last = buffer.lastIndexOf(NEWLINE);
      if (last === -1) {
        fragment = buffer;
        continue;
      }
      end = start + last + 1;
      cut = last;
      // What follows the last newline counts only once it is a whole step.
      if (last + 1 < buffer.byteLength) {
        settled = take(readStepLine(buffer.toString("utf8", last + 1)));
      }
    }

    let newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    while (newline !== -1 && !settled) {
      settled = take(readStepLine(buffer.toString("utf8", newline + 1, cut)));
      cut = newline;
      newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    }
    if (settled) break;

    if (start === 0) {
      take(readStepLine(buffer.toString("utf8", 0, cut)));
      // The whole file has been read.
      if (state.last === undefined) state.last = null;
      return { state, end };
    }
    fragment = buffer.subarray(0, cut);
  }

  if (!settled && position === 0) {
    // The start was reached with no newline at all: one line, perhaps still being written.
    if (end === null) {
      take(readStepLine(fragment.toString("utf8")));
      end = 0;
    }
    if (state.last === undefined) state.last = null;
    return { state, end };
  }
  // The limit was reached before the run's start: when it began is not known.
  if (!settled && state.last) state.since = null;
  return { state, end };
}

/** What is cached for one file between polls. */
interface Cached extends TranscriptState {
  ino: number;
  size: number;
  mtimeMs: number;
  headHash: string;
  /** Where the lines read so far end, always at a line's start. Null when not known. */
  offset: number | null;
}

function stateOf(cached: Cached): TranscriptState {
  return {
    firstAt: cached.firstAt,
    last: cached.last,
    since: cached.since,
    lastAt: cached.lastAt,
  };
}

export interface TranscriptReader {
  /**
   * What is known about a transcript, read only as far as it changed since the
   * last call. `info` is what a `lstat` of it said this poll. Throws when the
   * file cannot be read; the caller skips it for this poll.
   */
  read(file: string, info: FileInfo): Promise<TranscriptState>;
  /** Forgets every file not in this set. */
  keepOnly(files: ReadonlySet<string>): void;
}

export function createTranscriptReader(io: ReadOnlyIo): TranscriptReader {
  const cache = new Map<string, Cached>();

  async function readFresh(file: string, earlier: Cached | undefined): Promise<Cached> {
    const handle = await io.openRegular(file);
    try {
      const { info } = handle;
      const firstAt = await readFirstAt(handle, info.size);
      const tail = await scanTail(handle, info.size);
      return {
        ...tail.state,
        // A compacted file may begin later than the conversation did: the earliest seen stands.
        firstAt:
          earlier?.firstAt != null && (firstAt === null || earlier.firstAt < firstAt)
            ? earlier.firstAt
            : firstAt,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        headHash: await headHash(handle, info.size),
        offset: tail.end,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads only what was added since the last read. Returns null when the file
   * has to be read afresh: it is a different file, it shrank, it was rewritten,
   * or too much was added at once.
   */
  async function readOnward(file: string, cached: Cached, info: FileInfo): Promise<Cached | null> {
    const offset = cached.offset;
    if (offset === null) return null;
    if (info.ino !== cached.ino || info.size <= cached.size || info.size < offset) return null;
    if (info.size - offset > TAIL_LIMIT_BYTES) return null;

    const handle = await io.openRegular(file);
    try {
      const opened = handle.info;
      if (opened.ino !== cached.ino || opened.size < offset || opened.size < cached.size) {
        return null;
      }
      // A file rewritten as a conversation is compacted can be longer than it
      // was, so its start is compared too, over the bytes hashed last time.
      if ((await headHash(handle, cached.size)) !== cached.headHash) return null;
      // One byte more than the new lines, so the newline before them can be checked.
      const from = offset > 0 ? offset - 1 : 0;
      const read = await readExactly(handle, from, opened.size - from);
      if (offset > 0 && read[0] !== NEWLINE) return null;
      const added = offset > 0 ? read.subarray(1) : read;

      const next: Cached = {
        ...cached,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        headHash: await headHash(handle, opened.size),
      };
      let start = 0;
      let newline = added.indexOf(NEWLINE);
      while (newline !== -1) {
        const step = readStepLine(added.toString("utf8", start, newline));
        if (step) addStep(next, step);
        start = newline + 1;
        newline = added.indexOf(NEWLINE, start);
      }
      // A last line that is already a whole step counts now. It is read again
      // once its newline is written, which changes nothing.
      if (start < added.byteLength) {
        const step = readStepLine(added.toString("utf8", start));
        if (step) addStep(next, step);
      }
      next.offset = offset + start;
      if (next.firstAt === null && offset === 0) {
        next.firstAt = await readFirstAt(handle, opened.size);
      }
      return next;
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
        return stateOf(cached);
      }
      const next =
        (cached && (await readOnward(file, cached, info))) || (await readFresh(file, cached));
      cache.set(file, next);
      return stateOf(next);
    },
    keepOnly(files) {
      for (const file of cache.keys()) {
        if (!files.has(file)) cache.delete(file);
      }
    },
  };
}
