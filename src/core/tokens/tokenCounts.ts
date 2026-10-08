import type { TokenCounts } from "../sessions/session.ts";

/**
 * The one check every reader of token counts makes: the Codex adapter on what
 * Codex wrote, the reader of another machine's sessions on what it sent, and
 * the page on what the API sent. Counts that could not be right are no counts:
 * the details show a dash, never a guess.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A whole number of tokens: zero or more, and small enough to be exact. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `input`, `cached` and `output` as `TokenCounts`, or null unless all of them
 * could be right:
 *
 * - `input` is a whole number above 0. A reply is always given a prompt, so 0
 *   is not a count but a reset, such as the line Codex writes after it
 *   compacts a conversation.
 * - `output` is a whole number, 0 or more.
 * - `cached`, when it is there, is a whole number no larger than `input`, of
 *   which it is a part. When it is not there, it is left out.
 *
 * Only these three are copied, whatever else the value holds.
 */
export function tokenCountsOf(value: unknown): TokenCounts | null {
  if (!isRecord(value)) return null;
  const { input, cached, output } = value;
  if (!isCount(input) || input === 0 || !isCount(output)) return null;
  if (cached === undefined) return { input, output };
  if (!isCount(cached) || cached > input) return null;
  return { input, cached, output };
}
