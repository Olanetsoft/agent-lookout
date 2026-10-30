import type { LastMessageResponse } from "../../../../core/api.ts";
import { stepStatusName, stepTypeName } from "../../../../core/mapping/antigravityMapping.ts";
import { messageStart, messageText } from "../../../../core/text.ts";
import type { ReadOnlyIo } from "../../../files/readOnlyIo.ts";
import {
  createTailReader,
  type TailLimits,
  type TailReader,
} from "../../../messages/tailReader.ts";

/**
 * What an Antigravity CLI conversation or an Antigravity 2.0 chat last said,
 * read from the end of its own transcript, the `transcript.jsonl` the adapter
 * already reads, when the route asks for it.
 *
 * The transcript is documented for agy's own agents, but what a step's
 * `content` holds is not. These notes are from a check of shape alone, by
 * field names, types and lengths and never text, made on 30 October 2026 of
 * Antigravity 2.23.1 and agy 1.3.4. None of it is
 * promised:
 *
 * - A step's `content` was always a JSON string, never a list of parts.
 * - A `PLANNER_RESPONSE` that only calls tools had no `content` at all. A reply with no tool calls had a string with something
 *   on it.
 * - `truncated_fields` can name `content`: one reply of Antigravity 2.23.1
 *   had its `content` cut to about 4 KB in `transcript.jsonl`. Such a reply is shown
 *   as its start, with its end said to be left out.
 * - The step types seen were `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` (a
 *   tool's output) and `SYSTEM_MESSAGE`.
 * - No chat had a parent or a nesting depth above 0 in
 *   `conversation_summaries.db`, so no subagent's folder was
 *   seen.
 *
 * So the text is the `content` of the newest `PLANNER_RESPONSE` whose
 * `content` is a string with something on it. A reply agy cleared or marked
 * invalid, as when a conversation is rewound, is passed over, as its token
 * counts are. A prompt (`USER_INPUT`), a tool's output (`GENERIC` and every
 * other tool step), a `SYSTEM_MESSAGE`, `thinking`, `tool_calls`, `media` and
 * the token counts are never taken.
 *
 * Only a line that names `PLANNER_RESPONSE` is parsed, and of those only one
 * whose own `type` is a reply is taken: a reply's line quoted inside a prompt
 * is part of a string there, and is never taken for one. A line that does not
 * parse is read past.
 */

/** The step type of the model's reply, without the prefix agy may write before it. */
const REPLY_TYPE = "PLANNER_RESPONSE";

/** A line that names the reply's step type, in any case: the only lines parsed. */
const REPLY_LINE = new RegExp(REPLY_TYPE, "i");

/** The statuses of a step agy took back, which no longer counts. */
const TAKEN_BACK = new Set(["CLEARED", "INVALID"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a reply said, as it was written, and whether the transcript left its end out. */
export interface ReplySaid {
  text: string;
  /** True when the reply's `truncated_fields` names `content`: the text is its start. */
  endCut: boolean;
}

/** A reply's text and whether its end was cut, or null when the line is not a reply with text. */
function replyOf(piece: string): ReplySaid | null {
  // Not quoted, so that a type written with agy's `CORTEX_STEP_TYPE_` prefix is found too,
  // and in any case, as `stepTypeName` reads it.
  if (!REPLY_LINE.test(piece)) return null;
  let line: unknown;
  try {
    line = JSON.parse(piece);
  } catch {
    return null;
  }
  if (!isRecord(line) || stepTypeName(line.type) !== REPLY_TYPE) return null;
  const status = stepStatusName(line.status);
  if (status !== null && TAKEN_BACK.has(status)) return null;
  const { content } = line;
  // A reply that only calls tools has no `content`, and a list of parts is not one seen.
  if (typeof content !== "string" || content.trim() === "") return null;
  const cut = line.truncated_fields;
  return { text: content, endCut: Array.isArray(cut) && cut.includes("content") };
}

/**
 * The text of a session's newest reply, from the end of its transcript, as it
 * was written, not yet made fit to show, with whether the transcript cut its
 * end. Null when the tail holds no reply with text.
 *
 * `fromStart` says whether the tail is the whole file. When it is not, its
 * first line is a part of a longer one and is not read. A step is one line,
 * so a reply that is read is read whole, as the transcript holds it.
 */
export function lastSaidInTranscript(tail: string, fromStart: boolean): ReplySaid | null {
  const pieces = tail.split("\n");
  const first = fromStart ? 0 : 1;
  for (let index = pieces.length - 1; index >= first; index -= 1) {
    const said = replyOf(pieces[index] ?? "");
    if (said !== null) return said;
  }
  return null;
}

/**
 * The answer the end of a transcript gives, made fit to show. Nothing of the
 * tail is kept. A session's token counts are on the session already, so the
 * answer carries none.
 *
 * A reply whose end the transcript cut is shown as its start: its first 2,000
 * characters, with `cut` false and `endCut` true.
 */
export function answerFrom(tail: string, fromStart: boolean): LastMessageResponse {
  const said = lastSaidInTranscript(tail, fromStart);
  const nothing: LastMessageResponse = {
    message: null,
    reason: fromStart ? "nothing-yet" : "too-far-back",
  };
  if (said === null) return nothing;
  if (said.endCut) {
    const start = messageStart(said.text);
    // Only what cannot be shown.
    if (start === undefined) return nothing;
    return { message: { text: start.text, cut: false, endCut: true } };
  }
  const shown = messageText(said.text);
  if (shown === undefined) return nothing;
  return { message: { text: shown.text, cut: shown.cut } };
}

export interface AntigravityLastMessagesOptions {
  /** Shared with the other agents' readers. Left out, the reader has its own. */
  limits?: TailLimits;
  io?: ReadOnlyIo;
  now?: () => number;
  /** Runs `run` once, `ms` from now. Tests pass their own. */
  later?: (run: () => void, ms: number) => void;
}

/**
 * Reads what an Antigravity CLI conversation or an Antigravity 2.0 chat last
 * said when the route asks for it, and only then: no poll reads it. It is
 * told, after each poll, the sessions listed, by id, each with the transcript
 * it was read from. The limits are those of every reader of last messages
 * (`createTailReader` in `src/collector/messages/tailReader.ts`). What is
 * Antigravity's own:
 *
 * - The file is the session's own `transcript.jsonl`, at the path the
 *   adapter's last poll read it from. It is never `transcript_full.jsonl`,
 *   which holds the whole of a reply the transcript cut, and never another
 *   session's transcript, and nothing in a request names it.
 * - Antigravity 2.0 writes a step to the transcript only once it is done. So
 *   while a chat works, the answer is the reply before the one under way.
 * - A file that has gone is answered `not-found` and opened again at the next
 *   ask after a second. The next poll that does not list the session drops it.
 */
export function createAntigravityLastMessages(
  options: AntigravityLastMessagesOptions = {},
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
