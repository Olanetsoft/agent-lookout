import { createHash } from "node:crypto";
import path from "node:path";

import type { LastMessageResponse } from "../../../../core/api.ts";
import { messageText } from "../../../../core/text.ts";
import { nodeIo, type ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import {
  readTranscriptTail,
  TRANSCRIPT_TAIL_BYTES,
  type TailRead,
  type TranscriptStamp,
} from "../../../files/transcriptTail.ts";
import { createEndReader, type TailLimits, type TailReader } from "../../../messages/tailReader.ts";
import type { HistoryChunks } from "../stores.ts";
import {
  entryOf,
  historySteps,
  newestReply,
  replay,
  type Entry,
  type ReplyFound,
  type Step,
} from "./replies.ts";

/**
 * What a Mistral Vibe session last said, read from the end of its journal
 * segment and, when that holds no reply, from the newest pieces of the history
 * its generation saved, when the route asks for it, and never by a poll.
 *
 * These notes are from Vibe's source at 3.1.4, not yet checked on a computer
 * running it. `harness/…/vibe/` stands for
 * `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/`, and
 * each line number is one at 3.1.4.
 *
 * - When Vibe saves a session whole, as it does once a turn ends with nothing
 *   left running, it keeps the history out of `projection-state.json` and in
 *   pieces in the store's `chunks/`, which the manifest names in order as
 *   `projection_state.chunks` (`write_generation`, from
 *   `harness/…/vibe/_storage.py:2822`, and `_detach_projection_history`,
 *   `:6031`). A new journal segment starts empty. So a session that has
 *   finished its turn has its newest reply in the pieces, and one in a turn
 *   has it in the journal, from the steps of its `projection_delta` records
 *   (`replies.ts`).
 * - A piece is `chunks/<sha256>.json`: a JSON array of entries and a newline,
 *   named for the SHA-256 of the array without the newline, which Vibe checks
 *   as it reads one (`_ChunkCache.read`, `_read_document_body` and
 *   `_write_pooled_chunk`, `_storage.py:2759`, `:6346` and `:6145`). Vibe
 *   closes a piece once it holds 64 KiB, and adds to the open one at the end
 *   (`_CHUNK_TARGET_BYTES`, `_storage.py:141`, and `_split_chunks`, `:6091`). The same
 *   folder holds the pieces of `checkpoint.json` and of the runtime state,
 *   which the manifest names apart.
 * - Vibe's own reader of a session's newest entries reads only the newest
 *   pieces it needs, and reads the whole session instead whenever the journal
 *   holds anything (`read_projection_tail`, `_storage.py:3099`).
 */

/** Where a session's history is, from what the adapter read for it on its last poll, never from a request. */
export interface VibeReplyTarget {
  /** The journal segment the session's generation names. */
  journal: string;
  /** The generation, which each save moves on. Its files, and the pieces it names, never change. */
  generation: string;
  /** The store's `chunks/`. */
  chunksDir: string;
  /** The newest pieces of the history the generation's manifest names, or null when it names none. */
  history: HistoryChunks | null;
}

/**
 * The answer what the history gave makes, fit to show. Nothing else of the
 * history is kept, and the answer carries no token counts: a Vibe session's
 * are on the session already, read by the poll (`envelope.ts`).
 */
export function answerFrom(found: ReplyFound): LastMessageResponse {
  const shown = messageText(found.text);
  // Nothing said, or only what cannot be shown.
  if (shown === undefined) {
    return { message: null, reason: found.before ? "too-far-back" : "nothing-yet" };
  }
  return { message: { text: shown.text, cut: shown.cut } };
}

const NEWLINE = 0x0a;

/**
 * One piece of the history, read whole when it is no more than `room` bytes,
 * or null, with nothing read, when it is more. Rejects for a piece that is not
 * there, with the error that says so, and for one that is not a piece Vibe
 * wrote under that name: no newline at its end, a body whose SHA-256 is not
 * its name, or a body that is not a JSON array. A link is not followed.
 */
async function readPiece(
  io: ReadOnlyIo,
  chunksDir: string,
  name: string,
  room: number,
): Promise<{ entries: Entry[]; bytes: number } | null> {
  const handle = await io.openRegular(path.join(chunksDir, `${name}.json`));
  try {
    const { size } = handle.info;
    if (size > room) return null;
    const read = await handle.read(0, size);
    if (read.byteLength !== size) throw new Error("The piece changed while it was read.");
    const data = Buffer.from(read.buffer, read.byteOffset, read.byteLength);
    if (data[data.byteLength - 1] !== NEWLINE) throw new Error("The piece does not end a line.");
    const body = data.subarray(0, data.byteLength - 1);
    if (createHash("sha256").update(body).digest("hex") !== name) {
      throw new Error("The piece is not the one its name says.");
    }
    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("The piece is not JSON.");
    }
    if (!Array.isArray(value)) throw new Error("The piece is not a run of the history.");
    return { entries: value.map(entryOf), bytes: size };
  } finally {
    await handle.close();
  }
}

/**
 * The newest reply the history holds, from the journal's steps alone when they
 * hold one, else over the pieces of the history read from the newest back,
 * while what is read of the journal and the pieces together stays within
 * 256 KB. The pieces are read only when the whole journal was read: the steps
 * of a journal whose start was not read follow a history that is not known.
 */
async function replyIn(
  io: ReadOnlyIo,
  steps: readonly Step[],
  journalBytes: number,
  fromStart: boolean,
  target: VibeReplyTarget,
): Promise<ReplyFound> {
  const { history } = target;
  // A whole journal over a history the manifest says is empty is the whole history.
  const empty = fromStart && history !== null && history.newest.length === 0 && !history.older;
  const alone = newestReply(replay({ entries: [], before: !empty }, steps));
  if (alone.text !== null || !alone.before || !fromStart || history === null) return alone;

  const folder = await io.lstat(target.chunksDir);
  if (folder.kind !== "directory") throw new Error("The store's chunks/ is not a folder.");
  let room = TRANSCRIPT_TAIL_BYTES - journalBytes;
  const runs: Entry[][] = [];
  for (let index = history.newest.length - 1; index >= 0; index -= 1) {
    const piece = await readPiece(io, target.chunksDir, history.newest[index] ?? "", room);
    if (piece === null) break;
    room -= piece.bytes;
    runs.unshift(piece.entries);
    const before = index > 0 || history.older;
    const found = newestReply(replay({ entries: runs.flat(), before }, steps));
    if (found.text !== null || !found.before) return found;
  }
  return { text: null, before: true };
}

export interface MistralVibeLastMessagesOptions {
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  io?: ReadOnlyIo;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what a Mistral Vibe session last said when the route asks for it, and
 * only then: no poll reads it. It is told, after each poll, the sessions
 * listed, by id, each with where its history is, or none. The limits are
 * those of every reader of last messages (`createEndReader` in
 * `src/collector/messages/tailReader.ts`), with one ask counted as one read.
 * What is Vibe's own:
 *
 * - The journal is the segment the session's generation names, as the last
 *   poll found it, and its last 256 KB are read, by position, and not again
 *   while it is unchanged. The generation's pieces never change, so neither
 *   does the answer.
 * - When the journal holds no reply, and was read whole, the newest pieces of
 *   the history the manifest names are read from the newest back, each whole,
 *   only while it fits in what is left of the same 256 KB, until one holds a
 *   reply that stands. A piece is opened only by a name the manifest gives in
 *   `projection_state.chunks`, 64 hexadecimal digits, in the store's own
 *   `chunks/`, and read only when it hashes to that name. No other file there,
 *   no piece of the checkpoint or the runtime state, and nothing a request
 *   names is opened.
 * - A session with no journal named is answered `not-found`, and nothing is
 *   opened. A journal or a piece that has gone is answered `not-found` too, and
 *   one that cannot be read, or a piece that is not the one its name says,
 *   `unreadable`. A poll that names a new generation drops what was kept.
 */
export function createMistralVibeLastMessages(
  options: MistralVibeLastMessagesOptions = {},
): TailReader<VibeReplyTarget> {
  const io = options.io ?? nodeIo;
  return createEndReader<VibeReplyTarget, TranscriptStamp, ReplyFound>({
    find: (target) => Promise.resolve(target.journal),
    keyOf: (target) => `${target.generation} ${target.journal}`,
    async readEnd(file, known, target): Promise<TailRead<TranscriptStamp, ReplyFound>> {
      const read = await readTranscriptTail(file, io, known);
      if (read.unchanged) return read;
      const steps = historySteps(read.tail, read.fromStart);
      const journalBytes = read.fromStart ? read.stamp.size : TRANSCRIPT_TAIL_BYTES;
      const found = await replyIn(io, steps, journalBytes, read.fromStart, target);
      return { unchanged: false, stamp: read.stamp, tail: found, fromStart: read.fromStart };
    },
    answerFrom: (found) => answerFrom(found),
    limits: options.limits,
    now: options.now,
    later: options.later,
  });
}
