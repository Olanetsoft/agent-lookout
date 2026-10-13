import { createHash } from "node:crypto";

import {
  isAsideStep,
  openStatusOf,
  stepStatusName,
  stepTypeName,
  type AntigravityStep,
} from "../../../../core/mapping/antigravityMapping.ts";
import type { TokenCounts } from "../../../../core/sessions/session.ts";
import { tokenCountsOf } from "../../../../core/tokens/tokenCounts.ts";
import type { FileInfo, OpenFile, ReadOnlyIo } from "../../../files/readOnlyIo.ts";

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
 *   steps that say the same began, when the last step was made, and the
 *   last step's `step_index`.
 * - From the end too, the token counts of the newest reply, a
 *   `PLANNER_RESPONSE` step, from its `input_tokens`, `cache_read_tokens` and
 *   `output_tokens`, which both the CLI and Antigravity 2.0 write on a reply's
 *   line and on no other step's. They are held apart from the last step, so
 *   a tool step after the reply keeps the reply's counts.
 *
 * `content`, `thinking`, `media`, `source` and the tool calls themselves are
 * never kept: each line is parsed, those fields and the three counts are
 * read and the rest is dropped at once. A line that does not parse is passed
 * over, since agy can leave one broken when it rewrites the file as it
 * compacts a conversation.
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

/**
 * The most read past the start of the run of steps that say the same, within
 * the tail limit, for the newest reply's counts. A reply's line holds its
 * content and thinking, so it can be longer than a piece.
 */
const LOOK_BACK_BYTES = 256 * 1024;

/** How much of the start is hashed, to notice the file rewritten with more in it than before. */
const HEAD_HASH_BYTES = 4 * 1024;

const NEWLINE = 0x0a;

/** One step as it is kept: what `AntigravityStep` holds, its index, its time and a reply's counts. */
export interface TranscriptStep extends AntigravityStep {
  /** `step_index`. Null when it is not a whole number. */
  index: number | null;
  /** `created_at`, in epoch milliseconds. Null when it is not an ISO 8601 time. */
  at: number | null;
  /**
   * A reply's token counts (`replyCountsOf`): only on a `PLANNER_RESPONSE`
   * step that names any of the three, and null when they could not be right.
   * Left out on every other step, and on a reply that names none of them.
   */
  tokens?: TokenCounts | null;
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
  /**
   * The `step_index` of the last step in the file, passed over or not, so a
   * step written after an approval agy asked for is seen. A step agy cleared
   * or marked invalid does not count, so a conversation it rewound counts
   * from where it went on. Null when none had one.
   */
  lastIndex: number | null;
  /**
   * The token counts of the newest reply that names any, as its line gave
   * them. Null when none was found within the part read, or when that reply's
   * counts could not be right: an older reply's are never taken in their
   * place. A reply agy cleared or marked invalid is passed over.
   */
  tokens: TokenCounts | null;
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

/** A whole number of tokens: zero or more, and small enough to be exact. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The token counts a reply's line gives, through the one check every reader
 * of token counts makes (`tokenCountsOf`). Seen from the Antigravity CLI 1.3.1
 * and Antigravity 2.0 in October 2026, and not promised by either:
 * `input_tokens` is only the part of the prompt that was not read from a
 * cache, so the whole prompt is it and `cache_read_tokens` together, the part
 * read from a cache is `cache_read_tokens`, and the output is `output_tokens`.
 *
 * Undefined when the line names none of the three, which says nothing. A
 * `cache_read_tokens` that is left out counts as 0 and leaves the cached part
 * out. Null when the counts could not be right, such as one that is there but
 * is not a whole number. Nothing is summed across replies.
 */
function replyCountsOf(line: Record<string, unknown>): TokenCounts | null | undefined {
  const { input_tokens: uncached, cache_read_tokens: read, output_tokens: output } = line;
  if (uncached === undefined && read === undefined && output === undefined) return undefined;
  if (!isCount(uncached)) return null;
  if (read !== undefined && !isCount(read)) return null;
  return tokenCountsOf({ input: uncached + (read ?? 0), cached: read, output });
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
  const step: TranscriptStep = {
    index: Number.isSafeInteger(index) && (index as number) >= 0 ? (index as number) : null,
    type,
    status,
    toolCalls: Array.isArray(value.tool_calls) && value.tool_calls.length > 0,
    at: parseStepTime(value.created_at),
  };
  if (type === "PLANNER_RESPONSE") {
    const tokens = replyCountsOf(value);
    if (tokens !== undefined) step.tokens = tokens;
  }
  return step;
}

/** The state of a file with no steps read yet. */
function emptyState(): TranscriptState {
  return {
    firstAt: null,
    last: undefined,
    since: null,
    lastAt: null,
    lastIndex: null,
    tokens: null,
  };
}

/** Whether a step's `step_index` counts as the last: not one agy cleared or marked invalid. */
function countsForIndex(step: TranscriptStep): boolean {
  return step.index !== null && step.status !== "CLEARED" && step.status !== "INVALID";
}

/** Moves the state on by one step, read in the order agy wrote them. */
function addStep(state: TranscriptState, step: TranscriptStep): void {
  if (step.at !== null) state.lastAt = step.at;
  if (countsForIndex(step)) state.lastIndex = step.index;
  if (isAsideStep(step)) return;
  // A newer reply replaces the counts, even with none that could be right.
  if (step.tokens !== undefined) state.tokens = step.tokens;
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
 *
 * On the way it notes the newest reply that names its token counts. When none
 * has been seen by the run's start, the rest of that piece is looked through,
 * then at most 256 KiB more, within the same limit: a file with no counts
 * costs 256 KiB more, not the whole limit.
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
  /** Whether the newest reply that names its counts has been found. */
  let counted = false;
  /** How much more may be read past the run's start, for a reply's counts. */
  let lookBack = LOOK_BACK_BYTES;

  /** Takes one step, newest first. */
  const take = (step: TranscriptStep | null): void => {
    if (step === null) return;
    if (!settled) {
      if (state.lastAt === null && step.at !== null) state.lastAt = step.at;
      if (state.lastIndex === null && countsForIndex(step)) state.lastIndex = step.index;
    }
    if (isAsideStep(step)) return;
    if (!counted && step.tokens !== undefined) {
      state.tokens = step.tokens;
      counted = true;
    }
    // Past the run's start, only a reply's counts are looked for.
    if (settled) return;
    if (state.last === undefined || state.last === null) {
      state.last = step;
      state.since = step.at;
    } else if (openStatusOf(step) !== openStatusOf(state.last)) {
      settled = true;
    } else if (step.at !== null) {
      // The same run goes back further. A step with no time leaves the start as it was.
      state.since = step.at;
    }
  };
  /** Whether nothing older is needed. */
  const done = () => settled && counted;

  while (position > 0 && budget > 0 && !done()) {
    let length = Math.min(TAIL_CHUNK_BYTES, position, budget);
    if (settled) {
      // Past the run's start, only so much more is read for a reply's counts.
      if (lookBack === 0) break;
      length = Math.min(length, lookBack);
      lookBack -= length;
    }
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
        take(readStepLine(buffer.toString("utf8", last + 1)));
      }
    }

    let newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    while (newline !== -1 && !done()) {
      take(readStepLine(buffer.toString("utf8", newline + 1, cut)));
      cut = newline;
      newline = cut > 0 ? buffer.lastIndexOf(NEWLINE, cut - 1) : -1;
    }
    if (done()) break;

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
    lastIndex: cached.lastIndex,
    tokens: cached.tokens,
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
      // It may have grown since the `lstat`: what is read at once stays within the limit.
      if (opened.size - offset > TAIL_LIMIT_BYTES) return null;
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
