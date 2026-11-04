import type { TokenCounts } from "../../../core/sessions/session.ts";
import { sessionName } from "../../../core/text.ts";
import { tokenCountsOf } from "../../../core/tokens/tokenCounts.ts";

/**
 * The little this adapter keeps of a Vibe session's public state.
 *
 * Vibe calls the whole of it `PublicSessionState`, written in camelCase
 * (harness/.../session_protocol.py at 2.26.1). The same state is in two places:
 * whole, as `snapshot` in the generation's `projection-state.json`, and, as it
 * changes, in a `set_envelope` step of a journal record, with its history left
 * out. It holds the first thing the person asked (`session.preview`), errors in
 * full, the requests waiting for an answer and the queue of turns, and none of
 * that is kept. What is kept:
 *
 * - `session.title`, cleaned and cut as every session's name is;
 * - `session.status.type`;
 * - `session.createdAt` and `session.updatedAt`;
 * - `latestTurn.status`, `latestTurn.startedAt` and `latestTurn.completedAt`;
 * - the token counts of the newest reply, from `session.contextUsage`.
 *
 * Every other key, and any key a newer Vibe adds, is left where it is. So is
 * every value a newer Vibe gives a field this adapter does not read, such as
 * the reasons a turn stopped (`latestTurn.stopReason`).
 */
export interface Envelope {
  /** The session's title, cleaned. Null when it has none yet. */
  title: string | null;
  /** `session.status.type`, as Vibe wrote it, when it is short text. */
  statusType: string | null;
  /** Unix milliseconds, as Vibe writes them. Whether each could be right is decided where the clock is known. */
  createdAt: number | null;
  updatedAt: number | null;
  /** `latestTurn.status`: `in_progress`, `completed`, `failed` or `interrupted`. Null with no turn. */
  turnStatus: string | null;
  turnStartedAt: number | null;
  turnCompletedAt: number | null;
  /** The newest reply's token counts. Null when the state has no turn, or none that could be right. */
  tokens: TokenCounts | null;
}

/** The only format of public state this adapter knows. */
export const PUBLIC_STATE_FORMAT = "harness.public-session-state/v1";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short word, such as a status. Anything longer is not one. */
function word(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= 64 ? value : null;
}

/** A whole number of milliseconds. */
function milliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/**
 * The newest reply's token counts from `session.contextUsage`, through the one
 * check every reader of token counts makes (`tokenCountsOf`), or null when they
 * could not be right.
 *
 * Vibe sets it to the usage of each reply it commits, with `inputTokens`,
 * `outputTokens`, `totalTokens` and `cachedInputTokens` (`SessionProjector.apply`
 * in harness/.../vibe/_projection.py, from 2.26.0 to 3.0.4). `session.tokenUsage`
 * beside it adds every reply up, so it is never read. So:
 *
 * - input is `inputTokens`, the whole prompt, which Vibe makes the cached part
 *   included for every provider;
 * - cached is `cachedInputTokens`, left out when it is 0: Vibe writes 0 for a
 *   provider that sent no cached count, and the state cannot tell that from a
 *   cache that held none;
 * - output is `outputTokens`.
 *
 * `totalTokens` is read only to check them: Vibe refuses a usage whose total is
 * not those two together (`validate_token_usage` in its core). The field is null
 * before the first reply, and every count in it is 0 after a compaction until the
 * next reply reports, which gives no counts. A rewind leaves it as it was, which
 * `envelopeOf` answers.
 */
function replyTokensOf(usage: unknown): TokenCounts | null {
  if (!isRecord(usage)) return null;
  const { inputTokens, cachedInputTokens, outputTokens, totalTokens } = usage;
  const counts = tokenCountsOf({
    input: inputTokens,
    cached: cachedInputTokens === 0 ? undefined : cachedInputTokens,
    output: outputTokens,
  });
  if (counts === null || !Number.isSafeInteger(totalTokens)) return null;
  return totalTokens === counts.input + counts.output ? counts : null;
}

/**
 * The kept fields of a public state, or null when it is not one: not an
 * object, of another format, or with no `session` object.
 *
 * A state with no turn has no token counts, whatever `session.contextUsage`
 * holds. A rewind in place cuts the history and sets `latestTurn` to null, the
 * only code that does, but leaves the usage of a reply that may be gone (`rewind`
 * in harness/.../vibe/_host.py, at 2.26.1 and 3.0.4). Once the next turn starts,
 * its state has a turn and the old usage, which nothing tells from a state whose
 * counts still stand.
 */
export function envelopeOf(state: unknown): Envelope | null {
  if (!isRecord(state)) return null;
  if (state.format !== undefined && state.format !== PUBLIC_STATE_FORMAT) return null;
  const session = state.session;
  if (!isRecord(session)) return null;
  const status = isRecord(session.status) ? session.status : null;
  const turn = isRecord(state.latestTurn) ? state.latestTurn : null;
  return {
    title: typeof session.title === "string" ? (sessionName(session.title) ?? null) : null,
    statusType: word(status?.type),
    createdAt: milliseconds(session.createdAt),
    updatedAt: milliseconds(session.updatedAt),
    turnStatus: word(turn?.status),
    turnStartedAt: milliseconds(turn?.startedAt),
    turnCompletedAt: milliseconds(turn?.completedAt),
    tokens: turn === null ? null : replyTokensOf(session.contextUsage),
  };
}
