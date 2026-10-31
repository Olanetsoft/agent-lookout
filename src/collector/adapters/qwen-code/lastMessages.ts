import type { LastMessageResponse } from "../../../core/api.ts";
import { messageText } from "../../../core/text.ts";
import type { ReadOnlyIo } from "../../files/readOnlyIo.ts";
import { createTailReader, type TailLimits, type TailReader } from "../../messages/tailReader.ts";

/**
 * What a Qwen Code session last said, read from the end of its own chat file,
 * the one the adapter already reads for its status, when the route asks for
 * it.
 *
 * The chat file is JSON Lines, written by `chatRecordingService.ts`. These
 * notes are from Qwen Code's source at v0.25.1, not yet checked on a machine
 * running it:
 *
 * - The model's reply is an `assistant` line, its `message` the reply as the
 *   model gave it: a `role` of `model` and a list of `parts`.
 * - A part with `text` is what the reply says, unless it is marked
 *   `thought: true`, which is the model's thinking. A part with a
 *   `functionCall` calls a tool, and says nothing.
 * - A line a subagent wrote into the file is marked `isSidechain: true`.
 * - Prompts are `user` lines, tools' results `tool_result` lines, and
 *   everything else Qwen Code records `system` lines.
 *
 * So the text is that of the newest `assistant` line of the session's own,
 * with no subtype, whose parts hold text that is not a thought: those parts'
 * text, joined with nothing between, as the model's parts make one answer. A
 * reply that only calls tools, or only thinks, is passed over for the one
 * before it. A prompt, a thought, a tool's call, a tool's output, a system
 * line and a subagent's line are never taken. An `assistant` line with a
 * subtype is passed over, as the status passes it over (`qwenCodeMapping.ts`).
 *
 * Only a line that names `"assistant"` is parsed, and of those only one whose
 * own `type` is `assistant` is taken: a reply's line quoted inside a prompt is
 * part of a string there, and is never taken for one. A line that does not
 * parse is read past.
 */

/** What goes between the text parts of one reply: nothing, as they make one answer. */
const PART_BREAK = "";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The reply's text, from its parts that are text and not a thought, or null when they hold none. */
function replyTextOf(message: Record<string, unknown>): string | null {
  if (!Array.isArray(message.parts)) return null;
  const texts: string[] = [];
  for (const part of message.parts) {
    if (isRecord(part) && typeof part.text === "string" && part.thought !== true) {
      texts.push(part.text);
    }
  }
  const text = texts.join(PART_BREAK);
  return text.trim() === "" ? null : text;
}

/** The text of a line's reply, or null when the line is not the session's own reply with text. */
function replyOf(piece: string): string | null {
  if (!piece.includes('"assistant"')) return null;
  let line: unknown;
  try {
    line = JSON.parse(piece);
  } catch {
    return null;
  }
  if (!isRecord(line) || line.type !== "assistant") return null;
  // A subagent's line, or one the status passes over.
  if (line.isSidechain === true || typeof line.subtype === "string") return null;
  return isRecord(line.message) ? replyTextOf(line.message) : null;
}

/**
 * The text of a Qwen Code session's newest reply, from the end of its chat
 * file, as it was written, not yet made fit to show. Null when the tail holds
 * no reply with text.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read. A reply is one line,
 * so a reply that is read is read whole.
 */
export function lastSaidInChat(tail: string, fromStart: boolean): string | null {
  const pieces = tail.split("\n");
  const first = fromStart ? 0 : 1;
  for (let index = pieces.length - 1; index >= first; index -= 1) {
    const text = replyOf(pieces[index] ?? "");
    if (text !== null) return text;
  }
  return null;
}

/**
 * The answer the end of a chat file gives, made fit to show. Nothing of the
 * tail is kept, and the answer carries no token counts, which Agent Lookout
 * does not read for Qwen Code.
 */
export function answerFrom(tail: string, fromStart: boolean): LastMessageResponse {
  const shown = messageText(lastSaidInChat(tail, fromStart));
  // Nothing said, or only what cannot be shown.
  if (shown === undefined) {
    return { message: null, reason: fromStart ? "nothing-yet" : "too-far-back" };
  }
  return { message: { text: shown.text, cut: shown.cut } };
}

export interface QwenCodeLastMessagesOptions {
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  io?: ReadOnlyIo;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what a Qwen Code session last said when the route asks for it, and
 * only then: no poll reads it. It is told, after each poll, the sessions
 * listed, by id, each with the chat file the adapter found for it, or none.
 * The limits are those of every reader of last messages (`createTailReader`
 * in `src/collector/messages/tailReader.ts`). What is Qwen Code's own:
 *
 * - The file is the session's own chat file,
 *   `<runtime>/projects/<folder>/chats/<id>.jsonl`, at the path the adapter
 *   last found it: for an open session, the last poll; for one shown as
 *   finished, the last poll that found it open, or, for a record a crash left
 *   behind, the file in the folder named for its folder. It is never a file
 *   beside it, nor another session's, and nothing in a request names it.
 * - A session with no chat file is answered `not-found`, and no file is
 *   opened. A file that has gone is answered `not-found` too, and opened
 *   again at the next ask after a second. The next poll that does not list
 *   the session drops it.
 */
export function createQwenCodeLastMessages(
  options: QwenCodeLastMessagesOptions = {},
): TailReader<string> {
  return createTailReader<string>({
    // The target is the file itself, as the adapter last found it.
    find: (file) => Promise.resolve(file),
    keyOf: (file) => file,
    answerFrom,
    limits: options.limits,
    io: options.io,
    now: options.now,
    later: options.later,
  });
}
