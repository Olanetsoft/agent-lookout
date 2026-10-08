import type { TokenCounts } from "../../../../core/sessions/session.ts";
import { tokenCountsOf } from "../../../../core/tokens/tokenCounts.ts";
import { isRecord } from "./transcriptLines.ts";

/**
 * The token counts of a Claude Code session's newest reply, worked out from
 * the end of its transcript. Pure: the bytes are the ones read for what the
 * session last said (`lastMessages.ts`), and nothing more is read for these.
 *
 * The transcript is undocumented, and `lastAsk.ts` has the notes on its
 * format. These notes on the counts are from Claude Code 2.1.219, 2.1.289 and
 * 2.1.293, and none of them is promised:
 *
 * - Each block of an assistant reply is a line of its own, and every line of
 *   one reply carries the reply's `message.usage`, with the same numbers on
 *   each. So the newest line's numbers are the reply's, and nothing is summed.
 * - `usage.input_tokens` is only the part of the prompt that was neither read
 *   from a cache nor written to one. The whole prompt is that,
 *   `cache_creation_input_tokens` and `cache_read_input_tokens` together, and
 *   the part read from a cache is `cache_read_input_tokens`.
 *   `output_tokens` includes the model's thinking.
 *
 * The line read is the newest assistant line of the session's own: not a
 * subagent's (`isSidechain: true`), not one Claude Code writes itself under
 * the model `<synthetic>`, and not an error of the API's
 * (`isApiErrorMessage: true`). Only a line that names both `"assistant"` and
 * `"usage"`, or names `"isCompactSummary"`, is parsed, and of those only an
 * assistant line is taken, so a prompt or a reply that quotes such a line is
 * never taken for one. A line that does not parse is read past, and so is an
 * assistant line with no `message.usage`, which no version above was seen to
 * write.
 *
 * When Claude Code compacts the conversation, it writes the summary as a user
 * line marked `isCompactSummary: true`. A reply before that line was given a
 * context that is no longer in use, so once it is met before a reply there
 * are no counts until the next reply.
 *
 * When that line's counts could not be right there are none, and an older
 * reply's are never taken in their place. A cache count that is left out
 * counts as 0 in the input, and a `cache_read_input_tokens` that is left out
 * leaves the cached part out too. One that is there but is not a whole number
 * means none of the counts are believed.
 *
 * Only the four counts are taken from `usage`: nothing nested in it, not its
 * service tier, and nothing else on the line, such as a `costUSD`.
 */

/** What a line must name to be parsed: an assistant line that carries a usage, or a compacted summary. */
const ASSISTANT_HINT = '"assistant"';
const USAGE_HINT = '"usage"';
const COMPACT_HINT = '"isCompactSummary"';

/** The model Claude Code names on an assistant line it wrote itself, which no model wrote. */
const SYNTHETIC_MODEL = "<synthetic>";

/** A whole number of tokens: zero or more, and small enough to be exact. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A line of the tail as an object, or null when it does not parse as one. */
function parsed(piece: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(piece);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Whether a line is a reply of the session's own model: not a subagent's, nor one Claude Code wrote itself. */
function isOwnReply(line: Record<string, unknown>): boolean {
  if (line.type !== "assistant" || line.isSidechain === true || line.isApiErrorMessage === true) {
    return false;
  }
  return !(isRecord(line.message) && line.message.model === SYNTHETIC_MODEL);
}

/** Whether a line is the summary Claude Code writes in place of the conversation when it compacts it. */
function isCompaction(line: Record<string, unknown>): boolean {
  return line.type === "user" && line.isCompactSummary === true && line.isSidechain !== true;
}

/**
 * The counts a `message.usage` gives, through the one check every reader of
 * token counts makes (`tokenCountsOf`), or null when they could not be right.
 */
function countsOf(usage: unknown): TokenCounts | null {
  if (!isRecord(usage)) return null;
  const uncached = usage.input_tokens;
  const written = usage.cache_creation_input_tokens;
  const read = usage.cache_read_input_tokens;
  if (!isCount(uncached)) return null;
  if (written !== undefined && !isCount(written)) return null;
  if (read !== undefined && !isCount(read)) return null;
  return tokenCountsOf({
    input: uncached + (written ?? 0) + (read ?? 0),
    cached: read,
    output: usage.output_tokens,
  });
}

/**
 * The token counts of the session's newest reply, from the end of its
 * transcript, or null when there are none that could be right.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read.
 */
export function lastUsageInTail(tail: string, fromStart: boolean): TokenCounts | null {
  const pieces = tail.split("\n");
  const first = fromStart ? 0 : 1;
  for (let index = pieces.length - 1; index >= first; index -= 1) {
    const piece = pieces[index] ?? "";
    const named =
      piece.includes(COMPACT_HINT) ||
      (piece.includes(ASSISTANT_HINT) && piece.includes(USAGE_HINT));
    if (!named) continue;
    const line = parsed(piece);
    if (line === null) continue;
    // Compacted since the newest reply: its counts are of a context no longer in use.
    if (isCompaction(line)) return null;
    if (!isOwnReply(line) || !isRecord(line.message) || line.message.usage === undefined) continue;
    return countsOf(line.message.usage);
  }
  return null;
}
