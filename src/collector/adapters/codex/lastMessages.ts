import type { LastMessageResponse } from "../../../core/api.ts";
import { messageText } from "../../../core/text.ts";
import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { createTailReader, type TailLimits, type TailReader } from "../../messages/tailReader.ts";

/**
 * What a Codex session last said, read from the end of its own session file,
 * the rollout the adapter already reads, when the route asks for it.
 *
 * The rollout is undocumented. These notes are from Codex 0.160.0, and none of
 * them is promised:
 *
 * - Each reply of the model is written twice: as an `event_msg` whose
 *   `payload.type` is `agent_message`, with the text in `payload.message`,
 *   and as a `response_item` whose payload is a `message` of `role`
 *   `assistant`, with the text in its `output_text` parts.
 * - The `agent_message` is written just before the `response_item`. Its text
 *   is the `output_text` parts joined with nothing between, with the markup
 *   Codex hides taken out.
 * - A turn that ends writes `task_complete`, whose `last_agent_message` is
 *   a third copy of the turn's newest reply.
 * - `agent_message` has a `phase`, which was null on every one seen, so a
 *   note written while working cannot be told from a final answer. The last
 *   message is the newest reply, whichever it is.
 *
 * So the text is the newest reply's: its `agent_message` when the tail holds
 * it, and otherwise the `output_text` parts of its assistant `response_item`,
 * joined as Codex joins them. With a reply's two lines in the order 0.160.0
 * writes them, nothing older than the newest reply is taken in its place. In
 * the other order, that holds only when an older reply's two copies are the
 * same text: one with markup taken out cannot be told from the newest
 * reply's own. `task_complete`'s copy is taken only when it is the one place
 * in the tail the newest reply is. A user message, the model's reasoning, a
 * tool's call and its output are never taken.
 *
 * Only a line that names `"event_msg"` or `"response_item"` is parsed, and of
 * those only one whose own `type` and `payload` say what it is is taken: a
 * line quoted inside a prompt or a reply is part of a string there, and is
 * never taken for one. A line that does not parse is read past.
 */

/** What goes between the `output_text` parts of one reply: nothing, as Codex joins them. */
const PART_BREAK = "";

/** What one line of a rollout is, for what its session last said. */
type LineKind =
  /** An `agent_message` with text: the newest reply, as the session's own event says it. */
  | { kind: "said"; text: string }
  /** An assistant `response_item` message with text: the same reply, as the model's output. */
  | { kind: "reply"; text: string }
  /** A `task_complete` with a `last_agent_message`: the turn's newest reply, copied. */
  | { kind: "complete"; text: string }
  /**
   * Any other item of the conversation, which a reply's two copies are not
   * split by. `turnEdge` is true for a line that, read backwards, is past the
   * start of the turn after it: a prompt, a turn's start, or an earlier
   * turn's end.
   */
  | { kind: "apart"; turnEdge: boolean }
  /** Anything else, such as a token count: read past. */
  | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value when it is text with anything on it, and null otherwise. */
function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The `output_text` parts of an assistant message, joined, when they have anything in them. */
function outputTextOf(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  for (const part of payload.content) {
    if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return nonEmpty(parts.join(PART_BREAK));
}

/** What a line is, from its own `type` and `payload`, or null when it says nothing here. */
function kindOf(piece: string): LineKind {
  const named = piece.includes('"event_msg"') || piece.includes('"response_item"');
  if (!named) return null;
  let line: unknown;
  try {
    line = JSON.parse(piece);
  } catch {
    return null;
  }
  if (!isRecord(line) || !isRecord(line.payload)) return null;
  const payload = line.payload;
  if (line.type === "response_item") {
    if (payload.type === "message" && payload.role === "assistant") {
      const text = outputTextOf(payload);
      if (text !== null) return { kind: "reply", text };
    }
    // A prompt, the model's reasoning, a tool's call or its output, or a reply with nothing in it.
    return { kind: "apart", turnEdge: payload.type === "message" && payload.role === "user" };
  }
  if (line.type !== "event_msg") return null;
  switch (payload.type) {
    case "agent_message": {
      const text = nonEmpty(payload.message);
      return text === null ? null : { kind: "said", text };
    }
    case "task_complete":
    case "turn_complete": {
      const text = nonEmpty(payload.last_agent_message);
      return text === null ? { kind: "apart", turnEdge: true } : { kind: "complete", text };
    }
    case "user_message":
    case "task_started":
    case "turn_started":
    case "turn_aborted":
      return { kind: "apart", turnEdge: true };
    default:
      return null;
  }
}

/**
 * Whether the `agent_message` at `index` is the second copy of the reply just
 * before it, which would make it older than a reply after it: true when the
 * next line back that says anything is a reply with the same text. A copy
 * with markup taken out is not the same text, and is not seen as one.
 */
function copiesReplyBefore(pieces: string[], index: number, first: number, text: string): boolean {
  for (let earlier = index - 1; earlier >= first; earlier -= 1) {
    const line = kindOf(pieces[earlier] ?? "");
    if (line === null) continue;
    return line.kind === "reply" && line.text === text;
  }
  return false;
}

/**
 * The text of a Codex session's newest reply, from the end of its rollout, as
 * it was written, not yet made fit to show. Null when the tail holds no reply.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read. A reply is one line,
 * so a reply that is read is read whole.
 */
export function lastSaidInRollout(tail: string, fromStart: boolean): string | null {
  const pieces = tail.split("\n");
  const first = fromStart ? 0 : 1;
  /** The newest reply's `response_item`, while its `agent_message` may lie just before it. */
  let reply: string | null = null;
  /** The newest turn's `task_complete` copy, while the reply it copies may lie further back in that turn. */
  let complete: string | null = null;
  for (let index = pieces.length - 1; index >= first; index -= 1) {
    const line = kindOf(pieces[index] ?? "");
    if (line === null) continue;
    if (line.kind === "said") {
      // The newest reply's own event, or the other copy of the reply just after
      // it, unless it is the copy of a reply before it, which is older.
      if (reply === null || line.text === reply) return line.text;
      return copiesReplyBefore(pieces, index, first, line.text) ? reply : line.text;
    }
    // Anything else before the newest reply's `response_item` is older than that reply.
    if (reply !== null) return reply;
    if (line.kind === "reply") {
      reply = line.text;
    } else if (complete !== null && (line.kind === "complete" || line.turnEdge)) {
      // The turn the copy ends began after this line, and none of its replies is in the tail.
      return complete;
    } else if (line.kind === "complete") {
      complete = line.text;
    }
  }
  return reply ?? complete;
}

/**
 * The answer the end of a rollout gives, made fit to show. Nothing of the
 * tail is kept. A Codex session's token counts are on the session already, so
 * the answer carries none.
 */
function answerFrom(tail: string, fromStart: boolean): LastMessageResponse {
  const shown = messageText(lastSaidInRollout(tail, fromStart));
  // Nothing said, or only what cannot be shown.
  if (shown === undefined) {
    return { message: null, reason: fromStart ? "nothing-yet" : "too-far-back" };
  }
  return { message: { text: shown.text, cut: shown.cut } };
}

export interface CodexLastMessagesOptions {
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  io?: ReadOnlyIo;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what a Codex session last said when the route asks for it, and only
 * then: no poll reads it. It is told, after each poll, the sessions listed,
 * by id, each with the rollout it was read from. The limits are those of
 * every reader of last messages (`createTailReader` in
 * `src/collector/messages/tailReader.ts`). What is Codex's own:
 *
 * - The file is the rollout the adapter read the session from on its last
 *   poll: the one written to last, for a reverted session that has two. It
 *   is never a subagent's, which the adapter does not list, and nothing in a
 *   request names it.
 * - A file that has gone is answered `not-found` and opened again at the next
 *   ask after a second. The next poll that does not list the session drops it.
 */
export function createCodexLastMessages(
  options: CodexLastMessagesOptions = {},
): TailReader<string> {
  return createTailReader<string>({
    // The target is the file itself, as the adapter's last poll read it.
    find: (file) => Promise.resolve(file),
    keyOf: (file) => file,
    answerFrom,
    limits: options.limits,
    io: options.io,
    now: options.now,
    later: options.later,
  });
}
